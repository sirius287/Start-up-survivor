import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmt, getCurrentUser, teamIdOf, countdown, DOC_STATUS, PHASE_LABEL, SEGMENT_INFO } from '../api.js';
import { Metric, Modal, ShockCard, Toasts, TopBar } from '../components.jsx';
import { usePoll, useToasts } from '../hooks.js';

/* Participant panel.
   The flow is deliberately two-step: SUBMIT A REQUEST (strategy + a cited
   Pricing Justification doc) → a judge approves it → only then does DEPLOY
   unlock. Clicking speed is irrelevant; approval is the gate. */
export default function Dashboard({ nav }) {
  const [user] = useState(() => getCurrentUser());
  const { items, toast } = useToasts();
  const [state, setState] = useState(null);
  const [request, setRequest] = useState(null);
  const [docTypes, setDocTypes] = useState([]);
  const [myDocs, setMyDocs] = useState([]);
  const [tab, setTab] = useState('cockpit');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [help, setHelp] = useState(false);
  const seenShocks = useRef(new Set());

  useEffect(() => { if (!user || user.role !== 'team') nav('/'); }, [user, nav]);
  const teamId = teamIdOf(user);

  // Local ticking clock for countdowns; deadlines themselves are server-issued.
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  const refreshSide = useCallback(async () => {
    try {
      const [r, d] = await Promise.all([api.myRequest(teamId), api.myDocs()]);
      setRequest(r); setMyDocs(d);
    } catch { /* best-effort; the main poll drives the critical state */ }
  }, [teamId]);

  useEffect(() => { api.docTypes().then(setDocTypes).catch(() => {}); refreshSide(); }, [refreshSide]);

  const fetchState = useCallback(() => api.gameState(), []);
  const onState = useCallback((s) => {
    setState(s);
    for (const sh of s.activeShocks || []) {
      if (!seenShocks.current.has(sh.instanceId)) {
        seenShocks.current.add(sh.instanceId);
        toast.shock(`⚡ ${sh.name}`, sh.description);
      }
    }
  }, [toast]);
  usePoll(fetchState, onState, 3000, !!user);
  useEffect(() => { const id = setInterval(refreshSide, 5000); return () => clearInterval(id); }, [refreshSide]);

  const ms = state?.marketState?.[teamId];
  const quality = state?.quality?.[teamId];
  const phase = state?.gamePhase || 'lobby';
  const shockFired = Boolean(state?.halftimeShockAt);

  const submitClock = countdown(state?.submissionDeadline, now);
  const tickClock = countdown(state?.tickDeadline, now);
  // Pricing is never hard-blocked by the clock — past the deadline it is
  // accepted but flagged LATE for the judge to penalise or disqualify.
  const submissionsOpen = phase === 'active';
  const isLateNow = phase === 'active' && submitClock.expired;

  // What document (if any) is due before the upcoming tick — surfaced in the
  // deadline bar so a team never has to go hunting for what's expected.
  const nextTickNo = (state?.gameTick ?? 0) + 1;
  const dueDoc = docTypes.find(d => d.due_before_global_tick === nextTickNo);
  const dueSubmitted = dueDoc && myDocs.some(d => d.docType === dueDoc.id);
  const dueLabel = dueDoc ? `${dueDoc.label}${dueSubmitted ? ' ✓' : ''}` : '';

  const logout = async () => { await api.logout(); nav('/'); };

  const deploy = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.deploy(teamId);
      toast.success('Deployed!', `${fmt.units(r.unitsSold)} units · ${fmt.currency(r.revenue, true)} revenue`);
      onState(await api.gameState()); await refreshSide();
    } catch (e) { toast.error('Deploy failed', e.message); }
    setBusy(false);
  };

  if (!user) return null;

  const TABS = [
    ['cockpit', '📊 Cockpit'],
    ['strategy', '🎯 Request & Deploy'],
    ['docs', '📄 Documents'],
    ['standings', '🏆 Standings'],
  ];

  return (
    <div className="page">
      <TopBar>
        <span className="badge badge-ember">{user.category}</span>
        <span className="badge">R{state?.round ?? 1} · T{state?.tickInRound ?? 0}/{state?.ticksPerRound ?? 2}</span>
        <PhaseBadge phase={phase} />
        <button className="btn btn-dark btn-sm" onClick={logout}>Logout</button>
      </TopBar>

      {/* The one bar that answers "what do I do, and how long have I got" */}
      <div className="wrap" style={{ marginTop: 16 }}>
        <div className="panel" style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <div className="eyebrow" style={{ margin: 0 }}>{user.teamName}</div>
            <div className="muted" style={{ fontSize: 12 }}>{user.startupName}</div>
          </div>
          <Clock label="Submissions close" clock={submitClock} warn />
          <Clock label={state?.inBuffer ? 'Tick runs (buffer)' : 'Tick runs'} clock={tickClock} />
          <div>
            <div className="eyebrow" style={{ margin: 0 }}>Due before tick {(state?.gameTick ?? 0) + 1}</div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {dueLabel || <span className="muted">Pricing only</span>}
            </div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="btn btn-dark btn-sm" onClick={() => setHelp(true)}>❓ How to play</button>
            <RequestBadge request={request} submissionsOpen={submissionsOpen} />
          </div>
        </div>
      </div>

      <div className="wrap" style={{ marginTop: 14 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {TABS.map(([id, label]) => (
            <button key={id} className={`btn btn-sm ${tab === id ? 'btn-primary' : 'btn-dark'}`} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
      </div>

      <div className="wrap stack" style={{ marginTop: 14 }}>
        {!ms && <div className="panel"><p className="muted">Loading your market state…</p></div>}

        {ms && tab === 'cockpit' && (
          <>
            <div className="grid-4">
              <Metric label="Total Revenue" value={fmt.currency(ms.totalRevenue, true)} color="var(--green)" />
              <Metric label="Net Profit" value={fmt.currency(ms.netProfit, true)} color={ms.netProfit >= 0 ? 'var(--green)' : 'var(--red)'} />
              <Metric label="Cash" value={fmt.currency(ms.budget, true)} color={ms.budget < 0 ? 'var(--red)' : 'var(--green)'} />
              <Metric label="Debt" value={ms.debt > 0 ? fmt.currency(ms.debt, true) : '—'} color={ms.debt > 0 ? 'var(--red)' : undefined} />
              <Metric label="Units Sold" value={fmt.units(ms.totalUnitsSold)} color="var(--ember-hot)" />
              <Metric label="Conversion" value={fmt.percent(ms.conversionRate)} color="var(--purple)" />
              <Metric label="Awareness" value={Number(ms.awareness).toFixed(2)} color="var(--cyan)" />
              <Metric label="Judge Rating" value={quality?.composite != null ? `★ ${Number(quality.composite).toFixed(1)}` : '—'} color="var(--gold)" />
            </div>
            {ms.isInsolvent && (
              <div className="panel" style={{ borderColor: 'var(--red)' }}>
                <div className="panel-h" style={{ color: 'var(--red)' }}>🚨 Insolvent</div>
                <p className="muted" style={{ margin: 0 }}>
                  Debt has passed 2× your starting budget. Marketing is capped at zero and your
                  market attractiveness carries a standing penalty until you claw back.
                </p>
              </div>
            )}
            <div className="panel">
              <div className="panel-h">⚡ Active Shocks</div>
              {(state?.activeShocks?.length ?? 0) === 0 && <div className="empty-note">No shocks active. Enjoy the calm — it never lasts.</div>}
              <div className="stack">
                {(state?.activeShocks || []).map((s) => <ShockCard key={s.instanceId} shock={s} category={ms.category} />)}
              </div>
            </div>
          </>
        )}

        {ms && tab === 'strategy' && (
          <StrategyTab
            ms={ms} teamId={teamId} request={request} busy={busy}
            submissionsOpen={submissionsOpen} submitClock={submitClock} tickClock={tickClock}
            phase={phase} isLateNow={isLateNow} toast={toast} onDeploy={deploy}
            pricingTemplate={docTypes.find(d => d.cadence === 'per_tick')?.template_outline}
            onSubmitted={async () => { await refreshSide(); onState(await api.gameState()); }}
          />
        )}

        {tab === 'docs' && (
          <DocsTab
            teamId={teamId} docTypes={docTypes} myDocs={myDocs} shockFired={shockFired}
            pivotOpen={state?.pivotOpen} pivotDeadline={state?.pivotDeadline} globalTick={state?.gameTick}
            toast={toast} onSubmitted={refreshSide}
          />
        )}

        {tab === 'standings' && (
          <div className="panel">
            <div className="panel-h">🏆 Leaderboard <span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>— ranked on mean tick score (0–100), not raw revenue</span></div>
            {(state?.leaderboard?.length ?? 0) === 0 && <div className="empty-note">No standings yet.</div>}
            {(state?.leaderboard || []).map((t, i) => (
              <div key={t.teamId} className="feed-row" style={{ paddingLeft: 0, paddingRight: 0 }}>
                <span className="rank">{String(i + 1).padStart(2, '0')}</span>
                <div className="grow">
                  <div className="nm" style={t.isDisqualified ? { textDecoration: 'line-through', opacity: 0.5 } : undefined}>
                    {t.teamName}{String(t.teamId) === String(teamId) ? ' ◄ you' : ''}
                    {t.isInsolvent ? ' 🚨' : ''}{t.isDisqualified ? ' ⛔' : ''}
                  </div>
                  <div className="sub">{t.startupName} · {t.category}{t.docPoints > 0 ? ` · ${t.docPoints} doc pts` : ''}</div>
                </div>
                <span className="mono" style={{ textAlign: 'right', fontSize: 12 }}>
                  <span style={{ color: 'var(--ember-hot)', fontWeight: 700 }}>{t.marketScore == null ? '—' : t.marketScore}</span>
                  <span className="muted" style={{ display: 'block', fontSize: 10 }}>{fmt.currency(t.totalRevenue, true)}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {help && <HowToPlay docTypes={docTypes} state={state} onClose={() => setHelp(false)} />}
      <Toasts items={items} />
    </div>
  );
}

/* A single place that answers every question a team is likely to ask, so the
   organisers aren't answering the same five questions fifty times. */
function HowToPlay({ docTypes, state, onClose }) {
  const scheduled = (docTypes || [])
    .filter(d => d.due_before_global_tick != null)
    .sort((a, b) => a.due_before_global_tick - b.due_before_global_tick);
  const pivot = (docTypes || []).find(d => d.opens_after_shock);
  const pricing = (docTypes || []).find(d => d.cadence === 'per_tick');

  return (
    <Modal title="How to <em>play</em>" onClose={onClose} wide>
      <div style={{ maxHeight: '65vh', overflowY: 'auto', paddingRight: 6 }}>

        <h3 style={{ marginTop: 0 }}>The loop, every tick</h3>
        <ol style={{ paddingLeft: 18, lineHeight: 1.7 }}>
          <li><b>Submit a request</b> — your price, marketing spend and segment,
              plus a Pricing Justification doc with at least 2 citations.</li>
          <li><b>A judge approves or rejects it.</b> Only the pricing doc is
              approved/rejected — every other document is <i>rated for points</i>.</li>
          <li><b>Deploy</b> — the button unlocks once you're approved. If you never
              click it, it auto-deploys at the tick, so you can't lose a tick by waiting.</li>
          <li><b>The market runs</b> for every team at once, and the leaderboard moves.</li>
        </ol>

        <h3>What decides how well you do</h3>
        <ul style={{ paddingLeft: 18, lineHeight: 1.7 }}>
          <li><b>Your price vs. your segment.</b> Mass buyers are price-sensitive;
              niche buyers barely care. There is no single "best" price — overpricing
              loses volume faster than it gains margin.</li>
          <li><b>Marketing builds awareness that decays.</b> Spending once and coasting
              doesn't work; neither does spending nothing.</li>
          <li><b>Your document ratings.</b> Well-rated documents literally make the
              market kinder to you — a strong idea and a well-argued price move demand.</li>
          <li><b>You compete for the same customers</b> as every other team on your
              track. Their choices change your results.</li>
        </ul>

        <h3>Deadlines</h3>
        <p style={{ lineHeight: 1.7 }}>
          Each tick is <b>{state?.tickMinutes ?? 45} minutes</b>: submissions close first,
          then judges review, then a <b>{state?.bufferMinutes ?? 10}-minute buffer</b> before
          the market runs. Every countdown you see is on <b>server time</b> — your own clock
          doesn't matter.
        </p>
        <p style={{ lineHeight: 1.7 }}>
          <b>Missing the pricing deadline is not fatal.</b> You can still submit — it gets
          flagged <i>late</i>, and a judge decides whether to accept it with a points
          penalty or disqualify that tick. If you submit nothing at all, your previous
          approved strategy simply carries over.
        </p>

        <h3>What to submit, and when</h3>
        <table className="tbl">
          <thead><tr><th>Document</th><th>Due</th><th>Worth</th></tr></thead>
          <tbody>
            {scheduled.map(d => (
              <tr key={d.id}>
                <td>{d.label}{d.is_mandatory && <span className="badge badge-red" style={{ marginLeft: 6 }}>required</span>}</td>
                <td className="mono">before tick {d.due_before_global_tick}</td>
                <td className="mono">{d.max_points} pts</td>
              </tr>
            ))}
            {pricing && <tr><td>{pricing.label}</td><td className="mono">every tick</td><td className="mono">approved / rejected</td></tr>}
            {pivot && <tr><td>{pivot.label}</td><td className="mono">the pivot window</td><td className="mono">{pivot.max_points} pts</td></tr>}
          </tbody>
        </table>

        <h3>The halftime shock &amp; the pivot</h3>
        <p style={{ lineHeight: 1.7 }}>
          Halfway through, a market shock hits <b>every team equally</b>. The moment it
          fires, your pre-shock documents lock — you can't rewrite your pitch around a
          shock you've already seen. A <b>pivot window</b> then opens for a limited time,
          and the Pivot Rationale is the single biggest score of the event
          ({pivot?.max_points ?? 25} pts). Judges may also fire universal opportunities
          and problems — always for everyone, never for one team.
        </p>

        <h3>Format rules for every document</h3>
        <ul style={{ paddingLeft: 18, lineHeight: 1.7 }}>
          <li>Paste a <b>Google Doc link</b>. Set sharing to
              <b> Anyone with the link → Viewer</b>, or it will be rejected on submit.</li>
          <li>Each document shows its <b>required outline</b> in the submit form. Follow it —
              judges score against it.</li>
          <li>Citations mean a <b>link plus one line</b> on what it proves. An uncited number
              is an opinion.</li>
          <li>After you submit, there's a <b>10-minute cooldown</b> before you can edit, and
              at most <b>2 revisions</b> per tick.</li>
          <li>We snapshot your document at submission — later edits don't change what a
              judge reviewed.</li>
        </ul>

        <h3>Common questions</h3>
        <p style={{ lineHeight: 1.7 }}>
          <b>Can I run out of money?</b> Yes. Cash can go negative and compounds as debt.
          Past a threshold you're insolvent: marketing is capped at zero and your market
          pull takes a standing penalty. You're never eliminated — you always get another
          tick to claw back.<br /><br />
          <b>Does clicking faster help?</b> No. Approval is the gate, not reaction time.<br /><br />
          <b>Can a judge target just my team?</b> No. Universal events hit everyone equally.<br /><br />
          <b>My doc was rejected — now what?</b> Fix what the reason says and resubmit;
          you have limited revisions, and the deadline still applies.
        </p>
      </div>
      <button className="btn btn-primary btn-full" onClick={onClose}>Got it</button>
    </Modal>
  );
}

function Clock({ label, clock, warn }) {
  const danger = warn && clock.ms < 5 * 60 * 1000 && !clock.expired;
  return (
    <div>
      <div className="eyebrow" style={{ margin: 0 }}>{label}</div>
      <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: clock.expired ? 'var(--red)' : danger ? 'var(--gold)' : 'var(--ember-hot)' }}>
        {clock.expired ? 'CLOSED' : clock.text}
      </div>
    </div>
  );
}

function PhaseBadge({ phase }) {
  const cls = phase === 'active' ? 'badge-green badge-pulse' : phase === 'ended' ? 'badge-purple' : 'badge-amber';
  return <span className={`badge ${cls}`}>{phase === 'active' ? '● LIVE' : PHASE_LABEL[phase] || phase}</span>;
}

function RequestBadge({ request, submissionsOpen }) {
  const sub = request?.submission;
  if (!sub) {
    return <span className={`badge ${submissionsOpen ? 'badge-amber badge-pulse' : 'badge-red'}`}>
      {submissionsOpen ? '⚠ No request submitted' : '✗ Missed this tick — previous strategy carries over'}
    </span>;
  }
  if (request.deployedAt) return <span className="badge badge-purple">✓ Deployed this tick</span>;
  const meta = DOC_STATUS[sub.status] || { label: sub.status, tone: 'amber' };
  if (request.canDeploy) return <span className="badge badge-green badge-pulse">✓ Approved — Deploy unlocked</span>;
  return <span className={`badge badge-${meta.tone}`}>{meta.label}</span>;
}

/* ---- Request & Deploy ---- */
function StrategyTab({ ms, teamId, request, busy, submissionsOpen, isLateNow, submitClock, tickClock, phase, pricingTemplate, toast, onDeploy, onSubmitted }) {
  const sub = request?.submission;
  const [price, setPrice] = useState(ms.productPrice);
  const [mkt, setMkt] = useState(ms.marketingSpend);
  const [segment, setSegment] = useState(ms.targetSegment || 'mass');
  const [docUrl, setDocUrl] = useState('');
  const [sending, setSending] = useState(false);
  const [showFormat, setShowFormat] = useState(false);

  useEffect(() => {
    if (sub) { setPrice(Number(sub.price)); setMkt(Number(sub.marketingSpend)); setSegment(sub.targetSegment); setDocUrl(sub.docUrl || ''); }
  }, [sub?.id, sub?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const cooldown = countdown(sub?.cooldownUntil, Date.now());
  const inCooldown = Boolean(sub) && !cooldown.expired;
  const revisionsLeft = sub ? Math.max(0, 3 - sub.version) : 2;

  const submit = async (e) => {
    e.preventDefault();
    if (!docUrl.trim()) return toast.warning('Doc required', 'Paste your Pricing Justification Google Doc link.');
    setSending(true);
    try {
      await api.submitRequest(teamId, { productPrice: Number(price), marketingSpend: Number(mkt), targetSegment: segment, docUrl: docUrl.trim() });
      toast.success('Request submitted', 'A judge will review it before you can deploy.');
      await onSubmitted();
    } catch (e2) { toast.error('Submission failed', e2.message); }
    setSending(false);
  };

  return (
    <div className="grid-2">
      <div className="panel">
        <div className="panel-h">1️⃣ Submit request — strategy + justification</div>

        {phase !== 'active' && (
          <div className="empty-note" style={{ borderColor: 'var(--red)' }}>
            The game is {phase}. Submissions open when the round is live.
          </div>
        )}
        {isLateNow && (
          <div className="empty-note" style={{ borderColor: 'var(--gold)' }}>
            ⏰ You are past the deadline for this tick. You can still submit — it will be
            flagged <b>late</b>, and a judge decides whether to accept it with a points
            penalty or disqualify this tick.
          </div>
        )}

        <form onSubmit={submit}>
          <div className="field">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <label className="label">Unit Price</label>
              <span className="mono" style={{ color: 'var(--ember-hot)', fontWeight: 700 }}>{fmt.currency(price)}</span>
            </div>
            <input type="range" className="slider" min={50} max={9999} step={50} value={price}
              disabled={!submissionsOpen || inCooldown}
              onChange={(e) => setPrice(Number(e.target.value))} />
          </div>

          <div className="field">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <label className="label">Marketing Spend</label>
              <span className="mono" style={{ color: 'var(--ember-hot)', fontWeight: 700 }}>{fmt.currency(mkt)}</span>
            </div>
            <input type="range" className="slider" min={0} max={30000} step={500} value={mkt}
              disabled={!submissionsOpen || inCooldown}
              onChange={(e) => setMkt(Number(e.target.value))} />
          </div>

          <div className="field">
            <label className="label">Target Segment</label>
            <select className="input" value={segment} disabled={!submissionsOpen || inCooldown}
              onChange={(e) => setSegment(e.target.value)}>
              <option value="mass">🌐 Mass Market — price-sensitive, biggest pool</option>
              <option value="premium">💎 Premium — tolerates a high price</option>
              <option value="niche">🎯 Niche — price-insensitive, tiny pool</option>
            </select>
            <p className="muted" style={{ fontSize: 12, margin: '2px 0 0' }}>{SEGMENT_INFO[segment]?.hint}</p>
          </div>

          <div className="field">
            <label className="label">Pricing Justification — Google Doc link <span className="req">*</span></label>
            <input className="input" value={docUrl} placeholder="https://docs.google.com/document/d/..."
              disabled={!submissionsOpen || inCooldown}
              onChange={(e) => setDocUrl(e.target.value)} />
            <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
              Must be shared “Anyone with the link → Viewer”. Minimum 2 citations. We snapshot it
              on submit — later edits won’t change what the judge reviewed.
            </p>
            {pricingTemplate && (
              <>
                <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 6 }}
                  onClick={() => setShowFormat(f => !f)}>
                  {showFormat ? '▾' : '▸'} Required format
                </button>
                {showFormat && (
                  <pre style={{
                    background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 8, padding: 12, fontSize: 12, lineHeight: 1.6,
                    whiteSpace: 'pre-wrap', margin: '6px 0 0',
                  }}>{pricingTemplate}</pre>
                )}
              </>
            )}
          </div>

          {inCooldown && (
            <p className="muted" style={{ fontSize: 12 }}>
              ⏱ Locked for {cooldown.text} after your last submit. {revisionsLeft} revision{revisionsLeft === 1 ? '' : 's'} left this tick.
            </p>
          )}
          {sub?.status === 'rejected' && (
            <p className="form-error">Rejected — {sub.decisionReason || 'no reason given'}. Revise and resubmit ({revisionsLeft} left).</p>
          )}

          <button className="btn btn-primary btn-full" type="submit"
            disabled={!submissionsOpen || inCooldown || sending || revisionsLeft <= 0}>
            {sending && <span className="spinner" />} {sub ? 'Resubmit request' : 'Submit request for review'}
          </button>
        </form>
      </div>

      <div className="panel">
        <div className="panel-h">2️⃣ Deploy — unlocks only once approved</div>

        <div className="stack" style={{ gap: 10 }}>
          <Step done={Boolean(sub)} label="Request submitted" />
          <Step done={sub?.status === 'approved' || sub?.status === 'auto_approved'}
            failed={sub?.status === 'rejected'}
            label={sub?.status === 'rejected' ? 'Judge rejected — revise above' : 'Judge approved'} />
          <Step done={Boolean(request?.deployedAt)} label="Deployed" />
        </div>

        <div style={{ marginTop: 18 }}>
          <button className="btn btn-primary btn-full" disabled={!request?.canDeploy || busy} onClick={onDeploy}
            title={request?.canDeploy ? '' : 'A judge must approve your request first'}>
            {busy && <span className="spinner" />} 🚀 Deploy Strategy
          </button>
          <p className="muted" style={{ fontSize: 12, textAlign: 'center', marginTop: 8 }}>
            {request?.deployedAt
              ? 'Already deployed this tick. Submit a new request for the next one.'
              : request?.canDeploy
                ? `Deploy before the tick fires in ${tickClock.text} — otherwise it auto-deploys for you.`
                : 'Locked until a judge approves your request. If they approve it and you never click, it auto-deploys at the tick — you never lose a tick for waiting.'}
          </p>
        </div>
      </div>
    </div>
  );
}

function Step({ done, failed, label }) {
  const color = failed ? 'var(--red)' : done ? 'var(--green)' : 'var(--muted)';
  return (
    <div className="row" style={{ gap: 10, alignItems: 'center' }}>
      <span style={{ color, fontSize: 18 }}>{failed ? '✗' : done ? '✓' : '○'}</span>
      <span style={{ color: done || failed ? 'inherit' : 'var(--muted)' }}>{label}</span>
    </div>
  );
}

/* ---- Documents: one is due before each tick, judges score them as they come ---- */
function DocsTab({ teamId, docTypes, myDocs, shockFired, pivotOpen, pivotDeadline, globalTick, toast, onSubmitted }) {
  const byType = useMemo(() => {
    const m = {};
    for (const d of myDocs) if (d.docType !== 'pricing_justification') m[d.docType] = d;
    return m;
  }, [myDocs]);

  const nextTick = (globalTick || 0) + 1;
  const scheduled = docTypes
    .filter(d => d.due_before_global_tick != null)
    .sort((a, b) => a.due_before_global_tick - b.due_before_global_tick);
  const dueNow = scheduled.filter(d => d.due_before_global_tick === nextTick);
  const overdue = scheduled.filter(d => d.due_before_global_tick < nextTick && !byType[d.id]);
  const upcoming = scheduled.filter(d => d.due_before_global_tick > nextTick);
  const done = scheduled.filter(d => byType[d.id] && d.due_before_global_tick <= nextTick);
  const pivot = docTypes.find(d => d.opens_after_shock);

  const earned = myDocs.reduce((sum, d) => sum + (d.points || 0), 0);
  const possible = scheduled.reduce((sum, d) => sum + Number(d.max_points || 0), 0) + Number(pivot?.max_points || 0);

  return (
    <>
      <div className="panel">
        <div className="panel-h">
          🎯 Due before tick {nextTick}
          <span className="badge badge-gold" style={{ marginLeft: 8 }}>{earned} / {possible} pts earned</span>
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          One document is due before each tick. Judges score them as they come in, so your
          points build up through the event.
        </p>
        {dueNow.length === 0 && <div className="empty-note">Nothing new due this tick.</div>}
        <div className="stack">
          {dueNow.map(dt => (
            <DocRow key={dt.id} teamId={teamId} docType={dt} existing={byType[dt.id]}
              locked={dt.due_before_shock && shockFired} toast={toast} onSubmitted={onSubmitted} highlight />
          ))}
        </div>
      </div>

      {overdue.length > 0 && (
        <div className="panel" style={{ borderColor: 'var(--red)' }}>
          <div className="panel-h" style={{ color: 'var(--red)' }}>⚠ Overdue — submit as soon as you can</div>
          <div className="stack">
            {overdue.map(dt => (
              <DocRow key={dt.id} teamId={teamId} docType={dt} existing={byType[dt.id]}
                locked={dt.due_before_shock && shockFired} toast={toast} onSubmitted={onSubmitted} />
            ))}
          </div>
        </div>
      )}

      {pivot && (
        <div className="panel" style={{ borderColor: pivotOpen ? 'var(--ember-hot)' : undefined }}>
          <div className="panel-h">
            🔄 {pivot.label} — worth {pivot.max_points} pts
            {pivotOpen
              ? <span className="badge badge-green badge-pulse" style={{ marginLeft: 8 }}>OPEN NOW</span>
              : shockFired
                ? <span className="badge badge-red" style={{ marginLeft: 8 }}>🔒 window closed</span>
                : <span className="badge badge-amber" style={{ marginLeft: 8 }}>opens at the shock</span>}
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            {pivotOpen
              ? `The pivot window is open — this is the biggest single score of the event. It closes at ${new Date(pivotDeadline).toLocaleTimeString()}.`
              : shockFired
                ? 'The pivot window has closed.'
                : 'This unlocks the moment the halftime shock fires, and stays open for a limited window only.'}
          </p>
          {(pivotOpen || byType[pivot.id]) && (
            <DocRow teamId={teamId} docType={pivot} existing={byType[pivot.id]} locked={!pivotOpen}
              toast={toast} onSubmitted={onSubmitted} highlight />
          )}
        </div>
      )}

      {(done.length > 0 || upcoming.length > 0) && (
        <div className="panel">
          <div className="panel-h">📄 Your other documents</div>
          <div className="stack">
            {done.map(dt => (
              <DocRow key={dt.id} teamId={teamId} docType={dt} existing={byType[dt.id]}
                locked={dt.due_before_shock && shockFired} toast={toast} onSubmitted={onSubmitted} />
            ))}
            {upcoming.map(dt => (
              <div key={dt.id} className="feed-row" style={{ paddingLeft: 0, paddingRight: 0, opacity: 0.5 }}>
                <div className="grow">
                  <div className="nm">{dt.label} <span className="muted" style={{ fontWeight: 400 }}>· {dt.max_points} pts</span></div>
                  <div className="sub">Due before tick {dt.due_before_global_tick}</div>
                </div>
                <span className="badge">upcoming</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function DocRow({ teamId, docType, existing, locked, toast, onSubmitted, highlight }) {
  const [url, setUrl] = useState(existing?.docUrl || '');
  const [saving, setSaving] = useState(false);
  const [showFormat, setShowFormat] = useState(Boolean(highlight) && !existing);
  useEffect(() => { setUrl(existing?.docUrl || ''); }, [existing?.docUrl]);

  const meta = existing ? (DOC_STATUS[existing.status] || { label: existing.status, tone: 'amber' }) : null;
  const cooldown = countdown(existing?.cooldownUntil, Date.now());
  const disabled = locked || saving || (existing && !cooldown.expired);

  const save = async () => {
    if (!url.trim()) return toast.warning('Link required', `Paste a Google Doc link for ${docType.label}.`);
    setSaving(true);
    try {
      await api.submitDoc(teamId, docType.id, url.trim());
      toast.success(`${docType.label} submitted`, 'Judges can see it now.');
      await onSubmitted();
    } catch (e) { toast.error(`${docType.label} failed`, e.message); }
    setSaving(false);
  };

  return (
    <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: 14 }}>
          {docType.label}
          {Number(docType.max_points) > 0 && <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}> · {docType.max_points} pts</span>}
          {docType.is_mandatory && <span className="badge badge-red" style={{ marginLeft: 6 }}>required</span>}
          {docType.min_citations > 0 && <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}> · min {docType.min_citations} citations</span>}
        </strong>
        <span className="row" style={{ gap: 6 }}>
          {existing?.points != null && <span className="badge badge-gold">{existing.points} pts</span>}
          {meta && <span className={`badge badge-${meta.tone}`}>{meta.label}</span>}
        </span>
      </div>
      {docType.template_outline && (
        <>
          <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 6 }}
            onClick={() => setShowFormat(f => !f)}>
            {showFormat ? '▾' : '▸'} Required format
          </button>
          {showFormat && (
            <pre style={{
              background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 8, padding: 12, fontSize: 12, lineHeight: 1.6,
              whiteSpace: 'pre-wrap', margin: '6px 0 0',
            }}>{docType.template_outline}</pre>
          )}
        </>
      )}
      <div className="row" style={{ gap: 8, marginTop: 6 }}>
        <input className="input" style={{ flex: 1 }} value={url} disabled={disabled}
          placeholder={locked ? 'Locked' : 'https://docs.google.com/document/d/...'}
          onChange={(e) => setUrl(e.target.value)} />
        <button className="btn btn-primary btn-sm" disabled={disabled} onClick={save}>
          {saving && <span className="spinner" />} {existing ? 'Update' : 'Submit'}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 11, margin: '4px 0 0' }}>
        Share as “Anyone with the link → Viewer”, or submission fails.
      </p>
      {existing?.status === 'rejected' && <p className="form-error" style={{ marginBottom: 0 }}>Rejected — {existing.decisionReason}</p>}
    </div>
  );
}
