/* ============================================================
   Document & review engine (DOCS_SYSTEM.md). One system reused
   for every doc type in the event: Idea Brief, GTM Plan,
   Financial Model, Compliance Note, Pricing Justification,
   Pivot Rationale, Retro.

   Submissions are Google Docs links. On every submit the server
   fetches a FROZEN PDF export and stores it as the actual
   reviewed/audited record (§2.1) — the live doc link is kept only
   as a courtesy "open to comment" convenience. This is what makes
   "just paste a link" safe: an edit to the live doc after approval
   cannot change what was judged, because judges review the
   snapshot, not the link.
   ============================================================ */

const crypto = require('crypto');

const COOLDOWN_MS = 10 * 60 * 1000;      // DOCS_SYSTEM.md §3
const MAX_VERSIONS = 3;                   // initial submit + 2 resubmissions
const CLAIM_TTL_MS = 3 * 60 * 1000;       // DOCS_SYSTEM.md §5

class DocError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const GOOGLE_DOC_RE = /^https:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/;

function extractGoogleDocId(url) {
  const match = GOOGLE_DOC_RE.exec(String(url || '').trim());
  if (!match) return null;
  return match[1];
}

/** Fetches the frozen PDF export for a publicly-viewable Google Doc.
 *  Requires no OAuth — works for any doc shared "Anyone with the link
 *  can view". A 401/403 means sharing is wrong; surfaced as a specific,
 *  actionable DocError so the team gets a real fix, not a generic failure. */
