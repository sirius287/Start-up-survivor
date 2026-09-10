require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { pool, initDb, withTransaction } = require('./db');
const { issueSession, requireAuth, requireRole } = require('./middleware/auth');
const { CATEGORIES, initialState, runTick } = require('./services/market');
const { CATALOG, getCatalogShock, serialize } = require('./services/shocks');
const { QUALITY_ATTRIBUTES, compositeQuality } = require('./services/quality');
const { marketState, team } = require('./services/state');

const app = express();
// Behind Vercel's edge proxy (and any reverse proxy), trust the first hop so
// express-rate-limit reads the real client IP from X-Forwarded-For instead of
// throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set('trust proxy', 1);
const frontend = (() => {
  // Prefer the React build when present (client/dist), otherwise fall back to
  // the legacy static pages at the repo root.
  const dist = path.join(__dirname, '..', 'client', 'dist');
  try {
    require('fs').accessSync(path.join(dist, 'index.html'));
    return dist;
  } catch {
    return path.join(__dirname, '..');
  }
})();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
const authLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });
const validSegments = ['mass', 'premium', 'niche'];
const idOf = value => Number.parseInt(value, 10);

async function getGame(client = pool) { const { rows } = await client.query('SELECT * FROM game_state WHERE id=1'); return rows[0]; }
async function expireShocks(client = pool) { await client.query("UPDATE shocks SET resolved=true WHERE resolved=false AND expires_at <= NOW()"); await client.query("UPDATE shock_history SET resolved_at=NOW() WHERE resolved_at IS NULL AND instance_id IN (SELECT instance_id FROM shocks WHERE resolved=true)"); }
async function getActiveShocks(client = pool, teamId = null) { await expireShocks(client); const params = teamId ? [teamId] : []; const query = teamId ? 'SELECT * FROM shocks WHERE resolved=false AND expires_at > NOW() AND (target_team_id IS NULL OR target_team_id=$1) ORDER BY deployed_at DESC' : 'SELECT * FROM shocks WHERE resolved=false AND expires_at > NOW() ORDER BY deployed_at DESC'; const { rows } = await client.query(query, params); return rows.map(serialize); }
async function loadSnapshot(user) {
  await expireShocks();
  const game = await getGame();
  const teamsResult = await pool.query('SELECT * FROM teams WHERE is_active=true ORDER BY joined_at');
  const teams = teamsResult.rows.map(team);
  const states = {};
  const ids = user.role === 'team' ? [idOf(user.teamId)] : teams.map(t => idOf(t.id));
  for (const id of ids) { const result = await pool.query('SELECT m.*, jsonb_build_object(\'keyPartners\',b.key_partners,\'keyActivities\',b.key_activities,\'keyResources\',b.key_resources,\'valueProposition\',b.value_proposition,\'customerRelationships\',b.customer_relationships,\'channels\',b.channels,\'customerSegments\',b.customer_segments,\'costStructure\',b.cost_structure,\'revenueStreams\',b.revenue_streams) AS bmc FROM team_market_state m LEFT JOIN business_model_canvas b ON b.team_id=m.team_id WHERE m.team_id=$1', [id]); if (result.rows[0]) states[String(id)] = marketState(result.rows[0], result.rows[0].bmc); }
  const leaderboard = await getLeaderboard();
  const quality = {};
  if (user.role === 'judge') {
    for (const t of teams) { const q = await teamQuality(pool, idOf(t.id)); quality[t.id] = q; }
  } else if (user.role === 'team') {
    // Teams see their own attribute breakdown + every team's composite.
    for (const t of teams) {
      if (String(t.id) === String(user.teamId)) quality[t.id] = await teamQuality(pool, idOf(t.id));
      else { const composite = leaderboard.find(l => l.teamId === String(t.id))?.qualityScore ?? null; quality[t.id] = { scores: {}, composite }; }
    }
  }
  return { teams: user.role === 'team' ? teams.filter(t => t.id === String(user.teamId)) : teams, marketState: states, activeShocks: await getActiveShocks(pool, user.role === 'team' ? idOf(user.teamId) : null), shockHistory: user.role === 'judge' ? (await pool.query('SELECT s.* FROM shocks s ORDER BY deployed_at DESC LIMIT 100')).rows.map(serialize) : [], gamePhase: game.phase, gameStartTime: game.game_start_time ? new Date(game.game_start_time).getTime() : null, gameTick: game.global_tick, leaderboard, quality, qualityAttributes: QUALITY_ATTRIBUTES, lastUpdate: Date.now() };
}
async function teamQuality(client, teamId) {
  const { rows } = await client.query('SELECT attribute, score FROM judge_scores WHERE team_id=$1', [teamId]);
  const scores = {};
  for (const row of rows) scores[row.attribute] = Number(row.score);
  return { scores, composite: compositeQuality(scores) };
}
async function getLeaderboard() { const { rows } = await pool.query('SELECT t.id,t.team_name,t.startup_name,t.category,m.total_revenue,m.net_profit,m.budget,m.conversion_rate,m.total_units_sold,m.quality_score,m.tick FROM teams t JOIN team_market_state m ON m.team_id=t.id WHERE t.is_active=true ORDER BY m.total_revenue DESC'); return rows.map(row => ({ teamId: String(row.id), teamName: row.team_name, startupName: row.startup_name, category: row.category, totalRevenue: Number(row.total_revenue), netProfit: Number(row.net_profit), budget: Number(row.budget), convRate: Number(row.conversion_rate), unitsSold: Number(row.total_units_sold), qualityScore: row.quality_score == null ? null : Number(row.quality_score), tick: row.tick })); }
async function teamForUser(user, client = pool) { const { rows } = await client.query('SELECT * FROM teams WHERE id=$1 AND is_active=true', [idOf(user.teamId)]); return rows[0]; }
async function validateTargetTeam(targetTeamId, client = pool) { if (targetTeamId === null) return true; if (!Number.isInteger(targetTeamId)) return false; return Boolean((await client.query('SELECT 1 FROM teams WHERE id=$1 AND is_active=true', [targetTeamId])).rowCount); }
function validateStrategy(body) { const productPrice = Number(body.productPrice), marketingSpend = Number(body.marketingSpend), targetSegment = body.targetSegment; if (!Number.isFinite(productPrice) || productPrice < 50 || productPrice > 100000) return 'Product price must be between 50 and 100000.'; if (!Number.isFinite(marketingSpend) || marketingSpend < 0 || marketingSpend > 1000000) return 'Marketing spend must be between 0 and 1000000.'; if (!validSegments.includes(targetSegment)) return 'Invalid target segment.'; return null; }

