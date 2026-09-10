import { useCallback, useEffect, useState } from 'react';
import { api, fmt, getCurrentUser, countdown, DOC_STATUS, PHASE_LABEL } from '../api.js';
import { Modal, Toasts, TopBar } from '../components.jsx';
import { usePoll, useToasts } from '../hooks.js';

const FALLBACK_ATTRS = [
  { id: 'innovation', label: 'Innovation', weight: 0.25 },
  { id: 'usability', label: 'Usability & Craft', weight: 0.2 },
  { id: 'market_fit', label: 'Market Fit', weight: 0.25 },
  { id: 'execution', label: 'Execution', weight: 0.15 },
  { id: 'storytelling', label: 'Pitch & Story', weight: 0.15 },
];

/* Staff panel — judges and admin share this shell (REDESIGN.md §C.2).
   Judges get the review queue and scoring; game controls live in the admin
   console and are deliberately absent here. */
export default function Staff({ nav }) {
  const [user] = useState(() => getCurrentUser());
  const { items, toast } = useToasts();
  const [state, setState] = useState(null);
  const [queue, setQueue] = useState([]);
  const [tab, setTab] = useState('queue');
  const [scoring, setScoring] = useState(null);
  const [reviewing, setReviewing] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => { if (!user || (user.role !== 'judge' && user.role !== 'admin')) nav('/'); }, [user, nav]);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  const refreshQueue = useCallback(async () => {
    try { setQueue(await api.docQueue()); } catch { /* poll keeps retrying */ }
  }, []);
  useEffect(() => { refreshQueue(); const id = setInterval(refreshQueue, 4000); return () => clearInterval(id); }, [refreshQueue]);

  const fetchState = useCallback(() => api.gameState(), []);
  usePoll(fetchState, setState, 4000, !!user);

  if (!user) return null;
  const phase = state?.gamePhase || 'lobby';
  const teams = state?.teams || [];
  const attrs = state?.qualityAttributes?.length ? state.qualityAttributes : FALLBACK_ATTRS;
  const reviewClock = countdown(state?.reviewDeadline, now);
  const tickClock = countdown(state?.tickDeadline, now);

  const gating = queue.filter(q => q.gatesTick);
  const other = queue.filter(q => !q.gatesTick);
  const scoredCount = teams.filter(t => state?.quality?.[t.id]?.composite != null).length;

  const logout = async () => { await api.logout(); nav('/'); };

  return (
    <div className="page">
      <TopBar>
        <span className="badge badge-purple">{user.role === 'admin' ? 'Game Master' : `Judge · ${user.name || ''}`}</span>
        <span className="badge">R{state?.round ?? 1} · T{state?.tickInRound ?? 0}</span>
        <span className={`badge ${phase === 'active' ? 'badge-green badge-pulse' : 'badge-amber'}`}>
          {phase === 'active' ? '● LIVE' : PHASE_LABEL[phase] || phase}
        </span>
        <button className="btn btn-dark btn-sm" onClick={() => nav('/logs')}>📜 Logs</button>
        <button className="btn btn-dark btn-sm" onClick={logout}>Logout</button>
      </TopBar>

      <div className="wrap" style={{ marginTop: 16 }}>
        <div className="panel" style={{ display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <div className="eyebrow" style={{ margin: 0 }}>Review window closes</div>
            <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: reviewClock.expired ? 'var(--red)' : 'var(--ember-hot)' }}>
              {reviewClock.expired ? 'CLOSED' : reviewClock.text}
            </div>
          </div>
          <div>
            <div className="eyebrow" style={{ margin: 0 }}>Tick fires</div>
            <div className="mono" style={{ fontSize: 20, fontWeight: 700 }}>{tickClock.expired ? '—' : tickClock.text}</div>
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div className="eyebrow" style={{ margin: 0 }}>Pending review</div>
            <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: gating.length ? 'var(--gold)' : 'var(--green)' }}>
              {gating.length} blocking · {other.length} other
            </div>
          </div>
        </div>
      </div>

      <div className="wrap" style={{ marginTop: 14 }}>
        <div className="row" style={{ gap: 8 }}>
          <button className={`btn btn-sm ${tab === 'queue' ? 'btn-primary' : 'btn-dark'}`} onClick={() => setTab('queue')}>
            📥 Review queue {queue.length > 0 && <span className="badge badge-amber" style={{ marginLeft: 6 }}>{queue.length}</span>}
          </button>
          <button className={`btn btn-sm ${tab === 'score' ? 'btn-primary' : 'btn-dark'}`} onClick={() => setTab('score')}>
            ⭐ Score teams ({scoredCount}/{teams.length})
          </button>
          <button className={`btn btn-sm ${tab === 'board' ? 'btn-primary' : 'btn-dark'}`} onClick={() => setTab('board')}>
            🏆 Leaderboard
          </button>
          <button className={`btn btn-sm ${tab === 'events' ? 'btn-primary' : 'btn-dark'}`} onClick={() => setTab('events')}>
            ✨ Powers &amp; events
          </button>
        </div>
      </div>

      <div className="wrap stack" style={{ marginTop: 14 }}>
        {tab === 'queue' && (
          <>
            <div className="panel">
              <div className="panel-h">🚨 Blocking a tick — review these first ({gating.length})</div>
              {gating.length === 0 && <div className="empty-note">Nothing blocking. Teams' approved strategies will apply at the tick.</div>}
              <div className="stack">
                {gating.map(q => <QueueRow key={q.id} item={q} user={user} onOpen={() => setReviewing(q)} />)}
              </div>
            </div>
            <div className="panel">
              <div className="panel-h">📄 Other documents ({other.length})</div>
              {other.length === 0 && <div className="empty-note">No other documents waiting.</div>}
              <div className="stack">
                {other.map(q => <QueueRow key={q.id} item={q} user={user} onOpen={() => setReviewing(q)} />)}
              </div>
            </div>
          </>
        )}

        {tab === 'score' && (
          <div className="panel">
            <div className="panel-h">⭐ Product rating — {scoredCount} of {teams.length} teams scored</div>
            {teams.length === 0 && <div className="empty-note">No teams registered yet.</div>}
            <table className="tbl">
              <thead><tr><th>Team</th><th>Track</th><th>Composite</th><th></th></tr></thead>
              <tbody>
                {teams.map(t => {
                  const q = state?.quality?.[t.id];
                  return (
                    <tr key={t.id}>
                      <td><b>{t.teamName}</b><br /><span className="muted" style={{ fontSize: 11 }}>{t.startupName}</span></td>
                      <td className="mono" style={{ fontSize: 12 }}>{t.category}</td>
                      <td className="mono" style={{ color: 'var(--gold)' }}>{q?.composite != null ? `★ ${Number(q.composite).toFixed(1)}` : '—'}</td>
                      <td><button className="btn btn-primary btn-sm" onClick={() => setScoring(t)}>{q?.composite != null ? 'Re-score' : 'Score'}</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {tab === 'board' && (
          <div className="panel">
            <div className="panel-h">🏆 Leaderboard — live</div>
            {(state?.leaderboard?.length ?? 0) === 0 && <div className="empty-note">Standings appear after the first tick.</div>}
            {(state?.leaderboard?.length ?? 0) > 0 && (
              <table className="tbl">
                <thead><tr><th>#</th><th>Team</th><th>Money</th><th>Revenue</th><th>Doc pts</th><th>Judge ★</th><th>Market</th></tr></thead>
                <tbody>
                  {state.leaderboard.map((t, i) => (
                    <tr key={t.teamId} style={t.isDisqualified ? { opacity: 0.45 } : undefined}>
                      <td className="mono">{i + 1}</td>
                      <td>
                        <b style={t.isDisqualified ? { textDecoration: 'line-through' } : undefined}>{t.teamName}</b>
                        {t.isDisqualified && <span className="badge badge-red" style={{ marginLeft: 6 }}>DQ</span>}
                        {t.isInsolvent && <span className="badge badge-red" style={{ marginLeft: 6 }}>insolvent</span>}
                        <br /><span className="muted" style={{ fontSize: 11 }}>{t.startupName} · {t.category}</span>
                      </td>
                      <td className="mono" style={{ color: t.netProfit >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>
                        {t.netProfit >= 0 ? '+' : '−'}{fmt.currency(Math.abs(t.netProfit), true)}
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>{fmt.currency(t.totalRevenue, true)}</td>
                      <td className="mono">{t.docPoints ?? 0}</td>
                      <td className="mono" style={{ color: 'var(--gold)' }}>{t.qualityScore == null ? '—' : `★ ${Number(t.qualityScore).toFixed(1)}`}</td>
                      <td className="mono" style={{ color: 'var(--ember-hot)', fontWeight: 700 }}>{t.marketScore ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {tab === 'events' && (
          <EventsTab state={state} toast={toast} onDone={async () => setState(await api.gameState())} />
        )}
      </div>

      {reviewing && <ReviewModal item={reviewing} toast={toast} onClose={() => setReviewing(null)} onDone={async () => { setReviewing(null); await refreshQueue(); }} />}
      {scoring && <ScoreModal team={scoring} attrs={attrs} existing={state?.quality?.[scoring.id]} toast={toast} onClose={() => setScoring(null)} onDone={async () => { setScoring(null); setState(await api.gameState()); }} />}
      <Toasts items={items} />
    </div>
  );
}

/* Powers and universal events. A judge can inject drama but cannot choose
   who benefits: powers are server-rolled and everything lands on every team. */
function EventsTab({ state, toast, onDone }) {
  const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState([]);
  const [powers, setPowers] = useState([]);
  useEffect(() => {
    api.catalog().then(setCatalog).catch(() => {});
    api.powers().then(setPowers).catch(() => {});
  }, []);

  const act = async (fn, okTitle) => {
    setBusy(true);
    try { const r = await fn(); toast.success(okTitle, r?.name ? `${r.emoji || ''} ${r.name} — every team` : 'Applied to every team'); await onDone(); }
    catch (e) { toast.error('Failed', e.message); }
    setBusy(false);
  };

  const active = state?.activeShocks || [];

  return (
    <>
      <div className="panel">
        <div className="panel-h">✨ Grant a random power — everyone benefits</div>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          The server rolls which power lands and applies it to <b>every team at once</b>.
          You choose neither the power nor who gets it — that is what keeps it fair.
          One event per tick.
        </p>
        <button className="btn btn-primary btn-full" disabled={busy}
          onClick={() => act(() => api.grantPower(), 'Power granted')}>
          {busy && <span className="spinner" />} 🎲 Roll a power for everyone
        </button>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
          {powers.map(p => (
            <span key={p.id} className="badge" title={p.description}>{p.emoji} {p.name}</span>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-h">⚡ Fire a universal event</div>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          Hits every team equally — there is no targeting option, by design.
        </p>
        <div className="card-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
          {catalog.map(sh => (
            <div key={sh.id} className="rule-card" style={{ textAlign: 'left' }}>
              <div style={{ fontSize: 22 }}>{sh.emoji}</div>
              <h3 style={{ marginTop: 6, fontSize: 14 }}>{sh.name}</h3>
              <p style={{ fontSize: 12 }}>{sh.description}</p>
              <button className="btn btn-primary btn-sm" disabled={busy} style={{ marginTop: 8 }}
                onClick={() => act(() => api.fireGlobalEvent(sh.id), 'Event fired')}>Fire for everyone</button>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-h">🌩 Active right now ({active.length})</div>
        {active.length === 0 && <div className="empty-note">Nothing active.</div>}
        <div className="stack">
          {active.map(sh => (
            <div key={sh.instanceId} className="feed-row" style={{ paddingLeft: 0, paddingRight: 0 }}>
              <div className="grow">
                <div className="nm">{sh.emoji} {sh.name}</div>
                <div className="sub">{sh.category} · demand {sh.effect.demand > 0 ? '+' : ''}{sh.effect.demand}% · budget {sh.effect.budget > 0 ? '+' : ''}{sh.effect.budget}% · conv {sh.effect.conversion > 0 ? '+' : ''}{sh.effect.conversion}%</div>
              </div>
              <button className="btn btn-dark btn-sm" disabled={busy}
                onClick={() => act(() => api.clearShock(sh.instanceId), 'Cleared')}>Clear</button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function QueueRow({ item, user, onOpen }) {
  const claimedByOther = item.claimedBy && String(item.claimedBy) !== String(user.id);
  return (
    <div className="feed-row" style={{ paddingLeft: 0, paddingRight: 0 }}>
      <div className="grow">
        <div className="nm">
          {item.teamName} <span className="muted" style={{ fontWeight: 400 }}>· {item.docTypeLabel}</span>
          {item.gatesTick && <span className="badge badge-red" style={{ marginLeft: 8 }}>blocks tick</span>}
        </div>
        <div className="sub">
          {item.startupName}
          {item.price != null && ` · ₹${Number(item.price).toLocaleString('en-IN')} · ${item.targetSegment} · mktg ₹${Number(item.marketingSpend).toLocaleString('en-IN')}`}
          {item.version > 1 && ` · revision ${item.version}`}
        </div>
      </div>
      {claimedByOther
        ? <span className="badge badge-amber">🔒 {item.claimedByName || 'in review'}</span>
        : <button className="btn btn-primary btn-sm" onClick={onOpen}>Review</button>}
    </div>
  );
}

function ReviewModal({ item, toast, onClose, onDone }) {
  const [claimed, setClaimed] = useState(false);
  const [reason, setReason] = useState('');
  const [points, setPoints] = useState('');
  const [penalty, setPenalty] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    // Claim on open so two judges can't act on the same submission.
    api.claimDoc(item.id).then(() => setClaimed(true)).catch(e => setErr(e.message));
  }, [item.id]);

  const decide = async (decision) => {
    if (decision === 'rejected' && !reason.trim()) return toast.warning('Reason required', 'Tell the team what to fix.');
    setBusy(true);
    try {
      if (comment.trim()) await api.addDocComment(item.id, { body: comment.trim(), tag: decision === 'rejected' ? 'concern' : 'praise' });
      await api.decideDoc(item.id, decision, reason.trim() || undefined, {
        points: points === '' ? undefined : points,
        penaltyPct: decision === 'approved' && item.isLate ? penalty : undefined,
      });
      toast.success(decision === 'approved' ? 'Approved' : 'Rejected', `${item.teamName} · ${item.docTypeLabel}`);
      await onDone();
    } catch (e) { toast.error('Decision failed', e.message); setBusy(false); }
  };

  return (
    <Modal title={`${item.teamName} — ${item.docTypeLabel}`} onClose={onClose} wide>
      {err && <p className="form-error">{err}</p>}
      {!claimed && !err && <p className="muted">Claiming…</p>}

      {/* Live context: never rate a document without knowing how the team is
          actually doing. */}
      {item.team && (
        <div className="panel" style={{ marginBottom: 12 }}>
          <div className="panel-h" style={{ marginBottom: 8 }}>Where this team stands</div>
          <div className="grid-4" style={{ gap: 8 }}>
            <div>
              <div className="eyebrow" style={{ margin: 0 }}>Money made / lost</div>
              <div className="mono" style={{ fontSize: 17, fontWeight: 700, color: item.team.moneyDelta >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {item.team.moneyDelta >= 0 ? '+' : '−'}{fmt.currency(Math.abs(item.team.moneyDelta), true)}
              </div>
            </div>
            <div>
              <div className="eyebrow" style={{ margin: 0 }}>Revenue</div>
              <div className="mono" style={{ fontSize: 17 }}>{fmt.currency(item.team.totalRevenue, true)}</div>
            </div>
            <div>
              <div className="eyebrow" style={{ margin: 0 }}>Points so far</div>
              <div className="mono" style={{ fontSize: 17, color: 'var(--ember-hot)', fontWeight: 700 }}>{item.team.points}</div>
            </div>
            <div>
              <div className="eyebrow" style={{ margin: 0 }}>Judge ★</div>
              <div className="mono" style={{ fontSize: 17, color: 'var(--gold)' }}>
                {item.team.qualityScore == null ? '—' : `★ ${item.team.qualityScore.toFixed(1)}`}
              </div>
            </div>
          </div>
          {(item.team.isInsolvent || item.team.debt > 0) && (
            <p className="muted" style={{ fontSize: 12, margin: '8px 0 0', color: 'var(--red)' }}>
              {item.team.isInsolvent ? '🚨 Insolvent' : `Carrying ${fmt.currency(item.team.debt, true)} of debt`} · {item.team.ticksPlayed} tick(s) played
            </p>
          )}
        </div>
      )}

      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="q-row"><span className="ql">Startup</span><span>{item.startupName}</span></div>
        {item.price != null && (
          <>
            <div className="q-row"><span className="ql">Proposed price</span><span className="mono">{fmt.currency(item.price)}</span></div>
            <div className="q-row"><span className="ql">Marketing spend</span><span className="mono">{fmt.currency(item.marketingSpend)}</span></div>
            <div className="q-row"><span className="ql">Segment</span><span className="mono">{item.targetSegment}</span></div>
          </>
        )}
        <div className="q-row"><span className="ql">Revision</span><span className="mono">v{item.version}</span></div>
        {item.isLate && (
          <div className="q-row">
            <span className="ql" style={{ color: 'var(--red)' }}>⏰ Submitted LATE</span>
            <span className="muted" style={{ fontSize: 12 }}>approve with a penalty, or disqualify</span>
          </div>
        )}
      </div>

      {item.isLate && (
        <div className="field">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <label className="label">Late penalty</label>
            <span className="mono" style={{ color: 'var(--red)', fontWeight: 700 }}>−{penalty}%</span>
          </div>
          <div className="row" style={{ gap: 4 }}>
            {[0, 10, 25, 50].map(p => (
              <button key={p} type="button" className={`btn btn-sm ${penalty === p ? 'btn-primary' : 'btn-dark'}`}
                onClick={() => setPenalty(p)}>{p === 0 ? 'None' : `−${p}%`}</button>
            ))}
          </div>
        </div>
      )}

      <a className="btn btn-primary btn-full" href={item.docUrl} target="_blank" rel="noopener noreferrer"
         style={{ marginBottom: 12 }}>
        📄 Open document
      </a>

      {item.maxPoints > 0 && (
        <div className="field">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <label className="label">Points (0–{item.maxPoints})</label>
            <span className="mono" style={{ color: 'var(--ember-hot)', fontWeight: 700 }}>{points === '' ? '—' : points}/{item.maxPoints}</span>
          </div>
          <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
            {Array.from({ length: item.maxPoints + 1 }, (_, n) => n).map(n => (
              <button key={n} type="button"
                className={`btn btn-sm ${points === n ? 'btn-primary' : 'btn-dark'}`}
                style={{ minWidth: 36, padding: '6px 0' }}
                onClick={() => setPoints(n)}>{n}</button>
            ))}
          </div>
        </div>
      )}

      <div className="field">
        <label className="label">Comment to the team (optional)</label>
        <textarea className="input" rows={2} value={comment} onChange={(e) => setComment(e.target.value)}
          placeholder="e.g. Second citation has no source link." />
      </div>
      <div className="field">
        <label className="label">Rejection reason (required to reject)</label>
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="What must they fix before resubmitting?" />
      </div>

      <div className="row" style={{ gap: 10 }}>
        <button className="btn btn-primary" style={{ flex: 1 }} disabled={!claimed || busy} onClick={() => decide('approved')}>
          {busy && <span className="spinner" />} ✓ Approve
        </button>
        <button className="btn btn-danger" style={{ flex: 1 }} disabled={!claimed || busy} onClick={() => decide('rejected')}>
          ✗ Reject
        </button>
      </div>
      {item.isLate && (
        <button className="btn btn-danger btn-full" style={{ marginTop: 8 }} disabled={!claimed || busy}
          onClick={() => decide('disqualified')}>
          ⛔ Disqualify this tick
        </button>
      )}
    </Modal>
  );
}

function ScoreModal({ team, attrs, existing, toast, onClose, onDone }) {
  const [scores, setScores] = useState(() => {
    const init = {};
    for (const a of attrs) if (existing?.scores?.[a.id] != null) init[a.id] = existing.scores[a.id];
    return init;
  });
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const filled = Object.fromEntries(Object.entries(scores).filter(([, v]) => v !== '' && v != null));
    if (Object.keys(filled).length === 0) return toast.warning('No scores', 'Rate at least one attribute.');
    setBusy(true);
    try {
      await api.scoreQuality(team.id, filled);
      toast.success('Scores saved', team.teamName);
      await onDone();
    } catch (e2) { toast.error('Save failed', e2.message); setBusy(false); }
  };

  return (
    <Modal title={`Rate: ${team.teamName}`} onClose={onClose} wide>
      <form onSubmit={submit}>
        {attrs.map(a => (
          <div key={a.id} className="field">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <label className="label">{a.label} <span className="muted">×{a.weight}</span></label>
              <span className="mono" style={{ color: 'var(--ember-hot)', fontWeight: 700 }}>{scores[a.id] ?? '—'}/10</span>
            </div>
            {/* Tap targets, not a slider — judges are on phones (SPEC.md §4.2). */}
            <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
              {[1,2,3,4,5,6,7,8,9,10].map(n => (
                <button key={n} type="button"
                  className={`btn btn-sm ${scores[a.id] === n ? 'btn-primary' : 'btn-dark'}`}
                  style={{ minWidth: 40, padding: '8px 0' }}
                  onClick={() => setScores(s => ({ ...s, [a.id]: n }))}>{n}</button>
              ))}
            </div>
          </div>
        ))}
        <button className="btn btn-primary btn-full" type="submit" disabled={busy}>
          {busy && <span className="spinner" />} Save ratings
        </button>
      </form>
    </Modal>
  );
}