async function fetchGoogleDocSnapshot(docId) {
  // Test-only escape hatch: lets the e2e suite exercise the whole submission
  // pipeline without depending on a real, publicly-shared Google Doc. Never
  // set this in production — server.js warns loudly at boot if it is on.
  if (process.env.MOCK_DOC_SNAPSHOTS === '1') {
    if (String(docId).startsWith('denied')) throw new DocError('DOC_NOT_SHARED', "This doc isn't shared correctly. Open it → Share → General access → \"Anyone with the link\" → Viewer, then resubmit.", 422);
    return Buffer.from(`%PDF-1.4 mock snapshot for ${docId}`);
  }
  const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=pdf`;
  let res;
  try {
    res = await fetch(exportUrl, { redirect: 'follow' });
  } catch (err) {
    throw new DocError('SNAPSHOT_FETCH_FAILED', 'Could not reach Google Docs to fetch the document. Try again in a moment.', 502);
  }
  if (res.status === 401 || res.status === 403) {
    throw new DocError(
      'DOC_NOT_SHARED',
      "This doc isn't shared correctly. Open it → Share → General access → \"Anyone with the link\" → Viewer, then resubmit.",
      422
    );
  }
  if (!res.ok) {
    throw new DocError('SNAPSHOT_FETCH_FAILED', `Google Docs returned ${res.status} while exporting this document.`, 502);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new DocError('SNAPSHOT_EMPTY', 'The exported document was empty.', 422);
  return buf;
}

function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Submit (or resubmit) a document. Enforces the cooldown and the
 * resubmission cap, and — critically — only touches the DB row after a
 * successful snapshot fetch, so a sharing-permission failure never
 * consumes a resubmission slot or starts a cooldown (DOCS_SYSTEM.md §2.2).
 */
async function submitDoc(client, { teamId, docType, round, tick, docUrl, price, marketingSpend, targetSegment, isLate = false }) {
  const docId = extractGoogleDocId(docUrl);
  if (!docId) throw new DocError('INVALID_URL', 'Paste a Google Docs link (docs.google.com/document/d/...).', 400);

  // Must match on ROUND as well as tick: round 2 restarts tick numbering, so
  // matching on tick alone collides with the round-1 row (and its cooldown).
  const existing = (await client.query(
    `SELECT * FROM doc_submissions
      WHERE team_id=$1 AND doc_type=$2
        AND round IS NOT DISTINCT FROM $3
        AND tick  IS NOT DISTINCT FROM $4
      FOR UPDATE`,
    [teamId, docType, round ?? null, tick ?? null]
  )).rows[0];

  if (existing && new Date(existing.cooldown_until) > new Date()) {
    const waitSec = Math.ceil((new Date(existing.cooldown_until) - Date.now()) / 1000);
    throw new DocError('COOLDOWN_ACTIVE', `You can edit this submission again in ~${Math.ceil(waitSec / 60)} min.`, 429);
  }
  if (existing && existing.version >= MAX_VERSIONS && existing.status !== 'approved') {
    throw new DocError('RESUBMIT_LIMIT', 'This document has used all its revisions for this tick.', 409);
  }

  // Fetch BEFORE writing anything — a sharing/permission failure must not
  // consume a resubmission slot or start a cooldown.
  const snapshot = await fetchGoogleDocSnapshot(docId);
  const contentHash = hashBuffer(snapshot);
  const sameContentAsBefore = existing && existing.content_hash === contentHash;
  const cooldownUntil = new Date(Date.now() + COOLDOWN_MS);

  if (!existing) {
    const { rows } = await client.query(
      `INSERT INTO doc_submissions
         (team_id, doc_type, round, tick, version, doc_url, snapshot, content_hash,
          price, marketing_spend, target_segment, status, cooldown_until, is_late)
       VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,'submitted',$11,$12)
       RETURNING *`,
      [teamId, docType, round ?? null, tick ?? null, docUrl, snapshot, contentHash,
        price ?? null, marketingSpend ?? null, targetSegment ?? null, cooldownUntil, isLate]
    );
    return rows[0];
  }

  // Same content re-fetched successfully (e.g. a permissions retry) does not
  // count as a new version — only an actual content change does.
  const nextVersion = sameContentAsBefore ? existing.version : existing.version + 1;
  const { rows } = await client.query(
    `UPDATE doc_submissions SET
       version=$1, doc_url=$2, snapshot=$3, content_hash=$4,
       price=$5, marketing_spend=$6, target_segment=$7,
       status='submitted', claimed_by=NULL, claimed_at=NULL,
       reviewed_by=NULL, reviewed_at=NULL, decision_reason=NULL, penalty_pct=0,
       submitted_at=NOW(), cooldown_until=$8, is_late=$9
     WHERE id=$10
     RETURNING *`,
    [nextVersion, docUrl, snapshot, contentHash, price ?? null, marketingSpend ?? null,
      targetSegment ?? null, cooldownUntil, isLate, existing.id]
  );
  return rows[0];
}

/** Claims a submission for review. Claims auto-expire after CLAIM_TTL_MS
 *  of inactivity so a distracted judge never blocks the queue, and two
 *  judges can never collide on one decision (DOCS_SYSTEM.md §5). */
async function claimSubmission(client, submissionId, judgeId) {
  const { rows } = await client.query(
    `UPDATE doc_submissions
     SET claimed_by=$1, claimed_at=NOW(), status=CASE WHEN status='submitted' THEN 'under_review' ELSE status END
     WHERE id=$2
       AND (claimed_by IS NULL OR claimed_at < NOW() - ($3 || ' milliseconds')::interval OR claimed_by=$1)
       AND status IN ('submitted','under_review')
     RETURNING *`,
    [judgeId, submissionId, CLAIM_TTL_MS]
  );
  if (!rows[0]) {
    const current = (await client.query(
      `SELECT ds.claimed_by, j.name AS claimed_by_name FROM doc_submissions ds
       LEFT JOIN judges j ON j.id = ds.claimed_by WHERE ds.id=$1`, [submissionId]
    )).rows[0];
    throw new DocError('ALREADY_CLAIMED', current?.claimed_by_name
      ? `Already claimed by ${current.claimed_by_name}.`
      : 'This submission is not available to claim.', 409);
  }
  return rows[0];
}

/** Approve/reject — requires holding the live claim, checked in the same
 *  WHERE as the update so a stale/expired claim simply fails, no race window. */
/** decision: 'approved' | 'rejected' | 'disqualified'.
 *  `penaltyPct` (0-100) applies only to an approval — the "you were late, so
 *  you keep the tick but lose a slice of it" middle ground between waving a
 *  late submission through and disqualifying the team outright. */
async function decideSubmission(client, submissionId, judgeId, decision, reason, penaltyPct = 0, points = null) {
  const allowed = ['approved', 'rejected', 'disqualified', 'rated'];
  if (!allowed.includes(decision)) throw new DocError('INVALID_DECISION', `decision must be one of ${allowed.join(', ')}.`);

  // Only the pricing justification is approved/rejected. Everything else is
  // rated for points — a judge cannot "reject" a pitch deck, only score it.
  const meta = (await client.query(
    'SELECT dt.requires_approval, dt.max_points, dt.label FROM doc_submissions ds JOIN doc_types dt ON dt.id = ds.doc_type WHERE ds.id=$1',
    [submissionId]
  )).rows[0];
  if (!meta) throw new DocError('NOT_FOUND', 'Submission not found.', 404);
  if (meta.requires_approval && decision === 'rated') {
    throw new DocError('NEEDS_APPROVAL', `${meta.label} must be approved or rejected, not rated.`);
  }
  if (!meta.requires_approval && decision !== 'rated') {
    throw new DocError('RATE_ONLY', `${meta.label} is rated for points, not approved or rejected. Send decision:"rated" with points.`);
  }
  if (decision === 'rated' && (points === null || points === undefined || points === '')) {
    throw new DocError('POINTS_REQUIRED', `Award points (0-${Number(meta.max_points)}) when rating ${meta.label}.`);
  }
  if ((decision === 'rejected' || decision === 'disqualified') && !String(reason || '').trim()) throw new DocError('REASON_REQUIRED', `A reason is required to ${decision === 'rejected' ? 'reject' : 'disqualify'}.`);
  const penalty = Math.min(100, Math.max(0, Number(penaltyPct) || 0));
  if (decision !== 'approved' && penalty > 0) throw new DocError('INVALID_PENALTY', 'A penalty only applies to an approval.');
  const maxPoints = Number(meta.max_points || 0);

  // Points are clamped to the doc type's ceiling so a judge can't award 500.
  let awarded = null;
  if (points !== null && points !== undefined && points !== '') {
    awarded = Math.min(maxPoints, Math.max(0, Number(points) || 0));
  }

  // A claim gives ONE judge exclusivity over an approve/reject decision.
  // Ratings are independent per judge, so they deliberately do not require a
  // claim — otherwise the first rater would lock everyone else out and
  // multi-judge scoring could never happen.
  const claimClause = meta.requires_approval ? 'AND claimed_by=$2' : '';
  const { rows } = await client.query(
    `UPDATE doc_submissions
     SET status=$1, reviewed_by=$2, reviewed_at=NOW(), decision_reason=$3, penalty_pct=$5,
         points=CASE WHEN $1='rated' THEN points ELSE COALESCE($6, points) END,
         claimed_by=NULL, claimed_at=NULL
     WHERE id=$4 ${claimClause}
     RETURNING *`,
    [decision, judgeId, reason || null, submissionId, penalty, awarded]
  );
  if (!rows[0]) throw new DocError('CLAIM_REQUIRED', 'You must hold the claim on this submission to decide it (it may have expired).', 409);
  return rows[0];
}

async function addComment(client, submissionId, { authorType, authorId, authorName, section, tag, body }) {
  if (!String(body || '').trim()) throw new DocError('EMPTY_COMMENT', 'Comment cannot be empty.');
  const { rows } = await client.query(
    `INSERT INTO doc_comments (submission_id, author_type, author_id, author_name, section, tag, body)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [submissionId, authorType, authorId ? String(authorId) : null, authorName || null, section || null, tag || null, String(body).trim().slice(0, 2000)]
  );
  return rows[0];
}