app.get('/api/health', async (req, res) => { try { await pool.query('SELECT 1'); ok(res, { status: 'ok', database: 'connected' }); } catch { fail(res, 503, 'DATABASE_UNAVAILABLE', 'The database is unavailable.'); } });
app.post('/api/auth/team/register', authLimiter, async (req, res, next) => { try { const { teamName, startupName, category, tagline = '', password = '' } = req.body; if (!teamName || !startupName || !CATEGORIES[category] || password.length < 8) return fail(res, 400, 'INVALID_INPUT', 'Team, startup, category, and an 8-character password are required.'); const result = await withTransaction(async client => { const existing = await client.query('SELECT t.*,u.id AS user_id FROM teams t LEFT JOIN users u ON u.team_id=t.id WHERE LOWER(t.team_name)=LOWER($1)', [teamName.trim()]); if (existing.rows[0]) { const user = existing.rows[0]; if (!user.user_id || !(await bcrypt.compare(password, (await client.query('SELECT password_hash FROM users WHERE id=$1', [user.user_id])).rows[0].password_hash))) throw Object.assign(new Error('Team name or password is incorrect.'), { status: 409, code: 'TEAM_LOGIN_FAILED' }); return { id: user.id, teamId: user.id, role: 'team', team: team(user) }; } const created = await client.query('INSERT INTO teams(team_name,startup_name,category,tagline) VALUES($1,$2,$3,$4) RETURNING *', [teamName.trim(), startupName.trim(), category, tagline.trim()]); const t = created.rows[0], initial = initialState(category); await client.query('INSERT INTO users(team_id,role,password_hash) VALUES($1,\'team\',$2)', [t.id, await bcrypt.hash(password, 12)]); await client.query('INSERT INTO team_market_state(team_id,category,budget,max_budget,product_price,demand_index,base_demand,conversion_rate,base_conversion,burn_rate,demand_history,conversion_history) VALUES($1,$2,$3,$3,$4,$5,$5,$6,$6,$7,$8,$9)', [t.id, category, initial.budget, initial.productPrice, initial.demandIndex, initial.baseConversion, initial.burnRate, JSON.stringify([initial.demandIndex]), JSON.stringify([initial.baseConversion])]); await client.query('INSERT INTO business_model_canvas(team_id) VALUES($1)', [t.id]); return { id: t.id, teamId: t.id, role: 'team', team: team(t) }; }); issueSession(res, result); return ok(res, result, 201); } catch (e) { if (e.status) return fail(res, e.status, e.code, e.message); if (e && e.code === '23505') return fail(res, 409, 'TEAM_NAME_TAKEN', 'That team name was just taken. Try another name, or log in if it is yours.'); next(e); } });
app.post('/api/auth/team/login', authLimiter, async (req, res, next) => { try { const { teamName, password } = req.body; const { rows } = await pool.query('SELECT t.*,u.id user_id,u.password_hash FROM teams t JOIN users u ON u.team_id=t.id WHERE LOWER(t.team_name)=LOWER($1) AND t.is_active=true', [teamName || '']); if (!rows[0] || !(await bcrypt.compare(password || '', rows[0].password_hash))) return fail(res, 401, 'INVALID_CREDENTIALS', 'Team name or password is incorrect.'); const result = { id: rows[0].user_id, teamId: rows[0].id, role: 'team', team: team(rows[0]) }; issueSession(res, result); ok(res, result); } catch (e) { next(e); } });
app.post('/api/auth/judge/login', authLimiter, async (req, res) => { if (!process.env.JUDGE_PASSWORD_HASH || !(await bcrypt.compare(req.body.password || '', process.env.JUDGE_PASSWORD_HASH))) return fail(res, 401, 'INVALID_CREDENTIALS', 'Invalid judge credentials.'); const user = { id: 'judge', role: 'judge', name: 'Game Master' }; issueSession(res, user); ok(res, user); });
app.post('/api/auth/logout', (req, res) => { res.clearCookie('ss_session', { path: '/' }); ok(res, null); });
app.get('/api/auth/me', requireAuth, async (req, res) => ok(res, req.user));
app.get('/api/game/state', requireAuth, async (req, res, next) => { try { ok(res, await loadSnapshot(req.user)); } catch (e) { next(e); } });
app.get('/api/leaderboard', async (req, res, next) => { try { ok(res, await getLeaderboard()); } catch (e) { next(e); } });
app.get('/api/shocks', requireAuth, (req, res) => ok(res, CATALOG));
app.get('/api/shocks/active', requireAuth, async (req, res, next) => { try { ok(res, await getActiveShocks(pool, req.user.role === 'team' ? idOf(req.user.teamId) : null)); } catch (e) { next(e); } });
app.get('/api/shocks/history', requireAuth, requireRole('judge'), async (req, res, next) => { try { ok(res, (await pool.query('SELECT s.*, h.resolved_at FROM shocks s LEFT JOIN shock_history h ON h.instance_id=s.instance_id ORDER BY s.deployed_at DESC LIMIT 100')).rows.map(serialize)); } catch (e) { next(e); } });

