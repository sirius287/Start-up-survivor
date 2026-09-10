require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { pool, initDb, withTransaction } = require('./db');
const { issueSession, requireAuth, requireRole } = require('./middleware/auth');
const { initialState, attractivenessFor, allocateSharedPool, applyTick } = require('./services/market');
const { CATALOG, POWERS, getCatalogShock, randomPower, serialize } = require('./services/shocks');
const { QUALITY_ATTRIBUTES, compositeQuality } = require('./services/quality');
const { marketState, team } = require('./services/state');
const { findActiveJudgeByCode, actingJudgeId } = require('./services/judges');
const docs = require('./services/docs');
const { logEvent, serializeLogRow } = require('./services/eventLog');
const judging = require('./services/judging');

const app = express();
// Behind Vercel's edge proxy (and any reverse proxy), trust the first hop so
// express-rate-limit reads the real client IP from X-Forwarded-For instead of
// throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set('trust proxy', 1);
// The React build is the only frontend. If it is missing we say so loudly at
// boot rather than silently serving nothing — a missing build should never be
// something you discover from a blank page during the event.
const frontend = path.join(__dirname, '..', 'client', 'dist');
try {
  require('fs').accessSync(path.join(frontend, 'index.html'));
} catch {
  console.warn('⚠️  client/dist is missing — run `npm run build:client`. API will work; the UI will 404.');
}
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
// IMPORTANT: at a live event every team is behind ONE venue WiFi NAT, so they
// all share a public IP. A 10/min per-IP limit meant team #11 onwards got
// locked out of registration — found in the 40-team rehearsal. The default is
// now venue-safe; lower it via AUTH_RATE_LIMIT only if you are internet-facing
// with untrusted traffic.
const AUTH_RATE_LIMIT = Math.max(1, Number.parseInt(process.env.AUTH_RATE_LIMIT || '300', 10) || 300);
const authLimiter = rateLimit({ windowMs: 60 * 1000, limit: AUTH_RATE_LIMIT, standardHeaders: true, legacyHeaders: false });
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });
const validSegments = ['mass', 'premium', 'niche'];
const idOf = value => Number.parseInt(value, 10);

async function getGame(client = pool) { const { rows } = await client.query('SELECT * FROM game_state WHERE id=1'); return rows[0]; }
async function expireShocks(client = pool) { await client.query("UPDATE shocks SET resolved=true WHERE resolved=false AND expires_at <= NOW()"); await client.query("UPDATE shock_history SET resolved_at=NOW() WHERE resolved_at IS NULL AND instance_id IN (SELECT instance_id FROM shocks WHERE resolved=true)"); }
async function getActiveShocks(client = pool, teamId = null) { await expireShocks(client); const params = teamId ? [teamId] : []; const query = teamId ? 'SELECT * FROM shocks WHERE resolved=false AND expires_at > NOW() AND (target_team_id IS NULL OR target_team_id=$1) ORDER BY deployed_at DESC' : 'SELECT * FROM shocks WHERE resolved=false AND expires_at > NOW() ORDER BY deployed_at DESC'; const { rows } = await client.query(query, params); return rows.map(serialize); }
async function getTrack(id, client = pool) { const { rows } = await client.query('SELECT * FROM tracks WHERE id=$1', [id]); return rows[0]; }
async function getActiveTracks(client = pool) { return (await client.query('SELECT * FROM tracks WHERE is_active=true ORDER BY id')).rows; }

const isStaffRole = role => role === 'admin' || role === 'judge';

/* ---------------------------- Deadlines ----------------------------
   Every tick window has three deadlines, not one, so judges get a
   protected review window instead of racing the same clock as teams:
     submit (60%) → review (90%) → tick fires (100% of tick_minutes).
   All three are recomputed together whenever a window opens (game start,
   tick completion, round advance) and are exposed in the snapshot so the
   team, staff and logs panels can all count down against the same clock. */
// A 45-minute tick splits: 27 min to submit -> 8 min review -> 10 min buffer
// -> tick fires. The buffer is a fix-it gap: submissions are frozen, judges
// can still finish, and if anything is wrong there is room to correct it
// before the market runs.
const SET_DEADLINES_SQL = `
  tick_deadline = NOW() + (tick_minutes || ' minutes')::interval,
  submission_deadline = NOW() + (GREATEST(tick_minutes - grading_minutes, 1) || ' minutes')::interval,
  grading_deadline = NOW() + (tick_minutes || ' minutes')::interval,
  review_deadline = NOW() + (GREATEST(tick_minutes - buffer_minutes, 2) || ' minutes')::interval`;

function deadlinesOf(game) {
  const ms = value => (value ? new Date(value).getTime() : null);
  return {
    submissionDeadline: ms(game.submission_deadline),
    reviewDeadline: ms(game.review_deadline),
    tickDeadline: ms(game.tick_deadline),
    submissionsOpen: Boolean(game.submission_deadline) && new Date(game.submission_deadline) > new Date(),
    bufferMinutes: game.buffer_minutes,
    gradingMinutes: game.grading_minutes,
    gradingDeadline: game.grading_deadline ? new Date(game.grading_deadline).getTime() : null,
    publishedThroughTick: game.published_through_tick,
    inBuffer: Boolean(game.review_deadline) && new Date(game.review_deadline) <= new Date()
              && Boolean(game.tick_deadline) && new Date(game.tick_deadline) > new Date(),
    serverNow: Date.now(), // clients count down against server time, never their own clock
  };
}

async function loadSnapshot(user) {
  await expireShocks();
  const game = await getGame();
  const teamsResult = await pool.query('SELECT * FROM teams WHERE is_active=true ORDER BY joined_at');
  const teams = teamsResult.rows.map(team);
  const states = {};
  const ids = user.role === 'team' ? [idOf(user.teamId)] : teams.map(t => idOf(t.id));
  for (const id of ids) {
    const result = await pool.query('SELECT * FROM team_market_state WHERE team_id=$1', [id]);
    if (result.rows[0]) states[String(id)] = marketState(result.rows[0]);
  }
  // Teams see standings only through the last PUBLISHED tick — i.e. one that
  // ran with grading complete. Staff always see live numbers.
  const leaderboard = await getLeaderboard();
  const leaderboardForUser = isStaffRole(user.role) || game.published_through_tick > 0
    ? leaderboard : [];
  // Bonus points from approved optional docs, and which mandatory docs are
  // still missing — the chase-list for admin before judging closes.
  const docStatus = {};
  {
    const { rows } = await pool.query(`
      SELECT t.id AS team_id,
             COALESCE(SUM(COALESCE(ds.points, 0)), 0) AS bonus,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT CASE WHEN dt.is_mandatory AND dt.cadence <> 'per_tick'
                    AND ds.id IS NULL THEN dt.label END), NULL) AS missing
        FROM teams t
        CROSS JOIN doc_types dt
        LEFT JOIN doc_submissions ds ON ds.team_id = t.id AND ds.doc_type = dt.id
       WHERE t.is_active = TRUE AND dt.is_active = TRUE
       GROUP BY t.id`);
    const scores = await docScoresByTeam(pool);
    for (const r of rows) docStatus[String(r.team_id)] = {
      points: Number(r.bonus),
      docScore: scores.get(String(r.team_id)) ?? null,
      missingMandatory: r.missing || [],
    };
  }
  const quality = {};
  if (isStaffRole(user.role)) {
    for (const t of teams) { const q = await teamQuality(pool, idOf(t.id)); quality[t.id] = q; }
  } else if (user.role === 'team') {
    // Teams see their own attribute breakdown + every team's composite.
    for (const t of teams) {
      if (String(t.id) === String(user.teamId)) quality[t.id] = await teamQuality(pool, idOf(t.id));
      else { const composite = leaderboard.find(l => l.teamId === String(t.id))?.qualityScore ?? null; quality[t.id] = { scores: {}, composite }; }
    }
  }
  return {
    teams: user.role === 'team' ? teams.filter(t => t.id === String(user.teamId)) : teams,
    marketState: states,
    activeShocks: await getActiveShocks(pool, user.role === 'team' ? idOf(user.teamId) : null),
    shockHistory: isStaffRole(user.role) ? (await pool.query('SELECT s.* FROM shocks s ORDER BY deployed_at DESC LIMIT 100')).rows.map(serialize) : [],
    gamePhase: game.phase,
    gameStartTime: game.game_start_time ? new Date(game.game_start_time).getTime() : null,
    gameTick: game.global_tick,
    round: game.round,
    tickInRound: game.tick_in_round,
    ticksPerRound: game.ticks_per_round,
    tickMinutes: game.tick_minutes,
    ...deadlinesOf(game),
    halftimeShockAt: game.halftime_shock_at ? new Date(game.halftime_shock_at).getTime() : null,
    pivotDeadline: game.pivot_deadline ? new Date(game.pivot_deadline).getTime() : null,
    pivotOpen: Boolean(game.halftime_shock_at) && Boolean(game.pivot_deadline) && new Date(game.pivot_deadline) > new Date(),
    docStatus,
    leaderboard: leaderboardForUser,
    resultsPending: !isStaffRole(user.role) && game.published_through_tick < game.global_tick,
    quality, qualityAttributes: QUALITY_ATTRIBUTES, lastUpdate: Date.now(),
  };
}
/** A team's document score, 0..1 — points awarded divided by the points
 *  available on the documents that have actually been rated so far. This is
 *  what feeds the market (market.js docMultiplier): a well-rated idea and a
 *  well-argued pricing model literally make the market kinder to you. */
async function docScoresByTeam(client = pool) {
  const { rows } = await client.query(`
    SELECT ds.team_id,
           SUM(COALESCE(ds.points, 0))  AS earned,
           SUM(dt.max_points)           AS possible
      FROM doc_submissions ds
      JOIN doc_types dt ON dt.id = ds.doc_type
     WHERE ds.points IS NOT NULL AND dt.max_points > 0
     GROUP BY ds.team_id`);
  const out = new Map();
  for (const r of rows) {
    const possible = Number(r.possible) || 0;
    out.set(String(r.team_id), possible > 0 ? Number(r.earned) / possible : null);
  }
  return out;
}

/** Aggregated view of a team's rubric scores across all judges, plus the
 *  mean per attribute so the UI can still show a breakdown. */