/**
 * Resolves everything still unresolved for a gating doc type at its
 * deadline — called by the tick engine right before it runs a tick.
 * `carry_over` types (pricing doc) just get marked so the engine falls
 * back to the last approved strategy; `auto_approve` types (pivot) get
 * approved outright so judge availability can never stall the round.
 */
async function resolveTimeouts(client, docTypeId, round, tick) {
  const docType = (await client.query('SELECT * FROM doc_types WHERE id=$1', [docTypeId])).rows[0];
  if (!docType) return [];
  const nextStatus = docType.timeout_behavior === 'auto_approve' ? 'auto_approved' : 'carried_over';
  const { rows } = await client.query(
    `UPDATE doc_submissions
     SET status=$1, claimed_by=NULL, claimed_at=NULL
     WHERE doc_type=$2 AND round IS NOT DISTINCT FROM $3 AND tick IS NOT DISTINCT FROM $4
       AND status IN ('submitted','under_review','rejected')
     RETURNING *`,
    [nextStatus, docTypeId, round ?? null, tick ?? null]
  );
  return rows;
}

function serializeSubmission(row, { includeSnapshotUrl = true } = {}) {
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    docType: row.doc_type,
    round: row.round,
    tick: row.tick,
    version: row.version,
    docUrl: row.doc_url,
    snapshotUrl: includeSnapshotUrl ? `/api/docs/${row.id}/snapshot` : undefined,
    price: row.price == null ? null : Number(row.price),
    marketingSpend: row.marketing_spend == null ? null : Number(row.marketing_spend),
    targetSegment: row.target_segment,
    status: row.status,
    claimedBy: row.claimed_by ? String(row.claimed_by) : null,
    claimedAt: row.claimed_at ? new Date(row.claimed_at).getTime() : null,
    reviewedBy: row.reviewed_by ? String(row.reviewed_by) : null,
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).getTime() : null,
    decisionReason: row.decision_reason,
    isLate: Boolean(row.is_late),
    penaltyPct: Number(row.penalty_pct || 0),
    points: row.points == null ? null : Number(row.points),
    consumedAt: row.consumed_at ? new Date(row.consumed_at).getTime() : null,
    submittedAt: new Date(row.submitted_at).getTime(),
    cooldownUntil: new Date(row.cooldown_until).getTime(),
  };
}

module.exports = {
  DocError, extractGoogleDocId, fetchGoogleDocSnapshot, submitDoc,
  claimSubmission, decideSubmission, addComment, resolveTimeouts,
  serializeSubmission, COOLDOWN_MS, MAX_VERSIONS, CLAIM_TTL_MS,
};