app.get('/api/quality/attributes', requireAuth, (req, res) => ok(res, QUALITY_ATTRIBUTES));
app.get('/api/quality', requireAuth, requireRole('judge'), async (req, res, next) => { try { const teamsResult = await pool.query('SELECT * FROM teams WHERE is_active=true ORDER BY joined_at'); const out = {}; for (const t of teamsResult.rows) out[String(t.id)] = await teamQuality(pool, t.id); ok(res, out); } catch (e) { next(e); } });
app.get('/api/quality/:teamId', requireAuth, async (req, res, next) => { try { const teamId = idOf(req.params.teamId); if (req.user.role === 'team' && teamId !== idOf(req.user.teamId)) return fail(res, 403, 'FORBIDDEN', 'You can only view your own quality scores.'); if (!await validateTargetTeam(teamId)) return fail(res, 404, 'TEAM_NOT_FOUND', 'Team not found.'); const q = await teamQuality(pool, teamId); if (req.user.role === 'team') return ok(res, { composite: q.composite }); ok(res, q); } catch (e) { next(e); } });
app.post('/api/quality/:teamId', requireAuth, requireRole('judge'), async (req, res, next) => { try {
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
    for (const [attribute, score] of entries) await client.query('INSERT INTO judge_scores(team_id,attribute,score,updated_at) VALUES($1,$2,$3,NOW()) ON CONFLICT(team_id,attribute) DO UPDATE SET score=EXCLUDED.score,updated_at=NOW()', [teamId, attribute, score]);
    const rows = (await client.query('SELECT attribute, score FROM judge_scores WHERE team_id=$1', [teamId])).rows;
    const scores = {}; for (const row of rows) scores[row.attribute] = Number(row.score);
    const next = compositeQuality(scores);
    await client.query('UPDATE team_market_state SET quality_score=$1,quality_updated_at=NOW(),updated_at=NOW() WHERE team_id=$2', [next, teamId]);
    return next;
  });
  ok(res, { ...(await teamQuality(pool, teamId)), composite });
} catch (e) { next(e); } });