async function teamQuality(client, teamId) {
  const { rows } = await client.query(
    'SELECT attribute, AVG(score)::numeric AS score FROM judge_scores WHERE team_id=$1 GROUP BY attribute', [teamId]
  );
  const scores = {};
  for (const row of rows) scores[row.attribute] = Number(Number(row.score).toFixed(1));
  return { scores, composite: compositeQuality(scores) };
}
function serializeDeployment(row) {
  return { id: String(row.id), teamId: String(row.team_id), teamName: row.team_name || null, startupName: row.startup_name || null, tick: row.tick, at: row.created_at ? new Date(row.created_at).getTime() : null, price: Number(row.price), marketingSpend: Number(row.marketing_spend), targetSegment: row.target_segment || null, demand: Number(row.demand), conversion: Number(row.conversion), units: row.units_sold, revenue: Number(row.revenue), cost: row.cost == null ? null : Number(row.cost), budget: Number(row.budget), quality: row.quality == null ? null : Number(row.quality) };
}
async function getLeaderboard() { const { rows } = await pool.query(`
  SELECT t.id,t.team_name,t.startup_name,t.category,m.total_revenue,m.net_profit,m.budget,
         m.conversion_rate,m.total_units_sold,m.quality_score,m.tick,m.debt,m.is_insolvent,
         t.is_disqualified,
         -- Mean of the per-tick normalised scores: every tick weighs the same,
         -- so one outlier tick cannot carry a team across only four ticks.
         (SELECT ROUND(AVG(h.tick_score), 2) FROM market_history h
           WHERE h.team_id = t.id AND h.tick_score IS NOT NULL) AS market_score,
         (SELECT COALESCE(SUM(ds.points), 0) FROM doc_submissions ds
           WHERE ds.team_id = t.id AND ds.points IS NOT NULL)   AS doc_points
    FROM teams t JOIN team_market_state m ON m.team_id=t.id
   WHERE t.is_active=true
   ORDER BY t.is_disqualified ASC,
            COALESCE((SELECT AVG(h.tick_score) FROM market_history h WHERE h.team_id=t.id AND h.tick_score IS NOT NULL), 0) DESC,
            m.total_revenue DESC`); return rows.map(row => ({ teamId: String(row.id), teamName: row.team_name, startupName: row.startup_name, category: row.category, totalRevenue: Number(row.total_revenue), netProfit: Number(row.net_profit), budget: Number(row.budget), convRate: Number(row.conversion_rate), unitsSold: Number(row.total_units_sold), qualityScore: row.quality_score == null ? null : Number(row.quality_score), tick: row.tick, debt: Number(row.debt || 0), isInsolvent: Boolean(row.is_insolvent), isDisqualified: Boolean(row.is_disqualified),
  marketScore: row.market_score == null ? null : Number(row.market_score),
  docPoints: Number(row.doc_points || 0) })); }
/**
 * Normalise one tick's results across the field, 0-100.
 *
 * With only four ticks, raw rupees let a single outlier tick decide the whole
 * event — one lucky roll outweighs three solid ones. Scoring each tick
 * relative to that tick's field and then averaging makes all four count
 * equally, and keeps the comparison inside a team's own track so a
 * low-baseline track isn't punished for its baseline.
 *
 * Score is a percentile of contribution (revenue - cost) among the teams on
 * the same track that tick: best = 100, worst = 0, everyone equal = 50.
 */
async function normaliseTickScores(client, tick) {
  const { rows } = await client.query(`
    SELECT h.team_id, COALESCE(m.track_id, m.category) AS track,
           (h.revenue - COALESCE(h.cost, 0)) AS contribution
      FROM market_history h
      JOIN team_market_state m ON m.team_id = h.team_id
     WHERE h.tick = $1`, [tick]);
  if (rows.length === 0) return 0;

  const byTrack = new Map();
  for (const r of rows) {
    if (!byTrack.has(r.track)) byTrack.set(r.track, []);
    byTrack.get(r.track).push({ teamId: r.team_id, value: Number(r.contribution) });
  }

  let written = 0;
  for (const [, entries] of byTrack) {
    const values = entries.map(e => e.value);
    const min = Math.min(...values), max = Math.max(...values);
    for (const e of entries) {
      // A single team on a track, or a dead-flat field, sits at the midpoint
      // rather than being handed a free 100.
      const score = (entries.length < 2 || max === min) ? 50 : ((e.value - min) / (max - min)) * 100;
      await client.query('UPDATE market_history SET tick_score=$1 WHERE team_id=$2 AND tick=$3',
        [Number(score.toFixed(2)), e.teamId, tick]);
      written++;
    }
  }
  return written;
}

async function isDisqualified(teamId, client = pool) {
  const { rows } = await client.query('SELECT is_disqualified FROM teams WHERE id=$1', [teamId]);
  return Boolean(rows[0]?.is_disqualified);
}
async function validateTargetTeam(targetTeamId, client = pool) { if (targetTeamId === null) return true; if (!Number.isInteger(targetTeamId)) return false; return Boolean((await client.query('SELECT 1 FROM teams WHERE id=$1 AND is_active=true', [targetTeamId])).rowCount); }
function validateStrategy(body) { const productPrice = Number(body.productPrice), marketingSpend = Number(body.marketingSpend), targetSegment = body.targetSegment; if (!Number.isFinite(productPrice) || productPrice < 50 || productPrice > 9999) return 'Product price must be between 50 and 9,999 (matches the UI range exactly).'; if (!Number.isFinite(marketingSpend) || marketingSpend < 0 || marketingSpend > 30000) return 'Marketing spend must be between 0 and 30,000 (matches the UI range exactly).'; if (!validSegments.includes(targetSegment)) return 'Invalid target segment.'; return null; }

app.get('/api/health', async (req, res) => { try { await pool.query('SELECT 1'); ok(res, { status: 'ok', database: 'connected' }); } catch { fail(res, 503, 'DATABASE_UNAVAILABLE', 'The database is unavailable.'); } });

/* ---------------------------- Auth ---------------------------- */
app.post('/api/auth/team/register', authLimiter, async (req, res, next) => { try {
  const { teamName, startupName, category, tagline = '', password = '' } = req.body;
  const track = await getTrack(category);
  if (!teamName || !startupName || !track || !track.is_active || password.length < 8) return fail(res, 400, 'INVALID_INPUT', 'Team, startup, an active track, and an 8-character password are required.');
  const result = await withTransaction(async client => {
    const existing = await client.query('SELECT t.*,u.id AS user_id FROM teams t LEFT JOIN users u ON u.team_id=t.id WHERE LOWER(t.team_name)=LOWER($1)', [teamName.trim()]);
    if (existing.rows[0]) {
      const user = existing.rows[0];
      if (!user.user_id || !(await bcrypt.compare(password, (await client.query('SELECT password_hash FROM users WHERE id=$1', [user.user_id])).rows[0].password_hash))) throw Object.assign(new Error('Team name or password is incorrect.'), { status: 409, code: 'TEAM_LOGIN_FAILED' });
      return { id: user.id, teamId: user.id, role: 'team', team: team(user) };
    }
    const created = await client.query('INSERT INTO teams(team_name,startup_name,category,tagline) VALUES($1,$2,$3,$4) RETURNING *', [teamName.trim(), startupName.trim(), category, tagline.trim()]);
    const t = created.rows[0], initial = initialState(track);
    await client.query("INSERT INTO users(team_id,role,password_hash) VALUES($1,'team',$2)", [t.id, await bcrypt.hash(password, 12)]);
    await client.query(
      `INSERT INTO team_market_state
         (team_id,category,track_id,budget,max_budget,product_price,demand_index,base_demand,conversion_rate,base_conversion,
          burn_rate,awareness,capacity,active_customers,debt,is_insolvent,reputation_scar,demand_history,conversion_history)
       VALUES ($1,$2,$2,$3,$3,$4,$5,$5,$6,$6,$7,0,$8,0,0,false,0,$9,$10)`,
      [t.id, category, initial.budget, initial.productPrice, initial.demandIndex, initial.baseConversion, initial.burnRate,
        initial.capacity, JSON.stringify([initial.demandIndex]), JSON.stringify([initial.baseConversion])]
    );
    // A team registering after the split was computed still gets a judge —
    // whoever currently has the fewest teams.
    await judging.assignTeamToLightestJudge(client, t.id).catch(() => null);
    await logEvent(client, { actorType: 'team', actorId: t.id, actorName: t.team_name, teamId: t.id, kind: 'team.register', summary: `${t.team_name} registered on ${category}.` });
    return { id: t.id, teamId: t.id, role: 'team', team: team(t) };
  });
  issueSession(res, result); return ok(res, result, 201);
} catch (e) { if (e.status) return fail(res, e.status, e.code, e.message); if (e && e.code === '23505') return fail(res, 409, 'TEAM_NAME_TAKEN', 'That team name was just taken. Try another name, or log in if it is yours.'); next(e); } });

app.post('/api/auth/team/login', authLimiter, async (req, res, next) => { try { const { teamName, password } = req.body; const { rows } = await pool.query('SELECT t.*,u.id user_id,u.password_hash FROM teams t JOIN users u ON u.team_id=t.id WHERE LOWER(t.team_name)=LOWER($1) AND t.is_active=true', [teamName || '']); if (!rows[0] || !(await bcrypt.compare(password || '', rows[0].password_hash))) return fail(res, 401, 'INVALID_CREDENTIALS', 'Team name or password is incorrect.'); const result = { id: rows[0].user_id, teamId: rows[0].id, role: 'team', team: team(rows[0]) }; issueSession(res, result); ok(res, result); } catch (e) { next(e); } });

// Admin: single shared bcrypt passphrase — one control room (PLAN.md §2).
app.post('/api/auth/admin/login', authLimiter, async (req, res) => { if (!process.env.ADMIN_PASSWORD_HASH || !(await bcrypt.compare(req.body.password || '', process.env.ADMIN_PASSWORD_HASH))) return fail(res, 401, 'INVALID_CREDENTIALS', 'Invalid admin credentials.'); const user = { id: 'admin', role: 'admin', name: 'Game Master' }; issueSession(res, user); ok(res, user); });

// Judge: named accounts defined dynamically from JUDGE_<n>_NAME/_CODE env
// vars (server/services/judges.js) — a short code, not a password.
app.post('/api/auth/judge/login', authLimiter, async (req, res, next) => { try {
  const judge = await findActiveJudgeByCode(pool, req.body.code);
  if (!judge) return fail(res, 401, 'INVALID_CREDENTIALS', 'Invalid or unknown judge code.');
  const user = { id: judge.id, role: 'judge', name: judge.name };
  issueSession(res, user); ok(res, user);
} catch (e) { next(e); } });

app.post('/api/auth/logout', (req, res) => { res.clearCookie('ss_session', { path: '/' }); ok(res, null); });
app.get('/api/auth/me', requireAuth, async (req, res) => ok(res, req.user));

/* ---------------------------- Game state / leaderboard / shocks ---------------------------- */
app.get('/api/game/state', requireAuth, async (req, res, next) => { try { ok(res, await loadSnapshot(req.user)); } catch (e) { next(e); } });
app.get('/api/leaderboard', async (req, res, next) => { try { ok(res, await getLeaderboard()); } catch (e) { next(e); } });
app.get('/api/tracks', requireAuth, async (req, res, next) => { try { ok(res, await getActiveTracks()); } catch (e) { next(e); } });
app.get('/api/shocks', requireAuth, (req, res) => ok(res, CATALOG));
app.get('/api/shocks/active', requireAuth, async (req, res, next) => { try { ok(res, await getActiveShocks(pool, req.user.role === 'team' ? idOf(req.user.teamId) : null)); } catch (e) { next(e); } });
app.get('/api/shocks/history', requireAuth, requireRole(['admin', 'judge']), async (req, res, next) => { try { ok(res, (await pool.query('SELECT s.*, h.resolved_at FROM shocks s LEFT JOIN shock_history h ON h.instance_id=s.instance_id ORDER BY s.deployed_at DESC LIMIT 100')).rows.map(serialize)); } catch (e) { next(e); } });

app.get('/api/deployments', requireAuth, requireRole(['admin', 'judge']), async (req, res, next) => { try {
  const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit || '50', 10) || 50));
  const teamId = req.query.teamId ? idOf(req.query.teamId) : null;
  const params = []; let where = '';
  if (teamId) { params.push(teamId); where = 'WHERE h.team_id=$1'; }
  params.push(limit);
  const { rows } = await pool.query(`SELECT h.*, t.team_name, t.startup_name FROM market_history h JOIN teams t ON t.id=h.team_id ${where} ORDER BY h.created_at DESC, h.id DESC LIMIT $${params.length}`, params);
  ok(res, rows.map(serializeDeployment));
} catch (e) { next(e); } });

