/* ============================================================
   Append-only audit trail (SPEC.md §3). Every state-changing
   action calls logEvent() inside the SAME transaction as the
   action itself, so the log can never disagree with the data —
   there is no separate "did we remember to log this" step.
   ============================================================ */

/**
 * @param {import('pg').PoolClient} client - must be the same client/
 *   transaction performing the action being logged.
 * @param {object} e
 * @param {'system'|'admin'|'judge'|'team'} e.actorType
 * @param {string} [e.actorId]
 * @param {string} [e.actorName]
 * @param {number|string} [e.teamId]
 * @param {number} [e.round]
 * @param {number} [e.tick]
 * @param {string} e.kind - e.g. 'tick.run', 'doc.approve', 'shock.fire'
 * @param {string} e.summary - human-readable, shown in the admin firehose
 * @param {object} [e.payload]
 */
async function logEvent(client, e) {
  await client.query(
    `INSERT INTO event_log (actor_type, actor_id, actor_name, team_id, round, tick, kind, summary, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      e.actorType,
      e.actorId != null ? String(e.actorId) : null,
      e.actorName || null,
      e.teamId != null ? Number(e.teamId) : null,
      e.round != null ? Number(e.round) : null,
      e.tick != null ? Number(e.tick) : null,
      e.kind,
      e.summary,
      JSON.stringify(e.payload || {}),
    ]
  );
}

function serializeLogRow(row) {
  return {
    id: String(row.id),
    at: new Date(row.at).getTime(),
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorName: row.actor_name,
    teamId: row.team_id != null ? String(row.team_id) : null,
    round: row.round,
    tick: row.tick,
    kind: row.kind,
    summary: row.summary,
    payload: row.payload || {},
  };
}

module.exports = { logEvent, serializeLogRow };
