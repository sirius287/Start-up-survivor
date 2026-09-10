/* ============================================================
   Judge allocation, multi-judge aggregation, and normalization.

   Two modes, locked at the first tick so it can never flip
   mid-event (19 teams -> 21 teams):

     'all'         (< PARTITION_THRESHOLD teams)
                   every judge scores every team; a team's score
                   is the MEAN of the judges who scored it.

     'partitioned' (>= PARTITION_THRESHOLD teams)
                   teams are split evenly and deterministically
                   between judges. Because a team is then seen by
                   only one judge, raw scores are Z-SCORE
                   NORMALIZED per judge before combining — without
                   that, drawing a harsh judge is a penalty the
                   team did nothing to earn.
   ============================================================ */

const { compositeQuality, QUALITY_ATTRIBUTES } = require('./quality');

const PARTITION_THRESHOLD = Number(process.env.JUDGE_PARTITION_THRESHOLD || 20);

/** Decide (and remember) the judging mode. Called once, at the first tick. */
async function resolveJudgingMode(client) {
  const game = (await client.query('SELECT judging_mode FROM game_state WHERE id=1')).rows[0];
  if (game?.judging_mode) return game.judging_mode;
  const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM teams WHERE is_active = TRUE');
  const mode = (rows[0]?.n || 0) >= PARTITION_THRESHOLD ? 'partitioned' : 'all';
  await client.query('UPDATE game_state SET judging_mode=$1, updated_at=NOW() WHERE id=1', [mode]);
  return mode;
}

/**
 * Rebuilds the judge→team allocation. Deterministic: teams are ordered by id
 * and dealt round-robin to judges ordered by env_slot, so the same roster
 * always produces the same split and 22 teams across 3 judges lands 8/7/7.
 * A judge with no assignment (e.g. added late) simply picks up their share
 * on the next rebuild.
 */
async function rebuildAssignments(client) {
  const judges = (await client.query('SELECT id FROM judges WHERE is_active = TRUE AND env_slot <> 0 ORDER BY env_slot')).rows;
  const teams = (await client.query('SELECT id FROM teams WHERE is_active = TRUE ORDER BY id')).rows;
  await client.query('DELETE FROM judge_assignments');
  if (judges.length === 0 || teams.length === 0) return { judges: judges.length, teams: teams.length, assigned: 0 };

  let assigned = 0;
  for (let i = 0; i < teams.length; i++) {
    const judge = judges[i % judges.length];
    await client.query(
      'INSERT INTO judge_assignments (judge_id, team_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [judge.id, teams[i].id]
    );
    assigned++;
  }
  return { judges: judges.length, teams: teams.length, assigned };
}