app.get('/api/teams/:teamId/stats', requireAuth, async (req, res, next) => { try {
  const teamId = idOf(req.params.teamId);
  if (req.user.role === 'team' && teamId !== idOf(req.user.teamId)) return fail(res, 403, 'FORBIDDEN', 'You can only view your own stats.');
  const t = await pool.query('SELECT * FROM teams WHERE id=$1 AND is_active=true', [teamId]);
  if (!t.rows[0]) return fail(res, 404, 'TEAM_NOT_FOUND', 'Team not found.');
  const msr = await pool.query('SELECT * FROM team_market_state WHERE team_id=$1', [teamId]);
  const m = msr.rows[0];
  const agg = (await pool.query('SELECT COUNT(*)::int AS n, COALESCE(SUM(marketing_spend),0)::float AS mkt, COALESCE(SUM(revenue),0)::float AS rev, COALESCE(SUM(units_sold),0)::int AS units, COALESCE(AVG(price),0)::float AS avgPrice FROM market_history WHERE team_id=$1', [teamId])).rows[0];
  const seg = (await pool.query('SELECT target_segment, COUNT(*)::int AS n FROM market_history WHERE team_id=$1 GROUP BY target_segment', [teamId])).rows;
  const rows = (await pool.query('SELECT h.*, t.team_name, t.startup_name FROM market_history h JOIN teams t ON t.id=h.team_id WHERE h.team_id=$1 ORDER BY h.tick DESC LIMIT 100', [teamId])).rows;
  ok(res, { team: team(t.rows[0]), market: m ? marketState(m) : null,
    spend: { marketing: agg.mkt, total: agg.mkt },
    totals: { revenue: agg.rev, units: agg.units, avgPrice: agg.avgPrice, deployments: agg.n },
    segmentMix: seg, deployments: rows.map(serializeDeployment) });
} catch (e) { next(e); } });

/* ---------------------------- Quality (judge-rated) ---------------------------- */
app.get('/api/quality/attributes', requireAuth, (req, res) => ok(res, QUALITY_ATTRIBUTES));
app.get('/api/quality', requireAuth, requireRole(['admin', 'judge']), async (req, res, next) => { try { const teamsResult = await pool.query('SELECT * FROM teams WHERE is_active=true ORDER BY joined_at'); const out = {}; for (const t of teamsResult.rows) out[String(t.id)] = await teamQuality(pool, t.id); ok(res, out); } catch (e) { next(e); } });
app.get('/api/quality/:teamId', requireAuth, async (req, res, next) => { try { const teamId = idOf(req.params.teamId); if (req.user.role === 'team' && teamId !== idOf(req.user.teamId)) return fail(res, 403, 'FORBIDDEN', 'You can only view your own quality scores.'); if (!await validateTargetTeam(teamId)) return fail(res, 404, 'TEAM_NOT_FOUND', 'Team not found.'); const q = await teamQuality(pool, teamId); if (req.user.role === 'team') return ok(res, { composite: q.composite }); ok(res, q); } catch (e) { next(e); } });
app.post('/api/quality/:teamId', requireAuth, requireRole(['admin', 'judge']), async (req, res, next) => { try {
  const teamId = idOf(req.params.teamId);
  if (!await validateTargetTeam(teamId)) return fail(res, 404, 'TEAM_NOT_FOUND', 'Team not found.');
  const input = req.body && typeof req.body === 'object' ? (req.body.scores || req.body) : null;
  if (!input || typeof input !== 'object') return fail(res, 400, 'INVALID_SCORES', 'Provide scores as { attribute: score } with each score 1-10.');
  const entries = [];
  for (const attr of QUALITY_ATTRIBUTES) {
    if (input[attr.id] === undefined || input[attr.id] === null || input[attr.id] === '') continue;
    const score = Number(input[attr.id]);
    if (!Number.isFinite(score) || score < 1 || score > 10) return fail(res, 400, 'INVALID_SCORES', `Score for ${attr.label} must be between 1 and 10.`);
    entries.push([attr.id, Math.round(score)]);
  }
  if (entries.length === 0) return fail(res, 400, 'INVALID_SCORES', 'Provide at least one attribute score between 1 and 10.');
  const composite = await withTransaction(async client => {
    const myJudgeId = await actingJudgeId(client, req.user);
    for (const [attribute, score] of entries) await client.query(
      `INSERT INTO judge_scores(judge_id,team_id,attribute,score,updated_at) VALUES($1,$2,$3,$4,NOW())
       ON CONFLICT(judge_id,team_id,attribute) DO UPDATE SET score=EXCLUDED.score,updated_at=NOW()`,
      [myJudgeId, teamId, attribute, score]);
    // The team's composite is the aggregate across every judge who scored
    // them (z-normalized per judge when judging is partitioned).
    const mode = await judging.resolveJudgingMode(client);
    const composites = await judging.teamComposites(client, mode);
    const next = composites[String(teamId)]?.composite ?? null;
    await client.query('UPDATE team_market_state SET quality_score=$1,quality_updated_at=NOW(),updated_at=NOW() WHERE team_id=$2', [next, teamId]);
    await logEvent(client, { actorType: req.user.role, actorId: req.user.id, actorName: req.user.name, teamId, kind: 'score.set', summary: `${req.user.name} scored team ${teamId}; composite across judges is now ${next}.`, payload: { submitted: Object.fromEntries(entries), judgeId: String(myJudgeId) } });
    return next;
  });
  ok(res, { ...(await teamQuality(pool, teamId)), composite });
} catch (e) { next(e); } });

/* ---------------------------- Team profile / market / BMC ---------------------------- */
app.get('/api/teams/:teamId', requireAuth, async (req, res, next) => { try { const teamId = idOf(req.params.teamId); if (req.user.role === 'team' && teamId !== idOf(req.user.teamId)) return fail(res, 403, 'FORBIDDEN', 'You can only view your own team.'); const result = await pool.query('SELECT * FROM teams WHERE id=$1 AND is_active=true', [teamId]); if (!result.rows[0]) return fail(res, 404, 'TEAM_NOT_FOUND', 'Team not found.'); ok(res, team(result.rows[0])); } catch (e) { next(e); } });
app.get('/api/teams/:teamId/market', requireAuth, async (req, res, next) => { try { const teamId = idOf(req.params.teamId); if (req.user.role === 'team' && teamId !== idOf(req.user.teamId)) return fail(res, 403, 'FORBIDDEN', 'You can only view your own market state.'); const result = await pool.query('SELECT * FROM team_market_state WHERE team_id=$1', [teamId]); if (!result.rows[0]) return fail(res, 404, 'TEAM_NOT_FOUND', 'Team not found.'); ok(res, marketState(result.rows[0])); } catch (e) { next(e); } });

app.get('/api/teams', requireAuth, requireRole(['admin', 'judge']), async (req, res, next) => { try { const rows = (await pool.query('SELECT * FROM teams WHERE is_active=true ORDER BY joined_at')).rows; return ok(res, rows.map(team)); } catch (e) { next(e); } });

/* ---------------------------- Request → approval → deploy ----------------------------
   Two steps, in this order, and the second is locked until the first is
   approved:
     1. POST /api/teams/:teamId/strategy  — the team SUBMITS A REQUEST:
        numeric strategy + a cited Google Doc justifying it.
     2. POST /api/teams/:teamId/deploy    — only clickable once a judge has
        APPROVED that request. Runs the team's tick, then marks the approval
        consumed so one approval can never be spent twice.
   This keeps clicking speed irrelevant (judge approval is the gate, not
   reflexes) while leaving the deploy moment in the team's hands. */

/** The team's live request for the upcoming tick, plus whether a deploy is
 *  currently unlocked. Drives the participant panel's button state. */
/** Scales a tick result down by a judge-assessed penalty (0-100%), applied
 *  to what the team actually earned this tick. Totals are recomputed so the
 *  penalty is reflected in the running numbers, not just the tick line. */
function applyPenalty(result, penaltyPct) {
  const pct = Math.min(100, Math.max(0, Number(penaltyPct) || 0));
  if (pct <= 0) return result;
  const keep = 1 - pct / 100;
  const lostRevenue = result.revenue * (1 - keep);
  result.unitsSold = Math.floor(result.unitsSold * keep);
  result.revenue = Number((result.revenue * keep).toFixed(2));
  result.totalRevenue = Number((result.totalRevenue - lostRevenue).toFixed(2));
  result.netProfit = Number((result.netProfit - lostRevenue).toFixed(2));
  result.budget = Number((result.budget - lostRevenue).toFixed(2));
  result.penaltyPct = pct;
  if (result.decomposition) result.decomposition.penaltyPct = pct;
  return result;
}

async function pendingRequestFor(teamId, client = pool) {
  const game = await getGame(client);
  const nextTick = game.tick_in_round + 1;
  const { rows } = await client.query(
    "SELECT * FROM doc_submissions WHERE team_id=$1 AND doc_type='pricing_justification' AND round=$2 AND tick=$3",
    [teamId, game.round, nextTick]
  );
  const submission = rows[0] || null;
  return {
    round: game.round,
    tick: nextTick,
    phase: game.phase,
    submission: submission ? docs.serializeSubmission(submission) : null,
    canDeploy: Boolean(submission && submission.status === 'approved' && !submission.consumed_at && game.phase === 'active'),
    deployedAt: submission?.consumed_at ? new Date(submission.consumed_at).getTime() : null,
  };
}

app.get('/api/teams/:teamId/request', requireAuth, requireRole('team'), async (req, res, next) => { try {
  const teamId = idOf(req.params.teamId);
  if (teamId !== idOf(req.user.teamId)) return fail(res, 403, 'FORBIDDEN', 'You can only view your own request.');
  ok(res, await pendingRequestFor(teamId));
} catch (e) { next(e); } });