app.post('/api/teams/:teamId/deploy', requireAuth, requireRole('team'), async (req, res, next) => { try { const teamId = idOf(req.params.teamId); if (teamId !== idOf(req.user.teamId)) return fail(res, 403, 'FORBIDDEN', 'You can only deploy for your own team.'); const validation = validateStrategy(req.body); if (validation) return fail(res, 400, 'INVALID_STRATEGY', validation); const updated = await withTransaction(async client => { const game = await getGame(client); if (game.phase !== 'active') { const error = new Error(`The game is ${game.phase}.`); error.status = 409; error.code = `GAME_NOT_${game.phase.toUpperCase()}`; throw error; } const stateResult = await client.query('SELECT * FROM team_market_state WHERE team_id=$1 FOR UPDATE', [teamId]); if (!stateResult.rows[0]) throw Object.assign(new Error('Team not found.'), { status: 404, code: 'TEAM_NOT_FOUND' }); const shocks = await getActiveShocks(client, teamId); const qualityRow = (await client.query('SELECT quality_score FROM team_market_state WHERE team_id=$1', [teamId])).rows[0]; const strategy = { productPrice: Number(req.body.productPrice), marketingSpend: Number(req.body.marketingSpend), targetSegment: req.body.targetSegment, quality: qualityRow?.quality_score }; const result = runTick(stateResult.rows[0], shocks.map(s => ({ ...s, shock_id: s.id, demand_effect: s.effect.demand, budget_effect: s.effect.budget, conversion_effect: s.effect.conversion })), strategy); const old = stateResult.rows[0]; const revenueHistory = [...(old.revenue_history || [0]), result.revenue].slice(-20), unitsHistory = [...(old.units_history || [0]), result.units].slice(-20), demandHistory = [...(old.demand_history || []), result.demand].slice(-20), conversionHistory = [...(old.conversion_history || []), result.conversion].slice(-20); await client.query('UPDATE team_market_state SET tick=$1,budget=$2,product_price=$3,marketing_spend=$4,target_segment=$5,demand_index=$6,conversion_rate=$7,units_sold=$8,total_units_sold=$9,total_revenue=$10,total_cost=$11,net_profit=$12,last_deployed_at=NOW(),deploy_count=$13,revenue_history=$14,units_history=$15,demand_history=$16,conversion_history=$17,applied_shocks=$18,quality_score=$19,quality_updated_at=CASE WHEN $19::numeric IS NULL THEN quality_updated_at ELSE NOW() END,updated_at=NOW() WHERE team_id=$20', [result.tick,result.budget,result.productPrice,result.marketingSpend,result.targetSegment,result.demandIndex,result.conversionRate,result.units,result.totalUnitsSold,result.totalRevenue,result.totalCost,result.netProfit,result.deployCount,JSON.stringify(revenueHistory),JSON.stringify(unitsHistory),JSON.stringify(demandHistory),JSON.stringify(conversionHistory),JSON.stringify(result.appliedShocks),result.quality,teamId]); await client.query('INSERT INTO market_history(team_id,tick,revenue,units_sold,demand,conversion,budget,price,marketing_spend,quality) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [teamId,result.tick,result.revenue,result.units,result.demandIndex,result.conversionRate,result.budget,result.productPrice,result.marketingSpend,result.quality]); return result; }); ok(res, updated); } catch (e) { if (e.status) return fail(res, e.status, e.code, e.message); next(e); } });
app.get('/api/teams/:teamId', requireAuth, async (req, res, next) => { try { const teamId = idOf(req.params.teamId); if (req.user.role === 'team' && teamId !== idOf(req.user.teamId)) return fail(res, 403, 'FORBIDDEN', 'You can only view your own team.'); const result = await pool.query('SELECT * FROM teams WHERE id=$1 AND is_active=true', [teamId]); if (!result.rows[0]) return fail(res, 404, 'TEAM_NOT_FOUND', 'Team not found.'); ok(res, team(result.rows[0])); } catch (e) { next(e); } });
app.get('/api/teams/:teamId/market', requireAuth, async (req, res, next) => { try { const teamId = idOf(req.params.teamId); if (req.user.role === 'team' && teamId !== idOf(req.user.teamId)) return fail(res, 403, 'FORBIDDEN', 'You can only view your own market state.'); const result = await pool.query('SELECT * FROM team_market_state WHERE team_id=$1', [teamId]); if (!result.rows[0]) return fail(res, 404, 'TEAM_NOT_FOUND', 'Team not found.'); ok(res, marketState(result.rows[0])); } catch (e) { next(e); } });
app.patch('/api/teams/:teamId/market', requireAuth, requireRole('team'), async (req, res) => { if (idOf(req.params.teamId) !== idOf(req.user.teamId)) return fail(res, 403, 'FORBIDDEN', 'You can only edit your own market settings.'); const validation = validateStrategy({ ...req.body, targetSegment: req.body.targetSegment || 'mass' }); if (validation) return fail(res, 400, 'INVALID_MARKET', validation); await pool.query('UPDATE team_market_state SET product_price=$1,marketing_spend=$2,target_segment=$3,updated_at=NOW() WHERE team_id=$4', [req.body.productPrice, req.body.marketingSpend, req.body.targetSegment, idOf(req.user.teamId)]); ok(res, null); });
app.patch('/api/teams/:teamId/bmc', requireAuth, requireRole('team'), async (req, res) => { if (idOf(req.params.teamId) !== idOf(req.user.teamId)) return fail(res, 403, 'FORBIDDEN', 'You can only edit your own canvas.'); const fields = ['keyPartners','keyActivities','keyResources','valueProposition','customerRelationships','channels','customerSegments','costStructure','revenueStreams']; if (!fields.includes(req.body.field)) return fail(res, 400, 'INVALID_FIELD', 'Invalid canvas field.'); const column = { keyPartners:'key_partners',keyActivities:'key_activities',keyResources:'key_resources',valueProposition:'value_proposition',customerRelationships:'customer_relationships',channels:'channels',customerSegments:'customer_segments',costStructure:'cost_structure',revenueStreams:'revenue_streams' }[req.body.field]; await pool.query(`UPDATE business_model_canvas SET ${column}=$1,updated_at=NOW() WHERE team_id=$2`, [String(req.body.value || '').slice(0, 2000), idOf(req.user.teamId)]); ok(res, null); });

app.get('/api/teams', requireAuth, requireRole('judge'), async (req, res, next) => { try { const rows = (await pool.query('SELECT * FROM teams WHERE is_active=true ORDER BY joined_at')).rows; return ok(res, rows.map(team)); } catch (e) { next(e); } });
app.post('/api/game/reset', requireAuth, requireRole('judge'), async (req, res, next) => { try { await withTransaction(async client => { await client.query('DELETE FROM teams'); await client.query("UPDATE game_state SET phase='lobby',global_tick=0,game_start_time=NULL,updated_at=NOW() WHERE id=1"); }); ok(res, null); } catch (e) { next(e); } });
app.post('/api/game/:action', requireAuth, requireRole('judge'), async (req, res, next) => { try { const actions = { start:['lobby','active'], pause:['active','paused'], resume:['paused','active'], end:[['active','paused'],'ended'] }; const transition = actions[req.params.action]; if (!transition) return fail(res, 400, 'INVALID_ACTION', 'Unknown game action.'); const game = await getGame(); const from = Array.isArray(transition[0]) ? transition[0] : [transition[0]]; if (!from.includes(game.phase)) return fail(res, 409, 'INVALID_GAME_TRANSITION', `Cannot ${req.params.action} the game while it is ${game.phase}.`); await pool.query('UPDATE game_state SET phase=$1,game_start_time=COALESCE(game_start_time,CASE WHEN $1=\'active\' THEN NOW() ELSE game_start_time END),updated_at=NOW() WHERE id=1', [transition[1]]); ok(res, await loadSnapshot(req.user)); } catch (e) { next(e); } });
app.post('/api/shocks/deploy', requireAuth, requireRole('judge'), async (req, res, next) => { try { const shock = getCatalogShock(req.body.shockId); if (!shock) return fail(res, 400, 'INVALID_SHOCK', 'Unknown shock.'); const target = req.body.targetTeamId ? idOf(req.body.targetTeamId) : null; if (!await validateTargetTeam(target)) return fail(res, 404, 'TEAM_NOT_FOUND', 'Target team not found.'); const instanceId = `${shock.id}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`; await withTransaction(async client => { await client.query('INSERT INTO shocks(instance_id,shock_id,name,emoji,description,category,severity,demand_effect,budget_effect,conversion_effect,duration,expires_at,target_team_id,deployed_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()+($11::integer * INTERVAL \'1 minute\'),$12,$13)', [instanceId,shock.id,shock.name,shock.emoji,shock.description,shock.category,shock.severity,shock.effect.demand,shock.effect.budget,shock.effect.conversion,shock.duration,target,req.user.sub === 'judge' ? null : idOf(req.user.sub)]); await client.query('INSERT INTO shock_history(instance_id,deployed_at,target_team_id,deployed_by) VALUES($1,NOW(),$2,$3)', [instanceId,target,req.user.sub === 'judge' ? null : idOf(req.user.sub)]); }); ok(res, { ...shock, instanceId, targetTeamId: target ? String(target) : null }, 201); } catch (e) { next(e); } });
app.post('/api/shocks/custom', requireAuth, requireRole('judge'), async (req, res, next) => { try { const { name,description='',demandDelta=0,budgetDelta=0,conversionDelta=0,durationMins=2,targetTeamId=null } = req.body; const values = [Number(demandDelta),Number(budgetDelta),Number(conversionDelta),Number(durationMins)]; if (!String(name || '').trim() || !values.every(Number.isFinite) || values[3] < 1 || values[3] > 60 || values.slice(0,3).some(value => Math.abs(value) > 1000)) return fail(res,400,'INVALID_SHOCK','Shock values are invalid.'); const target = targetTeamId ? idOf(targetTeamId) : null; if (!await validateTargetTeam(target)) return fail(res, 404, 'TEAM_NOT_FOUND', 'Target team not found.'); const instanceId=`custom_${Date.now()}_${Math.random().toString(36).slice(2,7)}`; await withTransaction(async client => { await client.query('INSERT INTO shocks(instance_id,shock_id,name,emoji,description,category,severity,demand_effect,budget_effect,conversion_effect,duration,expires_at,target_team_id) VALUES($1,$2,$3,\'⚡\',$4,\'custom\',\'high\',$5,$6,$7,$8,NOW()+($8::integer * INTERVAL \'1 minute\'),$9)',[instanceId,instanceId,String(name).trim().slice(0,100),String(description).slice(0,500),...values,target]); await client.query('INSERT INTO shock_history(instance_id,deployed_at,target_team_id) VALUES($1,NOW(),$2)',[instanceId,target]); }); ok(res,{ instanceId, targetTeamId: target ? String(target) : null },201); } catch(e){ next(e); } });
app.delete('/api/shocks/:instanceId', requireAuth, requireRole('judge'), async (req,res,next)=>{try{await pool.query('UPDATE shocks SET resolved=true WHERE instance_id=$1',[req.params.instanceId]); await pool.query('UPDATE shock_history SET resolved_at=NOW() WHERE instance_id=$1',[req.params.instanceId]); ok(res,null);}catch(e){next(e);}});

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
  initDb().then(() => app.listen(port, () => console.log(`Startup Survivor listening on http://localhost:${port}`))).catch(error => { console.error('Database initialization failed', error); process.exit(1); });
}
module.exports = app;