/** Assign one newly-registered team to whichever judge currently has fewest. */
async function assignTeamToLightestJudge(client, teamId) {
  const { rows } = await client.query(`
    SELECT j.id, COUNT(ja.team_id) AS load
      FROM judges j
      LEFT JOIN judge_assignments ja ON ja.judge_id = j.id
     WHERE j.is_active = TRUE AND j.env_slot <> 0
     GROUP BY j.id
     ORDER BY load ASC, j.id ASC
     LIMIT 1`);
  if (!rows[0]) return null;
  await client.query('INSERT INTO judge_assignments (judge_id, team_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [rows[0].id, teamId]);
  return Number(rows[0].id);
}

/** Team ids this judge is responsible for. In 'all' mode: everyone. */
async function teamsForJudge(client, judgeId, mode) {
  if (mode !== 'partitioned') {
    const { rows } = await client.query('SELECT id FROM teams WHERE is_active = TRUE ORDER BY id');
    return rows.map(r => String(r.id));
  }
  const { rows } = await client.query(
    'SELECT team_id AS id FROM judge_assignments WHERE judge_id = $1 ORDER BY team_id', [judgeId]
  );
  return rows.map(r => String(r.id));
}

/** mean/stddev of a numeric array (population stddev; 0 when n < 2). */
function stats(values) {
  const n = values.length;
  if (n === 0) return { mean: 0, sd: 0, n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, sd: 0, n };
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { mean, sd: Math.sqrt(variance), n };
}

/**
 * Team composites from per-judge rubric scores.
 *
 * 'all' mode        -> straight mean of each judge's composite for that team.
 * 'partitioned'     -> each judge's composites are z-scored against that
 *                      judge's OWN distribution, then mapped back onto the
 *                      1-10 scale using the panel-wide mean/spread. A judge
 *                      who marks everything 6-8 and one who ranges 2-10 then
 *                      contribute comparably.
 *
 * A judge who scored fewer than 2 teams has no usable spread, so their raw
 * composite is used as-is rather than invented.
 */
async function teamComposites(client, mode) {
  const { rows } = await client.query(`
    SELECT judge_id, team_id, attribute, score
      FROM judge_scores
     WHERE judge_id IS NOT NULL`);

  // judge -> team -> {attribute: score}
  const byJudge = new Map();
  for (const r of rows) {
    const j = String(r.judge_id), t = String(r.team_id);
    if (!byJudge.has(j)) byJudge.set(j, new Map());
    const teams = byJudge.get(j);
    if (!teams.has(t)) teams.set(t, {});
    teams.get(t)[r.attribute] = Number(r.score);
  }

  // Per judge: composite per team.
  const judgeComposites = new Map(); // judge -> Map(team -> composite)
  for (const [j, teams] of byJudge) {
    const m = new Map();
    for (const [t, scores] of teams) {
      const c = compositeQuality(scores);
      if (c != null) m.set(t, c);
    }
    judgeComposites.set(j, m);
  }

  const perTeam = new Map(); // team -> [adjusted composites]
  const perTeamRaw = new Map(); // team -> [raw composites], for admin visibility

  if (mode === 'partitioned') {
    // Panel-wide reference distribution across every composite given.
    const all = [];
    for (const m of judgeComposites.values()) all.push(...m.values());
    const panel = stats(all);

    for (const [, m] of judgeComposites) {
      const own = stats([...m.values()]);
      for (const [t, c] of m) {
        let adjusted = c;
        if (own.n >= 2 && own.sd > 0 && panel.sd > 0) {
          const z = (c - own.mean) / own.sd;
          adjusted = panel.mean + z * panel.sd;
        }
        adjusted = Math.max(1, Math.min(10, adjusted));
        if (!perTeam.has(t)) perTeam.set(t, []);
        if (!perTeamRaw.has(t)) perTeamRaw.set(t, []);
        perTeam.get(t).push(adjusted);
        perTeamRaw.get(t).push(c);
      }
    }
  } else {
    for (const [, m] of judgeComposites) {
      for (const [t, c] of m) {
        if (!perTeam.has(t)) perTeam.set(t, []);
        if (!perTeamRaw.has(t)) perTeamRaw.set(t, []);
        perTeam.get(t).push(c);
        perTeamRaw.get(t).push(c);
      }
    }
  }

  const out = {};
  for (const [t, list] of perTeam) {
    const raw = perTeamRaw.get(t) || [];
    const spread = raw.length > 1 ? Math.max(...raw) - Math.min(...raw) : 0;
    out[t] = {
      composite: Number((list.reduce((a, b) => a + b, 0) / list.length).toFixed(2)),
      judgeCount: list.length,
      rawScores: raw.map(v => Number(v.toFixed(2))),
      // Flagged for admin: judges disagreeing by more than 3 points on the
      // same team is worth a second look before results are frozen.
      disagreement: Number(spread.toFixed(2)),
      flagged: spread > 3,
    };
  }
  return out;
}

/** A team's own rubric scores from one specific judge (for the edit form). */
async function scoresByJudge(client, judgeId, teamId) {
  const { rows } = await client.query(
    'SELECT attribute, score FROM judge_scores WHERE judge_id=$1 AND team_id=$2', [judgeId, teamId]
  );
  const scores = {};
  for (const r of rows) scores[r.attribute] = Number(r.score);
  return scores;
}

/** Aggregate document ratings (mean across judges) onto the submission. */
async function recomputeDocPoints(client, submissionId) {
  const { rows } = await client.query(
    'SELECT AVG(points)::numeric AS avg_points, COUNT(*)::int AS n FROM doc_ratings WHERE submission_id=$1',
    [submissionId]
  );
  const avg = rows[0]?.n > 0 ? Number(Number(rows[0].avg_points).toFixed(2)) : null;
  await client.query('UPDATE doc_submissions SET points=$1 WHERE id=$2', [avg, submissionId]);
  return { points: avg, raters: rows[0]?.n || 0 };
}

/**
 * The halftime cut. Teams whose RATED pre-halftime document points fall below
 * the threshold are disqualified.
 *
 * Two deliberate safety rails, because this permanently ends a team's event:
 *  - Only documents that a judge has actually RATED count. A team whose docs
 *    are submitted but still unrated is never cut — that would punish them
 *    for the judging queue being slow, which is not their fault.
 *  - Those teams are returned as `atRisk` instead, so admin can chase the
 *    rating before confirming the cut.
 */
async function evaluateHalftimeCut(client, { dryRun = false } = {}) {
  const cfg = (await client.query('SELECT halftime_min_docs, halftime_min_points FROM game_state WHERE id=1')).rows[0] || {};
  const minDocs = Number(cfg.halftime_min_docs ?? 1);
  const minPoints = Number(cfg.halftime_min_points ?? 0);

  const ceiling = Number((await client.query(
    "SELECT COALESCE(SUM(max_points),0) AS total FROM doc_types WHERE is_active AND due_before_shock AND max_points > 0"
  )).rows[0]?.total || 0);

  const { rows } = await client.query(`
    SELECT t.id, t.team_name,
           COUNT(ds.id)                                                    AS submitted,
           COALESCE(SUM(COALESCE(ds.points, 0)), 0)                        AS rated_points,
           COUNT(*) FILTER (WHERE ds.id IS NOT NULL AND ds.points IS NULL)  AS awaiting_rating
      FROM teams t
      CROSS JOIN doc_types dt
      LEFT JOIN doc_submissions ds ON ds.team_id = t.id AND ds.doc_type = dt.id
     WHERE t.is_active = TRUE AND t.is_disqualified = FALSE
       AND dt.is_active = TRUE AND dt.due_before_shock = TRUE AND dt.max_points > 0
     GROUP BY t.id, t.team_name
     ORDER BY t.id`);

  const cut = [], atRisk = [], safe = [];
  for (const r of rows) {
    const entry = {
      teamId: String(r.id), teamName: r.team_name,
      submitted: Number(r.submitted),
      points: Number(r.rated_points),
      awaitingRating: Number(r.awaiting_rating),
      reason: null,
    };

    // Rule 1 (primary): did they submit anything at all before halftime?
    if (entry.submitted < minDocs) {
      entry.reason = `Submitted ${entry.submitted} of the ${minDocs} document(s) required before halftime.`;
      cut.push(entry);
      continue;
    }
    // Rule 2 (optional quality bar, off by default): enough rated points?
    if (minPoints > 0 && entry.points < minPoints) {
      if (entry.awaitingRating > 0) {
        // Never cut a team for a rating the judges have not done yet.
        entry.reason = `Below ${minPoints} points, but ${entry.awaitingRating} document(s) are still unrated.`;
        atRisk.push(entry);
      } else {
        entry.reason = `${entry.points} of ${minPoints} required document points.`;
        cut.push(entry);
      }
      continue;
    }
    safe.push(entry);
  }

  if (!dryRun) {
    for (const t of cut) {
      await client.query(
        `UPDATE teams SET is_disqualified = TRUE, disqualified_at = NOW(), disqualified_reason = $2 WHERE id = $1`,
        [t.teamId, `Halftime cut: ${t.reason}`]
      );
    }
  }
  return { minDocs, minPoints, ceiling, cut, atRisk, safe, dryRun };
}

module.exports = {
  evaluateHalftimeCut,
  PARTITION_THRESHOLD, resolveJudgingMode, rebuildAssignments, assignTeamToLightestJudge,
  teamsForJudge, teamComposites, scoresByJudge, recomputeDocPoints, stats,
};