app.post('/api/teams/:teamId/deploy', requireAuth, requireRole('team'), async (req, res, next) => { try {
  const teamId = idOf(req.params.teamId);
  if (teamId !== idOf(req.user.teamId)) return fail(res, 403, 'FORBIDDEN', 'You can only deploy for your own team.');
  const result = await withTransaction(async client => {
    const game = await getGame(client);
    if (game.phase !== 'active') throw Object.assign(new Error(`The game is ${game.phase}.`), { status: 409, code: `GAME_NOT_${game.phase.toUpperCase()}` });
    if (await isDisqualified(teamId, client)) throw Object.assign(new Error('Your team was disqualified at the halftime cut.'), { status: 403, code: 'DISQUALIFIED' });
    const nextTick = game.tick_in_round + 1;

    // Lock the approval row itself so two rapid clicks can't both consume it.
    const approved = (await client.query(
      "SELECT * FROM doc_submissions WHERE team_id=$1 AND doc_type='pricing_justification' AND round=$2 AND tick=$3 FOR UPDATE",
      [teamId, game.round, nextTick]
    )).rows[0];
    if (!approved) throw Object.assign(new Error('Submit a strategy request first — there is nothing approved to deploy.'), { status: 409, code: 'NO_REQUEST' });
    if (approved.status !== 'approved') throw Object.assign(new Error(`Your request is ${approved.status.replace('_', ' ')} — a judge must approve it before you can deploy.`), { status: 409, code: 'NOT_APPROVED' });
    if (approved.consumed_at) throw Object.assign(new Error('This approval has already been deployed. Submit a new request for the next tick.'), { status: 409, code: 'ALREADY_DEPLOYED' });

    const state = (await client.query('SELECT * FROM team_market_state WHERE team_id=$1 FOR UPDATE', [teamId])).rows[0];
    if (!state) throw Object.assign(new Error('Team not found.'), { status: 404, code: 'TEAM_NOT_FOUND' });
    const track = await getTrack(state.track_id || state.category, client);
    if (!track) throw Object.assign(new Error('Track not found.'), { status: 404, code: 'TRACK_NOT_FOUND' });

    const strategy = { productPrice: Number(approved.price), marketingSpend: Number(approved.marketing_spend), targetSegment: approved.target_segment };
    const shockRows = (await client.query('SELECT * FROM shocks WHERE resolved=false AND expires_at > NOW() AND (target_team_id IS NULL OR target_team_id=$1)', [teamId])).rows;
    const shocks = shockRows.map(s => ({ shock_id: s.shock_id, demand: Number(s.demand_effect), budget: Number(s.budget_effect), conversion: Number(s.conversion_effect), trackMultipliers: null }));

    // Share of the track's pool is still computed against every rival on
    // that track, so a deploy is never evaluated in a vacuum — this is what
    // keeps the shared-market competition intact for a single-team deploy.
    const trackTeams = (await client.query(
      'SELECT m.* FROM team_market_state m JOIN teams t ON t.id=m.team_id WHERE t.is_active=true AND COALESCE(m.track_id, m.category)=$1',
      [track.id]
    )).rows;
    const docScores = await docScoresByTeam(client);
    const entries = trackTeams.map(row => {
      const isSelf = Number(row.team_id) === teamId;
      const rowStrategy = isSelf ? strategy : { productPrice: Number(row.product_price), marketingSpend: Number(row.marketing_spend), targetSegment: row.target_segment };
      const { attractiveness } = attractivenessFor(row, track, rowStrategy, isSelf ? shocks : [], row.quality_score, docScores.get(String(row.team_id)) ?? null);
      return { teamId: Number(row.team_id), attractiveness };
    });
    const share = allocateSharedPool(entries).get(teamId);

    const tickResult = applyTick({
      state, track, strategy, shocks, quality: state.quality_score, share,
      teamsOnTrack: trackTeams.length, gameId: 'default', teamId, tick: Number(state.tick) + 1,
      docScore: docScores.get(String(teamId)) ?? null,
    });
    // A judge-assessed late penalty scales down this tick's output.
    applyPenalty(tickResult, Number(approved.penalty_pct || 0));

    await client.query(
      `UPDATE team_market_state SET
         tick=$1, budget=$2, debt=$3, is_insolvent=$4, product_price=$5, marketing_spend=$6, target_segment=$7,
         awareness=$8, active_customers=$9, reputation_scar=$10, demand_index=$11, conversion_rate=$12,
         units_sold=$13, total_units_sold=$14, total_revenue=$15, total_cost=$16, net_profit=$17,
         last_deployed_at=NOW(), deploy_count=$18, applied_shocks=$19, updated_at=NOW()
       WHERE team_id=$20`,
      [tickResult.tick, tickResult.budget, tickResult.debt, tickResult.isInsolvent, tickResult.productPrice, tickResult.marketingSpend, tickResult.targetSegment,
        tickResult.awareness, tickResult.activeCustomers, tickResult.reputationScar, tickResult.demandIndex, tickResult.conversionRate,
        tickResult.unitsSold, tickResult.totalUnitsSold, tickResult.totalRevenue, tickResult.totalCost, tickResult.netProfit,
        tickResult.deployCount, JSON.stringify(tickResult.appliedShocks), teamId]
    );
    await client.query(
      `INSERT INTO market_history (team_id,tick,revenue,units_sold,demand,conversion,budget,price,marketing_spend,quality,target_segment,cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (team_id,tick) DO NOTHING`,
      [teamId, tickResult.tick, tickResult.revenue, tickResult.unitsSold, tickResult.demandIndex, tickResult.conversionRate, tickResult.budget, tickResult.productPrice, tickResult.marketingSpend, tickResult.quality, tickResult.targetSegment, tickResult.cost]
    );
    await client.query('UPDATE doc_submissions SET consumed_at=NOW() WHERE id=$1', [approved.id]);
    await logEvent(client, { actorType: 'team', actorId: teamId, teamId, round: game.round, tick: nextTick, kind: 'deploy.run', summary: `Team ${teamId} deployed approved strategy: ${tickResult.unitsSold} units, ₹${tickResult.revenue.toFixed(0)} revenue.`, payload: tickResult.decomposition });
    return tickResult;
  });
  ok(res, result);
} catch (e) { if (e.status) return fail(res, e.status, e.code, e.message); next(e); } });

app.post('/api/teams/:teamId/strategy', requireAuth, requireRole('team'), async (req, res, next) => { try {
  const teamId = idOf(req.params.teamId);
  if (teamId !== idOf(req.user.teamId)) return fail(res, 403, 'FORBIDDEN', 'You can only submit a strategy for your own team.');
  const validation = validateStrategy(req.body);
  if (validation) return fail(res, 400, 'INVALID_STRATEGY', validation);
  const { docUrl } = req.body;
  if (!docUrl) return fail(res, 400, 'DOC_REQUIRED', 'A Pricing Justification doc link is required with every strategy submission.');
  const game = await getGame();
  if (game.phase !== 'active') return fail(res, 409, `GAME_NOT_${game.phase.toUpperCase()}`, `The game is ${game.phase}.`);
  if (await isDisqualified(teamId)) return fail(res, 403, 'DISQUALIFIED', 'Your team was disqualified at the halftime cut.');
  // Pricing is never hard-blocked by the clock. Past the deadline the
  // submission is accepted but FLAGGED LATE, and the judge decides the
  // consequence: approve as normal, approve with a penalty, or disqualify
  // this tick. Missing the window is a judgement call, not an auto-zero.
  const isLate = Boolean(game.submission_deadline) && new Date(game.submission_deadline) <= new Date();
  const nextTick = game.tick_in_round + 1;
  const result = await withTransaction(async client => {
    const submission = await docs.submitDoc(client, {
      teamId, docType: 'pricing_justification', round: game.round, tick: nextTick, docUrl, isLate,
      price: Number(req.body.productPrice), marketingSpend: Number(req.body.marketingSpend), targetSegment: req.body.targetSegment,
    });
    await logEvent(client, { actorType: 'team', actorId: teamId, teamId, round: game.round, tick: nextTick, kind: isLate ? 'doc.submit_late' : 'doc.submit', summary: `Team ${teamId} submitted Pricing Justification for round ${game.round} tick ${nextTick}${isLate ? ' — LATE, judge must decide penalty' : ''}.` });
    return submission;
  });
  ok(res, docs.serializeSubmission(result), 201);
} catch (e) { if (e instanceof docs.DocError) return fail(res, e.status, e.code, e.message); next(e); } });

/* ---------------------------- Documents & review engine (DOCS_SYSTEM.md) ---------------------------- */
app.get('/api/docs/types', requireAuth, async (req, res, next) => { try { ok(res, (await pool.query('SELECT * FROM doc_types WHERE is_active=true ORDER BY id')).rows); } catch (e) { next(e); } });

app.post('/api/teams/:teamId/docs/:docType', requireAuth, requireRole('team'), async (req, res, next) => { try {
  const teamId = idOf(req.params.teamId);
  if (teamId !== idOf(req.user.teamId)) return fail(res, 403, 'FORBIDDEN', 'You can only submit documents for your own team.');
  const docType = (await pool.query('SELECT * FROM doc_types WHERE id=$1 AND is_active=true', [req.params.docType])).rows[0];
  if (!docType) return fail(res, 404, 'DOC_TYPE_NOT_FOUND', 'Unknown document type.');
  if (docType.cadence === 'per_tick') return fail(res, 400, 'USE_STRATEGY_ENDPOINT', 'Pricing Justification is submitted via POST /api/teams/:teamId/strategy, alongside your numeric strategy.');
  const game = await getGame();
  // Nothing is accepted once the event is over. (Lobby IS allowed — several
  // documents are deliberately pre-event homework.)
  if (game.phase === 'ended') return fail(res, 409, 'GAME_ENDED', 'The event has ended — submissions are closed.');
  // Pre-shock documents (deck, idea brief, GTM, compliance) lock the moment
  // the halftime shock fires — you cannot rewrite your pitch around a shock
  // you've already seen.
  if (docType.due_before_shock && game.halftime_shock_at) {
    return fail(res, 409, 'LOCKED_BY_SHOCK', `${docType.label} closed when the halftime shock fired.`);
  }
  // The pivot window is the centrepiece: it does not exist before the shock,
  // and it shuts hard when the window expires.
  if (docType.opens_after_shock) {
    if (!game.halftime_shock_at) return fail(res, 409, 'PIVOT_NOT_OPEN', `${docType.label} opens when the halftime shock fires.`);
    if (!game.pivot_deadline || new Date(game.pivot_deadline) <= new Date()) {
      return fail(res, 409, 'PIVOT_CLOSED', `The pivot window has closed. ${docType.label} is no longer accepted.`);
    }
  }
  const round = docType.round ?? game.round;
  const result = await withTransaction(async client => {
    const submission = await docs.submitDoc(client, { teamId, docType: docType.id, round, tick: null, docUrl: req.body.docUrl });
    await logEvent(client, { actorType: 'team', actorId: teamId, teamId, round, kind: 'doc.submit', summary: `Team ${teamId} submitted ${docType.label}.` });
    return submission;
  });
  ok(res, docs.serializeSubmission(result), 201);
} catch (e) { if (e instanceof docs.DocError) return fail(res, e.status, e.code, e.message); next(e); } });

app.get('/api/docs/mine', requireAuth, requireRole('team'), async (req, res, next) => { try {
  const { rows } = await pool.query('SELECT * FROM doc_submissions WHERE team_id=$1 ORDER BY submitted_at DESC', [idOf(req.user.teamId)]);
  ok(res, rows.map(r => docs.serializeSubmission(r)));
} catch (e) { next(e); } });

