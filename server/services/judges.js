/* ============================================================
   Judges, defined entirely from environment variables.
   No signup, no admin "create judge" UI, no DB write needed to
   add a judge — set two env vars and redeploy/restart.

   Pattern (as many as you want, numbered from 1):
     JUDGE_1_NAME=Priya Sharma
     JUDGE_1_CODE=PIVOT1
     JUDGE_2_NAME=Rahul Mehta
     JUDGE_2_CODE=SHOCK2
     JUDGE_3_NAME=...
     JUDGE_3_CODE=...
   ...and so on. However many JUDGE_N_NAME/JUDGE_N_CODE pairs exist,
   that many judges exist — nothing else in the app needs to change.

   CODE is a short access phrase a judge types on the /judge login
   screen (SPEC.md §4.2 — no password, so faculty on a phone aren't
   fighting a keyboard). It is not a secret in the bcrypt sense: it's
   a handout code for a few hours, so plain text in env is fine and
   is what makes it easy to print/QR-code for check-in.
   ============================================================ */

const NAME_PREFIX = 'JUDGE_';
const NAME_SUFFIX = '_NAME';
const CODE_SUFFIX = '_CODE';
const MAX_SCAN = 500; // sanity bound; nobody has 500 judges

/**
 * Reads every JUDGE_<n>_NAME / JUDGE_<n>_CODE pair out of env,
 * for n = 1..MAX_SCAN. Gaps are allowed (JUDGE_2 can be absent while
 * JUDGE_3 exists) so removing a judge mid-setup doesn't renumber
 * everyone else. A half-defined pair (NAME with no CODE, or vice
 * versa) is a config mistake and fails loudly at boot rather than
 * silently dropping a judge.
 *
 * Returns: [{ n, name, code }], code trimmed and upper-cased for
 * case-insensitive login.
 */
function loadJudgesFromEnv(env = process.env) {
  const judges = [];
  const seenCodes = new Map(); // normalized code -> which JUDGE_n defined it first

  for (let n = 1; n <= MAX_SCAN; n++) {
    const name = env[`${NAME_PREFIX}${n}${NAME_SUFFIX}`];
    const code = env[`${NAME_PREFIX}${n}${CODE_SUFFIX}`];
    if (name === undefined && code === undefined) continue; // gap, keep scanning

    if (!name || !name.trim()) {
      throw new Error(`JUDGE_${n}_CODE is set but JUDGE_${n}_NAME is missing.`);
    }
    if (!code || !code.trim()) {
      throw new Error(`JUDGE_${n}_NAME is set but JUDGE_${n}_CODE is missing.`);
    }

    const normalizedCode = code.trim().toUpperCase();
    if (normalizedCode.length < 4) {
      throw new Error(`JUDGE_${n}_CODE ("${code}") is too short — use at least 4 characters.`);
    }
    if (seenCodes.has(normalizedCode)) {
      throw new Error(
        `JUDGE_${n}_CODE collides with JUDGE_${seenCodes.get(normalizedCode)}_CODE ` +
        `(both normalize to "${normalizedCode}"). Every judge needs a unique code.`
      );
    }
    seenCodes.set(normalizedCode, n);

    judges.push({ n, name: name.trim(), code: normalizedCode });
  }

  return judges;
}

/**
 * Idempotent upsert: makes the `judges` table match whatever is
 * currently defined in env. Existing judges keep their id (and so
 * keep their claim/score history) as long as their env slot number
 * (`n`) doesn't change — renaming JUDGE_2's NAME/CODE updates the
 * same row; deleting JUDGE_2 from env deactivates that row rather
 * than deleting it, so historical scores/claims stay attributable.
 *
 * Call this once at boot (same place initDb() runs), inside a
 * transaction — cheap, and safe to re-run every restart.
 */
async function syncJudgesFromEnv(client, env = process.env) {
  const judges = loadJudgesFromEnv(env);
  const activeSlots = judges.map(j => j.n);

  for (const j of judges) {
    await client.query(
      `INSERT INTO judges (env_slot, name, code, is_active)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (env_slot) DO UPDATE
         SET name = EXCLUDED.name, code = EXCLUDED.code, is_active = TRUE`,
      [j.n, j.name, j.code]
    );
  }

  // Anything no longer defined in env is deactivated, not deleted —
  // it keeps existing claims/scores/reviewed_by references valid.
  // Slot 0 is the reserved admin row and is never deactivated here.
  if (activeSlots.length > 0) {
    await client.query(
      `UPDATE judges SET is_active = FALSE WHERE env_slot <> 0 AND env_slot != ALL($1::int[])`,
      [activeSlots]
    );
  } else {
    await client.query(`UPDATE judges SET is_active = FALSE WHERE env_slot <> 0`);
  }

  return judges.length;
}

/** Case/whitespace-insensitive code lookup for the /api/auth/judge/login route.
 *  Slot 0 (the reserved admin row) is excluded — it is not a login. */
async function findActiveJudgeByCode(client, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return null;
  const { rows } = await client.query(
    'SELECT id, name FROM judges WHERE code = $1 AND is_active = TRUE AND env_slot <> 0',
    [code]
  );
  return rows[0] || null;
}

/** The judges-row id that should be recorded for whoever is acting.
 *  Judges use their own row; the admin uses the reserved slot-0 row so an
 *  admin override is attributable without breaking the BIGINT foreign key. */
async function actingJudgeId(client, user) {
  if (user.role === 'judge') return Number(user.id);
  const { rows } = await client.query('SELECT id FROM judges WHERE env_slot = 0');
  return rows[0] ? Number(rows[0].id) : null;
}

module.exports = { loadJudgesFromEnv, syncJudgesFromEnv, findActiveJudgeByCode, actingJudgeId };