// Queue for judges/admin — docs that gate a tick (block the round) sort
// above docs that only feed scoring (DOCS_SYSTEM.md §8).
app.get('/api/docs/queue', requireAuth, requireRole(['admin', 'judge']), async (req, res, next) => { try {
  const status = req.query.status || 'submitted,under_review';
  const statuses = String(status).split(',');
  // When judging is partitioned, a judge only sees their own teams.
  const game = await getGame();
  let onlyTeams = null;
  if (req.user.role === 'judge' && game.judging_mode === 'partitioned') {
    onlyTeams = await judging.teamsForJudge(pool, await actingJudgeId(pool, req.user), 'partitioned');
  }
  const { rows } = await pool.query(
    `SELECT ds.*, dt.label AS doc_type_label, dt.gates_tick, dt.max_points, dt.is_mandatory,
            t.team_name, t.startup_name, t.category, j.name AS claimed_by_name,
            -- Live context, so a judge is never rating a document in a vacuum.
            m.total_revenue, m.net_profit, m.budget, m.max_budget, m.debt,
            m.is_insolvent, m.quality_score, m.tick AS ticks_played,
            (SELECT COALESCE(SUM(d2.points),0) FROM doc_submissions d2
              WHERE d2.team_id = ds.team_id AND d2.points IS NOT NULL) AS team_points
     FROM doc_submissions ds
     JOIN doc_types dt ON dt.id = ds.doc_type
     JOIN teams t ON t.id = ds.team_id
     JOIN team_market_state m ON m.team_id = ds.team_id
     LEFT JOIN judges j ON j.id = ds.claimed_by
     WHERE ds.status = ANY($1::text[])
       AND ($2::bigint[] IS NULL OR ds.team_id = ANY($2::bigint[]))
     ORDER BY dt.gates_tick DESC, ds.submitted_at ASC`,
    [statuses, onlyTeams]
  );
  ok(res, rows.map(r => ({ ...docs.serializeSubmission(r), docTypeLabel: r.doc_type_label, gatesTick: r.gates_tick, maxPoints: Number(r.max_points || 0),
    isMandatory: r.is_mandatory, teamName: r.team_name, startupName: r.startup_name,
    category: r.category, claimedByName: r.claimed_by_name,
    team: {
      totalRevenue: Number(r.total_revenue), netProfit: Number(r.net_profit),
      moneyDelta: Number(r.budget) - Number(r.max_budget),
      debt: Number(r.debt || 0), isInsolvent: Boolean(r.is_insolvent),
      qualityScore: r.quality_score == null ? null : Number(r.quality_score),
      points: Number(r.team_points), ticksPlayed: Number(r.ticks_played),
    } })));
} catch (e) { next(e); } });

app.get('/api/docs/:id/snapshot', requireAuth, async (req, res, next) => { try {
  const { rows } = await pool.query('SELECT team_id, snapshot FROM doc_submissions WHERE id=$1', [idOf(req.params.id)]);
  if (!rows[0]) return fail(res, 404, 'NOT_FOUND', 'Submission not found.');
  if (req.user.role === 'team' && idOf(req.user.teamId) !== Number(rows[0].team_id)) return fail(res, 403, 'FORBIDDEN', 'You can only view your own submissions.');
  if (!rows[0].snapshot) return fail(res, 404, 'NO_SNAPSHOT', 'No snapshot stored for this submission.');
  res.set('Content-Type', 'application/pdf');
  res.send(rows[0].snapshot);
} catch (e) { next(e); } });

app.get('/api/docs/:id/comments', requireAuth, async (req, res, next) => { try {
  const submissionId = idOf(req.params.id);
  const sub = (await pool.query('SELECT team_id FROM doc_submissions WHERE id=$1', [submissionId])).rows[0];
  if (!sub) return fail(res, 404, 'NOT_FOUND', 'Submission not found.');
  if (req.user.role === 'team' && idOf(req.user.teamId) !== Number(sub.team_id)) return fail(res, 403, 'FORBIDDEN', 'You can only view comments on your own submissions.');
  const { rows } = await pool.query('SELECT * FROM doc_comments WHERE submission_id=$1 ORDER BY created_at ASC', [submissionId]);
  ok(res, rows);
} catch (e) { next(e); } });

app.post('/api/docs/:id/comments', requireAuth, async (req, res, next) => { try {
  const submissionId = idOf(req.params.id);
  const sub = (await pool.query('SELECT team_id FROM doc_submissions WHERE id=$1', [submissionId])).rows[0];
  if (!sub) return fail(res, 404, 'NOT_FOUND', 'Submission not found.');
  if (req.user.role === 'team' && idOf(req.user.teamId) !== Number(sub.team_id)) return fail(res, 403, 'FORBIDDEN', 'You can only comment on your own submissions.');
  const comment = await docs.addComment(pool, submissionId, { authorType: req.user.role, authorId: req.user.id, authorName: req.user.name, section: req.body.section, tag: req.body.tag, body: req.body.body });
  ok(res, comment, 201);
} catch (e) { if (e instanceof docs.DocError) return fail(res, e.status, e.code, e.message); next(e); } });

app.post('/api/docs/:id/claim', requireAuth, requireRole(['admin', 'judge']), async (req, res, next) => { try {
  const row = await withTransaction(async client => docs.claimSubmission(client, idOf(req.params.id), await actingJudgeId(client, req.user)));
  ok(res, docs.serializeSubmission(row));
} catch (e) { if (e instanceof docs.DocError) return fail(res, e.status, e.code, e.message); next(e); } });

app.post('/api/docs/:id/decide', requireAuth, requireRole(['admin', 'judge']), async (req, res, next) => { try {
  const submissionId = idOf(req.params.id);
  const { decision, reason, penaltyPct, points } = req.body;
  const row = await withTransaction(async client => {
    const myJudgeId = await actingJudgeId(client, req.user);
    const updated = await docs.decideSubmission(client, submissionId, myJudgeId, decision, reason, penaltyPct, points);
    // Rated documents record one row PER JUDGE, then aggregate — otherwise a
    // second judge's rating would overwrite the first.
    if (decision === 'rated') {
      await client.query(
        `INSERT INTO doc_ratings (submission_id, judge_id, points, comment) VALUES ($1,$2,$3,$4)
         ON CONFLICT (submission_id, judge_id) DO UPDATE SET points=EXCLUDED.points, comment=EXCLUDED.comment, created_at=NOW()`,
        [submissionId, myJudgeId, Math.max(0, Number(points) || 0), reason || null]);
      await judging.recomputeDocPoints(client, submissionId);
      // Re-read so the response carries the AGGREGATE across judges, not just
      // the value this judge happened to submit.
      const fresh = (await client.query('SELECT * FROM doc_submissions WHERE id=$1', [submissionId])).rows[0];
      Object.assign(updated, fresh);
    }
    await logEvent(client, { actorType: req.user.role, actorId: req.user.id, actorName: req.user.name, teamId: updated.team_id, round: updated.round, tick: updated.tick, kind: `doc.${decision}`, summary: `${req.user.name} ${decision} ${updated.doc_type} for team ${updated.team_id}${Number(updated.penalty_pct) > 0 ? ` with a ${updated.penalty_pct}% penalty` : ''}${updated.is_late ? ' (late submission)' : ''}.`, payload: { reason: reason || null, penaltyPct: Number(updated.penalty_pct || 0), late: Boolean(updated.is_late) } });
    return updated;
  });
  ok(res, docs.serializeSubmission(row));
} catch (e) { if (e instanceof docs.DocError) return fail(res, e.status, e.code, e.message); next(e); } });

/* ---------------------------- Judge allocation ---------------------------- */
app.get('/api/judging/assignment', requireAuth, requireRole(['admin', 'judge']), async (req, res, next) => { try {
  const mode = (await getGame()).judging_mode || (await withTransaction(c => judging.resolveJudgingMode(c)));
  const myJudgeId = await actingJudgeId(pool, req.user);
  const myTeams = await judging.teamsForJudge(pool, myJudgeId, mode);
  const { rows } = await pool.query(`
    SELECT j.id, j.name, COUNT(ja.team_id)::int AS team_count
      FROM judges j LEFT JOIN judge_assignments ja ON ja.judge_id = j.id
     WHERE j.is_active = TRUE AND j.env_slot <> 0
     GROUP BY j.id, j.name ORDER BY j.env_slot`);
  ok(res, {
    mode,
    threshold: judging.PARTITION_THRESHOLD,
    myTeamIds: myTeams,
    judges: rows.map(r => ({ id: String(r.id), name: r.name, teamCount: r.team_count })),
  });
} catch (e) { next(e); } });

app.post('/api/judging/rebuild', requireAuth, requireRole('admin'), async (req, res, next) => { try {
  const result = await withTransaction(async client => {
    const r = await judging.rebuildAssignments(client);
    await logEvent(client, { actorType: 'admin', actorId: req.user.id, actorName: req.user.name, kind: 'judging.rebuild', summary: `Admin redistributed ${r.teams} teams across ${r.judges} judges.` });
    return r;
  });
  ok(res, result);
} catch (e) { next(e); } });

/* ---------------------------- Universal market events (judges) ----------------
   Judges may fire ONE opportunity or problem per tick, and it ALWAYS hits
   every team. There is deliberately no targeting here: a judge cannot help
   or hurt a single team, which is what keeps this fair. */
app.post('/api/events/global', requireAuth, requireRole(['admin', 'judge']), async (req, res, next) => { try {
  const shock = getCatalogShock(req.body.shockId);
  if (!shock) return fail(res, 400, 'INVALID_SHOCK', 'Pick an event from the catalog.');
  const result = await withTransaction(async client => {
    const game = await getGame(client);
    if (game.phase !== 'active') throw Object.assign(new Error(`The game is ${game.phase}.`), { status: 409, code: 'GAME_NOT_ACTIVE' });
    if (req.user.role === 'judge' && game.last_judge_event_tick === game.global_tick) {
      throw Object.assign(new Error('A universal event has already been fired for this tick. One per tick keeps it fair.'), { status: 409, code: 'EVENT_ALREADY_FIRED' });
    }
    const instanceId = `global_${shock.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    await client.query(
      `INSERT INTO shocks(instance_id,shock_id,name,emoji,description,category,severity,
                          demand_effect,budget_effect,conversion_effect,duration,expires_at,target_team_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()+($11::integer * INTERVAL '1 minute'),NULL)`,
      [instanceId, shock.id, shock.name, shock.emoji, shock.description, shock.category, shock.severity,
        shock.effect.demand, shock.effect.budget, shock.effect.conversion, shock.duration]);
    await client.query('INSERT INTO shock_history(instance_id,deployed_at,target_team_id) VALUES($1,NOW(),NULL)', [instanceId]);
    await client.query('UPDATE game_state SET last_judge_event_tick=global_tick, updated_at=NOW() WHERE id=1');
    await logEvent(client, {
      actorType: req.user.role, actorId: req.user.id, actorName: req.user.name,
      round: game.round, tick: game.tick_in_round, kind: 'event.global',
      summary: `${req.user.name} fired a universal ${shock.category}: ${shock.name} — every team, equally.`,
    });
    return { ...shock, instanceId, universal: true };
  });
  ok(res, result, 201);
} catch (e) { if (e.status) return fail(res, e.status, e.code, e.message); next(e); } });

/* ---------------------------- Final results ----------------------------
   Two components, each already on a 0-100 scale:
     MARKET  - mean of the per-tick normalised scores (all four ticks weigh
               the same, so one lucky tick cannot carry a team)
     DOCS    - judge-awarded document points (the six documents total 100)
   Judge rubric scores are deliberately NOT a third component: they already
   move the market through the quality multiplier, and counting them again
   here would be double-scoring the same opinion. */
app.get('/api/results', requireAuth, async (req, res, next) => { try {
  const game = await getGame();
  // Standings are staff-only until the admin releases them. Otherwise any
  // team could read every rival's exact money, scores and rank mid-event,
  // which both leaks strategy and spoils the reveal.
  if (!isStaffRole(req.user.role) && !game.results_frozen_at) {
    return fail(res, 403, 'RESULTS_NOT_RELEASED', 'Final standings are released at the end of the event.');
  }
  const wMarket = Number(game.weight_market), wDocs = Number(game.weight_docs);
  const totalWeight = wMarket + wDocs || 1;

  const { rows } = await pool.query(`
    SELECT t.id, t.team_name, t.startup_name, t.category, t.is_disqualified, t.disqualified_reason,
           COALESCE((SELECT AVG(h.tick_score) FROM market_history h
                      WHERE h.team_id = t.id AND h.tick_score IS NOT NULL), 0) AS market_score,
           COALESCE((SELECT SUM(ds.points) FROM doc_submissions ds
                      WHERE ds.team_id = t.id AND ds.points IS NOT NULL), 0)   AS doc_points,
           (SELECT COALESCE(SUM(max_points),0) FROM doc_types WHERE is_active AND max_points > 0) AS doc_ceiling,
           (SELECT COUNT(*) FROM doc_submissions ds WHERE ds.team_id = t.id
              AND ds.doc_type <> 'pricing_justification')                    AS submissions,
           (SELECT COUNT(*) FROM doc_types WHERE is_active AND max_points > 0) AS submissions_possible,
           (SELECT COUNT(*) FROM doc_submissions ds WHERE ds.team_id = t.id
              AND ds.doc_type = 'pricing_justification'
              AND ds.status IN ('approved','auto_approved'))                 AS pricing_approved,
           m.total_revenue, m.total_cost, m.net_profit, m.budget, m.max_budget,
           m.is_insolvent, m.debt, m.quality_score, m.tick
      FROM teams t JOIN team_market_state m ON m.team_id = t.id
     WHERE t.is_active = TRUE`);

  const results = rows.map(r => {
    const ceiling = Number(r.doc_ceiling) || 100;
    const marketScore = Number(r.market_score);
    const docScore = (Number(r.doc_points) / ceiling) * 100; // normalise docs onto 0-100 too
    const final = (marketScore * wMarket + docScore * wDocs) / totalWeight;
    return {
      teamId: String(r.id), teamName: r.team_name, startupName: r.startup_name, category: r.category,
      isDisqualified: Boolean(r.is_disqualified), disqualifiedReason: r.disqualified_reason,
      marketScore: Number(marketScore.toFixed(2)),
      docPoints: Number(r.doc_points), docCeiling: ceiling,
      docScore: Number(docScore.toFixed(2)),
      finalScore: Number(final.toFixed(2)),
      totalRevenue: Number(r.total_revenue), totalCost: Number(r.total_cost),
      netProfit: Number(r.net_profit),
      // Money actually made or lost against the starting budget — the number
      // a team recognises without needing the scoring model explained.
      moneyDelta: Number(r.budget) - Number(r.max_budget),
      budget: Number(r.budget), debt: Number(r.debt || 0),
      submissions: Number(r.submissions), submissionsPossible: Number(r.submissions_possible),
      pricingApproved: Number(r.pricing_approved), ticksPlayed: Number(r.tick),
      isInsolvent: Boolean(r.is_insolvent),
      qualityScore: r.quality_score == null ? null : Number(r.quality_score),
    };
  });

  // Disqualified teams always rank below everyone still standing.
  results.sort((a, b) =>
    (a.isDisqualified === b.isDisqualified)
      ? b.finalScore - a.finalScore || b.netProfit - a.netProfit
      : (a.isDisqualified ? 1 : -1));
  results.forEach((r, i) => { r.rank = i + 1; });

  ok(res, {
    weights: { market: wMarket, docs: wDocs },
    frozenAt: game.results_frozen_at ? new Date(game.results_frozen_at).getTime() : null,
    formula: `final = (market x ${wMarket}% ) + (documents x ${wDocs}% ), both scored 0-100`,
    results,
  });
} catch (e) { next(e); } });

app.post('/api/results/weights', requireAuth, requireRole('admin'), async (req, res, next) => { try {
  const market = Number(req.body.market), docs = Number(req.body.docs);
  if (![market, docs].every(v => Number.isFinite(v) && v >= 0)) return fail(res, 400, 'INVALID_WEIGHTS', 'market and docs must be non-negative numbers.');
  const game = await getGame();
  if (game.results_frozen_at) return fail(res, 409, 'RESULTS_FROZEN', 'Results are frozen — weights can no longer change.');
  await withTransaction(async client => {
    await client.query('UPDATE game_state SET weight_market=$1, weight_docs=$2, updated_at=NOW() WHERE id=1', [market, docs]);
    await logEvent(client, { actorType: 'admin', actorId: req.user.id, actorName: req.user.name, kind: 'results.weights', summary: `Admin set final weights to market ${market}% / documents ${docs}%.` });
  });
  ok(res, null);
} catch (e) { next(e); } });

/* Freeze the weights so they can't be tuned after standings are known. */
app.post('/api/results/freeze', requireAuth, requireRole('admin'), async (req, res, next) => { try {
  await withTransaction(async client => {
    await client.query('UPDATE game_state SET results_frozen_at=NOW(), updated_at=NOW() WHERE id=1');
    await logEvent(client, { actorType: 'admin', actorId: req.user.id, actorName: req.user.name, kind: 'results.freeze', summary: 'Admin froze the final results.' });
  });
  ok(res, null);
} catch (e) { next(e); } });

app.get('/api/powers', requireAuth, (req, res) => ok(res, POWERS));

/* Grant a RANDOM power to every team at once. The judge chooses neither the
   power nor the recipients — the server rolls it and it lands on the whole
   field. Same one-per-tick budget as universal events, for the same reason. */
app.post('/api/events/power', requireAuth, requireRole(['admin', 'judge']), async (req, res, next) => { try {
  const result = await withTransaction(async client => {
    const game = await getGame(client);
    if (game.phase !== 'active') throw Object.assign(new Error(`The game is ${game.phase}.`), { status: 409, code: 'GAME_NOT_ACTIVE' });
    if (req.user.role === 'judge' && game.last_judge_event_tick === game.global_tick) {
      throw Object.assign(new Error('You have already used this tick\'s event. One per tick keeps it fair.'), { status: 409, code: 'EVENT_ALREADY_FIRED' });
    }
    const power = randomPower();
    const instanceId = `power_${power.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    await client.query(
      `INSERT INTO shocks(instance_id,shock_id,name,emoji,description,category,severity,
                          demand_effect,budget_effect,conversion_effect,duration,expires_at,target_team_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()+($11::integer * INTERVAL '1 minute'),NULL)`,
      [instanceId, power.id, power.name, power.emoji, power.description, power.category, power.severity,
        power.effect.demand, power.effect.budget, power.effect.conversion, power.duration]);
    await client.query('INSERT INTO shock_history(instance_id,deployed_at,target_team_id) VALUES($1,NOW(),NULL)', [instanceId]);
    await client.query('UPDATE game_state SET last_judge_event_tick=global_tick, updated_at=NOW() WHERE id=1');
    await logEvent(client, {
      actorType: req.user.role, actorId: req.user.id, actorName: req.user.name,
      round: game.round, tick: game.tick_in_round, kind: 'event.power',
      summary: `${req.user.name} granted a random power to every team: ${power.emoji} ${power.name}.`,
      payload: { powerId: power.id, effect: power.effect },
    });
    return { ...power, instanceId, universal: true };
  });
  ok(res, result, 201);
} catch (e) { if (e.status) return fail(res, e.status, e.code, e.message); next(e); } });

/* ---------------------------- Event log (admin) ---------------------------- */
app.get('/api/event-log', requireAuth, requireRole(['admin', 'judge']), async (req, res, next) => { try {
  const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit || '100', 10) || 100));
  const params = []; const where = [];
  if (req.query.teamId) { params.push(idOf(req.query.teamId)); where.push(`team_id=$${params.length}`); }
  if (req.query.kind) { params.push(req.query.kind); where.push(`kind=$${params.length}`); }
  params.push(limit);
  const { rows } = await pool.query(`SELECT * FROM event_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC LIMIT $${params.length}`, params);
  ok(res, rows.map(serializeLogRow));
} catch (e) { next(e); } });

app.get('/api/event-log/export.csv', requireAuth, requireRole(['admin', 'judge']), async (req, res, next) => { try {
  const { rows } = await pool.query('SELECT * FROM event_log ORDER BY at ASC');
  const header = 'at,actor_type,actor_id,actor_name,team_id,round,tick,kind,summary\n';
  const body = rows.map(r => [new Date(r.at).toISOString(), r.actor_type, r.actor_id || '', (r.actor_name || '').replace(/,/g, ' '), r.team_id || '', r.round ?? '', r.tick ?? '', r.kind, (r.summary || '').replace(/,/g, ';').replace(/\n/g, ' ')].join(',')).join('\n');
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', 'attachment; filename="event_log.csv"');
  res.send(header + body);
} catch (e) { next(e); } });

/* ---------------------------- Game control (admin only) ---------------------------- */
app.post('/api/game/reset', requireAuth, requireRole('admin'), async (req, res, next) => { try { await withTransaction(async client => { await client.query('DELETE FROM teams'); await client.query("UPDATE game_state SET phase='lobby',global_tick=0,round=1,tick_in_round=0,tick_deadline=NULL,game_start_time=NULL,updated_at=NOW() WHERE id=1"); await logEvent(client, { actorType: 'admin', actorId: req.user.id, actorName: req.user.name, kind: 'admin.reset', summary: 'Admin reset the arena — all teams removed.' }); }); ok(res, null); } catch (e) { next(e); } });
app.post('/api/game/halftime-shock', requireAuth, requireRole('admin'), async (req, res, next) => { try {
  const game = await getGame();
  if (game.halftime_shock_at) return fail(res, 409, 'ALREADY_FIRED', 'The halftime shock has already been fired.');
  const shock = getCatalogShock(req.body.shockId);
  if (!shock) return fail(res, 400, 'INVALID_SHOCK', 'Pick a shock from the catalog to fire as the halftime shock.');
  const instanceId = `halftime_${shock.id}_${Date.now()}`;
  let cut = null;
  await withTransaction(async client => {
    await client.query("UPDATE game_state SET halftime_shock_at=NOW(), pivot_deadline=NOW() + (pivot_window_minutes || ' minutes')::interval, updated_at=NOW() WHERE id=1");
    await client.query('INSERT INTO shocks(instance_id,shock_id,name,emoji,description,category,severity,demand_effect,budget_effect,conversion_effect,duration,expires_at,target_team_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()+($11::integer * INTERVAL \'1 minute\'),NULL)',
      [instanceId, shock.id, shock.name, shock.emoji, shock.description, shock.category, shock.severity, shock.effect.demand, shock.effect.budget, shock.effect.conversion, shock.duration]);
    await client.query('INSERT INTO shock_history(instance_id,deployed_at,target_team_id) VALUES($1,NOW(),NULL)', [instanceId]);
    await logEvent(client, { actorType: 'admin', actorId: req.user.id, actorName: req.user.name, round: game.round, kind: 'shock.halftime', summary: `HALFTIME SHOCK fired: ${shock.name}. Pre-shock document submissions are now locked.` });

    // The halftime cut runs with the shock: teams below the document-points
    // threshold are eliminated. Teams whose documents are merely UNRATED are
    // never cut here — they surface as `atRisk` for admin to resolve.
    cut = await judging.evaluateHalftimeCut(client, { dryRun: false });
    for (const t of cut.cut) {
      await logEvent(client, { actorType: 'admin', actorId: req.user.id, actorName: req.user.name, teamId: t.teamId, round: game.round, kind: 'team.disqualified', summary: `${t.teamName} disqualified at halftime: ${t.reason}` });
    }
  });
  ok(res, { ...shock, instanceId, halftime: true, cut }, 201);
} catch (e) { next(e); } });

/* Preview the halftime cut WITHOUT applying it — admin should always see who
   would be eliminated (and who is only at risk because their documents are
   still unrated) before pulling the trigger. */
app.get('/api/game/halftime-cut/preview', requireAuth, requireRole(['admin', 'judge']), async (req, res, next) => { try {
  ok(res, await withTransaction(c => judging.evaluateHalftimeCut(c, { dryRun: true })));
} catch (e) { next(e); } });

app.post('/api/game/halftime-threshold', requireAuth, requireRole('admin'), async (req, res, next) => { try {
  const { points, docs: minDocs } = req.body;
  if (points !== undefined && (!Number.isFinite(Number(points)) || Number(points) < 0)) return fail(res, 400, 'INVALID_POINTS', 'points must be a non-negative number.');
  if (minDocs !== undefined && (!Number.isInteger(Number(minDocs)) || Number(minDocs) < 0)) return fail(res, 400, 'INVALID_DOCS', 'docs must be a non-negative integer.');
  await withTransaction(async client => {
    if (points !== undefined) await client.query('UPDATE game_state SET halftime_min_points=$1, updated_at=NOW() WHERE id=1', [Number(points)]);
    if (minDocs !== undefined) await client.query('UPDATE game_state SET halftime_min_docs=$1, updated_at=NOW() WHERE id=1', [Number(minDocs)]);
    await logEvent(client, { actorType: 'admin', actorId: req.user.id, actorName: req.user.name, kind: 'game.halftime_threshold', summary: `Admin set the halftime cut to require ${minDocs ?? 'unchanged'} document(s) and ${points ?? 'unchanged'} points.` });
  });
  ok(res, await withTransaction(c => judging.evaluateHalftimeCut(c, { dryRun: true })));
} catch (e) { next(e); } });

app.post('/api/teams/:teamId/reinstate', requireAuth, requireRole('admin'), async (req, res, next) => { try {
  const teamId = idOf(req.params.teamId);
  await withTransaction(async client => {
    await client.query('UPDATE teams SET is_disqualified=FALSE, disqualified_at=NULL, disqualified_reason=NULL WHERE id=$1', [teamId]);
    await logEvent(client, { actorType: 'admin', actorId: req.user.id, actorName: req.user.name, teamId, kind: 'team.reinstate', summary: `Admin reinstated team ${teamId} after the halftime cut.` });
  });
  ok(res, null);
} catch (e) { next(e); } });

/* Re-time the pivot window on the fly (extend it if the room needs longer,
   or close it early once everyone is in). minutes counts from now. */
app.post('/api/game/pivot-window', requireAuth, requireRole('admin'), async (req, res, next) => { try {
  const minutes = Math.min(180, Math.max(0, Number(req.body.minutes)));
  if (!Number.isFinite(minutes)) return fail(res, 400, 'INVALID_MINUTES', 'minutes must be a number.');
  await withTransaction(async client => {
    await client.query(`UPDATE game_state SET pivot_deadline = NOW() + ($1 || ' minutes')::interval, updated_at=NOW() WHERE id=1`, [minutes]);
    await logEvent(client, { actorType: 'admin', actorId: req.user.id, actorName: req.user.name, kind: 'game.pivot_window', summary: `Admin set the pivot window to close in ${minutes} min.` });
  });
  ok(res, await loadSnapshot(req.user));
} catch (e) { next(e); } });

app.post('/api/game/grading-window', requireAuth, requireRole('admin'), async (req, res, next) => { try {
  const minutes = Number(req.body.minutes);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 120) return fail(res, 400, 'INVALID_MINUTES', 'minutes must be 0-120.');
  await withTransaction(async client => {
    await client.query('UPDATE game_state SET grading_minutes=$1, updated_at=NOW() WHERE id=1', [minutes]);
    await logEvent(client, { actorType: 'admin', actorId: req.user.id, actorName: req.user.name, kind: 'game.grading_window', summary: `Admin set the grading window to ${minutes} min per tick.` });
  });
  ok(res, await loadSnapshot(req.user));
} catch (e) { next(e); } });

/* Running late is normal at a live event — push every deadline for the
   current window rather than letting the tick fire on a half-empty queue. */
app.post('/api/game/extend', requireAuth, requireRole('admin'), async (req, res, next) => { try {
  const minutes = Math.min(60, Math.max(1, Number(req.body.minutes) || 5));
  await withTransaction(async client => {
    await client.query(`UPDATE game_state SET
        tick_deadline = COALESCE(tick_deadline, NOW()) + ($1 || ' minutes')::interval,
        submission_deadline = COALESCE(submission_deadline, NOW()) + ($1 || ' minutes')::interval,
        review_deadline = COALESCE(review_deadline, NOW()) + ($1 || ' minutes')::interval,
        updated_at=NOW() WHERE id=1`, [minutes]);
    await logEvent(client, { actorType: 'admin', actorId: req.user.id, actorName: req.user.name, kind: 'game.extend', summary: `Admin extended all deadlines for this window by ${minutes} min.` });
  });
  ok(res, await loadSnapshot(req.user));
} catch (e) { next(e); } });

app.post('/api/game/:action', requireAuth, requireRole('admin'), async (req, res, next) => { try { const actions = { start:['lobby','active'], pause:['active','paused'], resume:['paused','active'], end:[['active','paused'],'ended'] }; const transition = actions[req.params.action]; if (!transition) return fail(res, 400, 'INVALID_ACTION', 'Unknown game action.'); const game = await getGame(); const from = Array.isArray(transition[0]) ? transition[0] : [transition[0]]; if (!from.includes(game.phase)) return fail(res, 409, 'INVALID_GAME_TRANSITION', `Cannot ${req.params.action} the game while it is ${game.phase}.`); await withTransaction(async client => { await client.query(`UPDATE game_state SET phase=$1, game_start_time=COALESCE(game_start_time, CASE WHEN $1='active' THEN NOW() ELSE game_start_time END),
      tick_deadline = CASE WHEN $1='active' THEN NOW() + (tick_minutes || ' minutes')::interval ELSE tick_deadline END,
      submission_deadline = CASE WHEN $1='active' THEN NOW() + (GREATEST(tick_minutes - grading_minutes, 1) || ' minutes')::interval ELSE submission_deadline END,
      grading_deadline = CASE WHEN $1='active' THEN NOW() + (tick_minutes || ' minutes')::interval ELSE grading_deadline END,
      review_deadline = CASE WHEN $1='active' THEN NOW() + (GREATEST(tick_minutes - buffer_minutes, 2) || ' minutes')::interval ELSE review_deadline END,
      updated_at=NOW() WHERE id=1`, [transition[1]]); await logEvent(client, { actorType: 'admin', actorId: req.user.id, actorName: req.user.name, kind: 'game.phase', summary: `Admin ${req.params.action}ed the game (now ${transition[1]}).` }); }); ok(res, await loadSnapshot(req.user)); } catch (e) { next(e); } });
/* The halftime shock is its own action, not just another shock fire: it
   timestamps the moment, which permanently LOCKS every doc type marked
   due_before_shock (pitch deck, idea brief, GTM, compliance). Teams cannot
   retro-fit their pitch to a shock they have already seen. */
app.post('/api/game/round/advance', requireAuth, requireRole('admin'), async (req, res, next) => { try { await withTransaction(async client => { const game = await getGame(client); await client.query(`UPDATE game_state SET round=round+1, tick_in_round=0, ${SET_DEADLINES_SQL}, updated_at=NOW() WHERE id=1`); await logEvent(client, { actorType: 'admin', actorId: req.user.id, actorName: req.user.name, round: game.round + 1, kind: 'game.round_advance', summary: `Admin advanced the game to round ${game.round + 1}.` }); }); ok(res, await loadSnapshot(req.user)); } catch (e) { next(e); } });

/* ---------------------------- Shocks (admin only — judges do not touch game state) ---------------------------- */
app.post('/api/shocks/deploy', requireAuth, requireRole('admin'), async (req, res, next) => { try { const shock = getCatalogShock(req.body.shockId); if (!shock) return fail(res, 400, 'INVALID_SHOCK', 'Unknown shock.'); const target = req.body.targetTeamId ? idOf(req.body.targetTeamId) : null; if (!await validateTargetTeam(target)) return fail(res, 404, 'TEAM_NOT_FOUND', 'Target team not found.'); const instanceId = `${shock.id}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`; await withTransaction(async client => { await client.query('INSERT INTO shocks(instance_id,shock_id,name,emoji,description,category,severity,demand_effect,budget_effect,conversion_effect,duration,expires_at,target_team_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()+($11::integer * INTERVAL \'1 minute\'),$12)', [instanceId,shock.id,shock.name,shock.emoji,shock.description,shock.category,shock.severity,shock.effect.demand,shock.effect.budget,shock.effect.conversion,shock.duration,target]); await client.query('INSERT INTO shock_history(instance_id,deployed_at,target_team_id) VALUES($1,NOW(),$2)', [instanceId,target]); await logEvent(client, { actorType: 'admin', actorId: req.user.id, actorName: req.user.name, kind: 'shock.fire', summary: `Admin fired ${shock.name}${target ? ` at team ${target}` : ' at all teams'}.` }); }); ok(res, { ...shock, instanceId, targetTeamId: target ? String(target) : null }, 201); } catch (e) { next(e); } });
app.post('/api/shocks/custom', requireAuth, requireRole('admin'), async (req, res, next) => { try { const { name,description='',demandDelta=0,budgetDelta=0,conversionDelta=0,durationMins=2,targetTeamId=null } = req.body; const values = [Number(demandDelta),Number(budgetDelta),Number(conversionDelta),Number(durationMins)]; if (!String(name || '').trim() || !values.every(Number.isFinite) || values[3] < 1 || values[3] > 60 || values.slice(0,3).some(value => Math.abs(value) > 1000)) return fail(res,400,'INVALID_SHOCK','Shock values are invalid.'); const target = targetTeamId ? idOf(targetTeamId) : null; if (!await validateTargetTeam(target)) return fail(res, 404, 'TEAM_NOT_FOUND', 'Target team not found.'); const instanceId=`custom_${Date.now()}_${Math.random().toString(36).slice(2,7)}`; await withTransaction(async client => { await client.query('INSERT INTO shocks(instance_id,shock_id,name,emoji,description,category,severity,demand_effect,budget_effect,conversion_effect,duration,expires_at,target_team_id) VALUES($1,$2,$3,\'⚡\',$4,\'custom\',\'high\',$5,$6,$7,$8,NOW()+($8::integer * INTERVAL \'1 minute\'),$9)',[instanceId,instanceId,String(name).trim().slice(0,100),String(description).slice(0,500),...values,target]); await client.query('INSERT INTO shock_history(instance_id,deployed_at,target_team_id) VALUES($1,NOW(),$2)',[instanceId,target]); await logEvent(client, { actorType: 'admin', actorId: req.user.id, actorName: req.user.name, kind: 'shock.fire', summary: `Admin fired a custom shock "${name}".` }); }); ok(res,{ instanceId, targetTeamId: target ? String(target) : null },201); } catch(e){ next(e); } });
app.delete('/api/shocks/:instanceId', requireAuth, requireRole(['admin', 'judge']), async (req,res,next)=>{try{ await withTransaction(async client => { await client.query('UPDATE shocks SET resolved=true WHERE instance_id=$1',[req.params.instanceId]); await client.query('UPDATE shock_history SET resolved_at=NOW() WHERE instance_id=$1',[req.params.instanceId]); await logEvent(client, { actorType: 'admin', actorId: req.user.id, actorName: req.user.name, kind: 'shock.resolve', summary: `${req.user.name} cleared ${req.params.instanceId}.` }); }); ok(res,null); }catch(e){next(e);}});

/* ---------------------------- Round engine (admin-triggered tick) ----------------------------
   Runs ONE shared tick for every active team at once (REDESIGN.md §B.1).
   For each track: resolve any doc-review timeouts, load every team's
   pending Pricing Justification decision, compute the shared-pool
   attractiveness/share for every team on that track, then apply the tick.
   Approved -> the submitted numbers apply. Anything else (carried_over,
   rejected, never submitted) -> the team's current stored strategy repeats,
   unchanged (DOCS_SYSTEM.md §1). */
app.post('/api/engine/tick', requireAuth, requireRole('admin'), async (req, res, next) => { try {
  const force = req.body?.force === true || req.query.force === 'true';
  const result = await withTransaction(async client => {
    const game = await getGame(client);
    if (game.phase !== 'active') throw Object.assign(new Error(`The game is ${game.phase}.`), { status: 409, code: 'GAME_NOT_ACTIVE' });
    const nextTick = game.tick_in_round + 1;

    // GRADING GATE. The tick does not run until every judge has finished,
    // because document points feed the market — running early would compute
    // results from a half-graded field. Admin can force past this (a judge
    // going missing must not be able to deadlock the event), and the override
    // is logged loudly.
    const pending = await judging.pendingGrading(client, game.round, nextTick);
    if (!pending.complete && !force) {
      const err = new Error(
        `Grading is not finished — ${pending.undecided.length} pricing decision(s) and ` +
        `${pending.unrated.length} unrated document(s) outstanding. The tick will not run ` +
        `on a half-graded field. Finish grading, or force the tick if a judge is unavailable.`);
      err.status = 409; err.code = 'GRADING_INCOMPLETE'; err.pending = pending;
      throw err;
    }
    if (!pending.complete && force) {
      await logEvent(client, {
        actorType: 'admin', actorId: req.user.id, actorName: req.user.name,
        round: game.round, tick: nextTick, kind: 'tick.forced',
        summary: `Admin FORCED tick ${nextTick} with ${pending.total} item(s) still ungraded.`,
        payload: pending,
      });
    }

    // Anything still undecided for this tick is resolved now, per its
    // doc type's timeout policy (carry_over for pricing, auto_approve
    // for pivot) — never blocks the tick itself.
    await docs.resolveTimeouts(client, 'pricing_justification', game.round, nextTick);

    const teamsResult = await client.query('SELECT t.*, m.* FROM teams t JOIN team_market_state m ON m.team_id=t.id WHERE t.is_active=true AND t.is_disqualified=false FOR UPDATE OF m');
    const approvedDocs = (await client.query(
      "SELECT * FROM doc_submissions WHERE doc_type='pricing_justification' AND round=$1 AND tick=$2 AND status='approved' FOR UPDATE",
      [game.round, nextTick]
    )).rows;
    // Edge case: a team whose request was approved but who never clicked
    // Deploy before the deadline is AUTO-DEPLOYED here rather than losing
    // the tick — approval is the gate, not reaction time. A team that
    // already self-deployed has consumed_at set and is skipped entirely,
    // so a tick can never double-apply.
    const alreadyDeployed = new Set(approvedDocs.filter(d => d.consumed_at).map(d => String(d.team_id)));
    const approvedByTeam = new Map(approvedDocs.filter(d => !d.consumed_at).map(d => [String(d.team_id), d]));

    const activeShockRows = (await client.query('SELECT * FROM shocks WHERE resolved=false AND expires_at > NOW()')).rows;
    const shocksForEngine = activeShockRows.map(s => ({ shock_id: s.shock_id, demand: Number(s.demand_effect), budget: Number(s.budget_effect), conversion: Number(s.conversion_effect), trackMultipliers: null, targetTeamId: s.target_team_id ? String(s.target_team_id) : null }));

    const docScores = await docScoresByTeam(client);
    const byTrack = new Map();
    for (const row of teamsResult.rows) {
      // Teams who already deployed this tick themselves are excluded from
      // the engine's pass — but they stay in the pool for everyone else's
      // share calculation via `poolRowsByTrack` below.
      const trackId = row.track_id || row.category;
      if (!byTrack.has(trackId)) byTrack.set(trackId, []);
      byTrack.get(trackId).push(row);
    }

    const updates = [];
    for (const [trackId, rows] of byTrack) {
      const track = await getTrack(trackId, client);
      if (!track) continue;
      const prepared = rows.map(row => {
        const approved = approvedByTeam.get(String(row.id));
        const strategy = approved
          ? { productPrice: Number(approved.price), marketingSpend: Number(approved.marketing_spend), targetSegment: approved.target_segment }
          : { productPrice: Number(row.product_price), marketingSpend: Number(row.marketing_spend), targetSegment: row.target_segment };
        const shocksForTeam = shocksForEngine.filter(s => !s.targetTeamId || s.targetTeamId === String(row.id));
        const docScore = docScores.get(String(row.id)) ?? null;
        const { attractiveness } = attractivenessFor(row, track, strategy, shocksForTeam, row.quality_score, docScore);
        return { row, track, strategy, shocksForTeam, attractiveness, docScore };
      });
      // Shares are computed across EVERY team on the track, including ones
      // that already self-deployed, so the pool is never distorted by who
      // happened to click early.
      const shares = allocateSharedPool(prepared.map(p => ({ teamId: p.row.id, attractiveness: p.attractiveness })));
      for (const p of prepared) {
        if (alreadyDeployed.has(String(p.row.id))) continue; // already ran this tick
        const share = shares.get(p.row.id);
        const result = applyTick({ state: p.row, track: p.track, strategy: p.strategy, shocks: p.shocksForTeam, quality: p.row.quality_score, share, teamsOnTrack: rows.length, gameId: 'default', teamId: p.row.id, tick: game.global_tick + 1, docScore: p.docScore });
        const approvedRow = approvedByTeam.get(String(p.row.id));
        if (approvedRow) applyPenalty(result, Number(approvedRow.penalty_pct || 0));
        updates.push({ teamId: p.row.id, result, autoDeployed: Boolean(approvedRow) });
      }
    }

    for (const { teamId, result, autoDeployed } of updates) {
      await client.query(
        `UPDATE team_market_state SET
           tick=$1, budget=$2, debt=$3, is_insolvent=$4, product_price=$5, marketing_spend=$6, target_segment=$7,
           awareness=$8, active_customers=$9, reputation_scar=$10, demand_index=$11, conversion_rate=$12,
           units_sold=$13, total_units_sold=$14, total_revenue=$15, total_cost=$16, net_profit=$17,
           last_deployed_at=NOW(), deploy_count=$18, applied_shocks=$19, updated_at=NOW()
         WHERE team_id=$20`,
        [result.tick, result.budget, result.debt, result.isInsolvent, result.productPrice, result.marketingSpend, result.targetSegment,
          result.awareness, result.activeCustomers, result.reputationScar, result.demandIndex, result.conversionRate,
          result.unitsSold, result.totalUnitsSold, result.totalRevenue, result.totalCost, result.netProfit,
          result.deployCount, JSON.stringify(result.appliedShocks), teamId]
      );
      await client.query(
        `INSERT INTO market_history (team_id,tick,revenue,units_sold,demand,conversion,budget,price,marketing_spend,quality,target_segment,cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (team_id,tick) DO NOTHING`,
        [teamId, result.tick, result.revenue, result.unitsSold, result.demandIndex, result.conversionRate, result.budget, result.productPrice, result.marketingSpend, result.quality, result.targetSegment, result.cost]
      );
      // An approved-but-unclicked request is spent here, so it can't also be
      // deployed manually afterwards.
      if (autoDeployed) await client.query("UPDATE doc_submissions SET consumed_at=NOW() WHERE team_id=$1 AND doc_type='pricing_justification' AND round=$2 AND tick=$3", [teamId, game.round, nextTick]);
      await logEvent(client, {
        actorType: 'system', teamId, round: game.round, tick: nextTick,
        kind: autoDeployed ? 'tick.auto_deploy' : 'tick.carry_over',
        summary: autoDeployed
          ? `Tick ${nextTick} auto-deployed team ${teamId}'s approved strategy (never clicked Deploy): ${result.unitsSold} units, ₹${result.revenue.toFixed(0)}.`
          : `Tick ${nextTick} carried over team ${teamId}'s previous strategy (no approved request): ${result.unitsSold} units, ₹${result.revenue.toFixed(0)}.`,
        payload: result.decomposition,
      });
    }

    // Every team for this tick is now written — normalise them against each
    // other before the window closes.
    const tickNo = Number(game.global_tick) + 1;
    await normaliseTickScores(client, tickNo);
    // Results become visible to teams only now — the tick has run AND grading
    // was complete (or was explicitly forced by admin).
    await client.query('UPDATE game_state SET published_through_tick=$1 WHERE id=1', [tickNo]);

    await client.query(
      `UPDATE game_state SET global_tick=global_tick+1, tick_in_round=$1, ${SET_DEADLINES_SQL}, last_tick_at=NOW(), updated_at=NOW() WHERE id=1`,
      [nextTick]
    );
    await logEvent(client, { actorType: 'system', round: game.round, tick: nextTick, kind: 'tick.complete', summary: `Round ${game.round}, tick ${nextTick} complete for ${updates.length} teams.` });
    return { teamsUpdated: updates.length, round: game.round, tick: nextTick };
  });
  ok(res, result);
} catch (e) {
  if (e.code === 'GRADING_INCOMPLETE') {
    return res.status(409).json({ success: false, error: { code: e.code, message: e.message, pending: e.pending } });
  }
  if (e.status) return fail(res, e.status, e.code, e.message);
  next(e);
} });

/* What is still waiting on a judge — drives the admin's "can I run the tick
   yet" readout and the judges' own outstanding-work list. */
app.get('/api/grading/status', requireAuth, requireRole(['admin', 'judge']), async (req, res, next) => { try {
  const game = await getGame();
  const pending = await withTransaction(c => judging.pendingGrading(c, game.round, game.tick_in_round + 1));
  ok(res, {
    ...pending,
    round: game.round, tick: game.tick_in_round + 1,
    gradingDeadline: game.grading_deadline ? new Date(game.grading_deadline).getTime() : null,
    gradingMinutes: game.grading_minutes,
    serverNow: Date.now(),
  });
} catch (e) { next(e); } });

app.use(express.static(frontend));
app.get('*', (req, res, next) => {
  // Unknown /api/* paths must reach the API 404 below, not the SPA fallback.
  if (req.path.startsWith('/api/')) return next('route');
  res.sendFile(path.join(frontend, 'index.html'));
});
app.use('/api', (req, res) => fail(res, 404, 'NOT_FOUND', 'Unknown API route.'));
app.use((err, req, res, next) => { console.error(err); if (!res.headersSent) fail(res,500,'INTERNAL_ERROR','An unexpected server error occurred.'); });
const port = Number(process.env.PORT || 3000);
// When run directly (`npm start` / `npm run dev`) this file boots a long-lived
// server. On Vercel the app is instead exported below and served as a serverless
// handler by api/index.js, which owns database initialization.
if (require.main === module) {
  if (process.env.MOCK_DOC_SNAPSHOTS === '1') {
    console.warn('⚠️  MOCK_DOC_SNAPSHOTS=1 — document snapshots are FAKED. Test mode only, never run an event like this.');
  }
  initDb().then(() => app.listen(port, () => console.log(`Startup Survivor listening on http://localhost:${port}`))).catch(error => { console.error('Database initialization failed', error); process.exit(1); });
}
module.exports = app;
