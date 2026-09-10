import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmt, getCurrentUser, teamIdOf, BMC_FIELDS, PHASE_LABEL, SEGMENT_INFO } from '../api.js';
import { Metric, Modal, ShockCard, Toasts, TopBar } from '../components.jsx';
import { usePoll, useToasts } from '../hooks.js';

export default function Dashboard({ nav }) {
  const [user] = useState(() => getCurrentUser());
  const { items, toast } = useToasts();
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [bmcEdit, setBmcEdit] = useState(null); // { field, label, value }
  const [log, setLog] = useState([]);
  const seenShocks = useRef(new Set());
  const lastTick = useRef(null);

  useEffect(() => {
    if (!user || user.role !== 'team') nav('/');
  }, [user, nav]);

  const teamId = teamIdOf(user);
  const fetchState = useCallback(() => api.gameState(), []);
  const onState = useCallback((s) => {
    setState(s);
    const ms = s.marketState?.[teamIdOf(getCurrentUser())];
    // one toast per new shock
    for (const sh of s.activeShocks || []) {
      if (!seenShocks.current.has(sh.instanceId)) {
        seenShocks.current.add(sh.instanceId);
        toast.shock(`⚡ ${sh.name}`, sh.description);
      }
    }
    // event log rows on new ticks
    if (ms && ms.deployCount > 0 && lastTick.current !== ms.tick) {
      lastTick.current = ms.tick;
      setLog((prev) =>
        [{
          tick: ms.tick, time: fmt.time(Date.now()),
          revenue: (ms.revenueHistory || [0]).slice(-1)[0] || 0,
          units: ms.unitsSold, conv: ms.conversionRate,
          shocks: (s.activeShocks || []).map((x) => x.name),
        }, ...prev].slice(0, 30)
      );
    }
  }, [toast]);
  usePoll(fetchState, onState, 1500, !!user);

  const ms = state?.marketState?.[teamId];
  const quality = state?.quality?.[teamId];

  const logout = async () => {
    await api.logout();
    nav('/');
  };

  const deploy = async (strategy) => {
    if (busy) return;
    if (state?.gamePhase === 'lobby') return toast.warning('Game not started', 'Wait for the Game Master to start the session.');
    if (state?.gamePhase === 'ended') return toast.info('Game over', 'Check the leaderboard!');
    setBusy(true);
    try {
      await api.deploy(teamId, strategy);
      const s = await api.gameState();
      onState(s);
      toast.success('Strategy deployed!', 'Check your metrics.');
    } catch (e) {
      if (e.code === 'TICK_LIMIT_REACHED') toast.warning('No ticks left', e.message);
      else if (e.code === 'HOURLY_LIMIT_REACHED') toast.warning('Hourly limit reached', e.message);
      else toast.error('Deployment failed', e.message);
    }
    setBusy(false);
  };

  const saveBmc = async (field, value) => {
    try {
      await api.saveBmc(teamId, field, value);
      const s = await api.gameState();
      onState(s);
      setBmcEdit(null);
      toast.success('BMC updated', 'Your canvas has been saved.');
    } catch (e) {
      toast.error('BMC update failed', e.message);
    }
  };

  if (!user) return null;
  const phase = state?.gamePhase || 'lobby';

  return (
    <div className="page">
      <TopBar>
        <span className="badge badge-ember">{user.category}</span>
        <PhaseBadge phase={phase} />
        <button className="btn btn-dark btn-sm" onClick={logout}>Logout</button>
      </TopBar>

      <div className="wrap stack" style={{ marginTop: 20 }}>
        <div className="panel">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <p className="eyebrow" style={{ margin: '0 0 4px' }}>Squad dossier</p>
              <h1 className="h-display" style={{ fontSize: 30 }}>{user.teamName}</h1>
              <p className="muted" style={{ margin: '6px 0 0' }}>{user.startupName}{user.tagline ? ` — "${user.tagline}"` : ''}</p>
            </div>
            <div className="row">
              <span className="badge">Tick <b className="mono">{ms?.tick ?? 0}</b></span>
              <span className="badge">Net <b className="mono" style={{ color: (ms?.netProfit ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmt.currency(ms?.netProfit, true)}</b></span>
            </div>
          </div>
          {ms && (
            <div style={{ marginTop: 14 }}>
              <div className="row" style={{ justifyContent: 'space-between', fontSize: 12 }}>
                <span className="muted">Budget {fmt.currency(ms.budget, true)} / {fmt.currency(ms.maxBudget, true)}</span>
                {ms.budget < ms.maxBudget * 0.2 && <span className="badge badge-red badge-pulse">🔥 burn alert</span>}
              </div>
              <div className="bar" style={{ marginTop: 6 }}>
                <div style={{ width: `${Math.max(0, Math.min(100, (ms.budget / ms.maxBudget) * 100))}%` }} />
              </div>
            </div>
          )}
        </div>

        {!ms && <div className="panel"><p className="muted">Loading your market state…</p></div>}

        {ms && (
          <>
            <div className="grid-4">
              <Metric label="Total Revenue" value={fmt.currency(ms.totalRevenue, true)} color="var(--green)" />
              <Metric label="Units Sold" value={fmt.units(ms.totalUnitsSold)} color="var(--ember-hot)" />
              <Metric label="Conversion" value={fmt.percent(ms.conversionRate)} color="var(--purple)" />
              <Metric label="Unit Price" value={fmt.currency(ms.productPrice)} color="var(--gold)" />
              <Metric label="Demand Index" value={Number(ms.demandIndex).toFixed(1)} color="var(--cyan)" />
              <Metric label="Budget" value={fmt.currency(ms.budget, true)} color={ms.budget < ms.maxBudget * 0.2 ? 'var(--red)' : 'var(--green)'} />
              <Metric label="Quality" value={quality?.composite != null ? `★ ${Number(quality.composite).toFixed(1)}` : '—'} color="var(--gold)" />
              <Metric label="Deploys" value={ms.deployCount ?? 0} />
            </div>

            <QualityPanel quality={quality} attrs={state?.qualityAttributes} />

            <div className="grid-2">
              <div className="panel">
                <div className="panel-h">📈 Revenue &amp; Demand</div>
                <Chart ms={ms} />
              </div>
              <Console ms={ms} phase={phase} busy={busy} onDeploy={deploy} />
            </div>

            <div className="panel">
              <div className="panel-h">⚡ Active Shocks</div>
              {(state?.activeShocks?.length ?? 0) === 0 && <div className="empty-note">No shocks active. Enjoy the calm — it never lasts.</div>}
              <div className="stack">
                {(state?.activeShocks || []).map((s) => <ShockCard key={s.instanceId} shock={s} category={ms.category} />)}
              </div>
            </div>

            <div className="grid-2">
              <div className="panel">
                <div className="panel-h">🧱 Business Model Canvas <span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>— click a block to edit</span></div>
                <div className="bmc-grid">
                  {BMC_FIELDS.map(([f, label]) => (
                    <div key={f} className="bmc-cell" onClick={() => setBmcEdit({ field: f, label, value: ms.bmc?.[f] || '' })}>
                      <h4>{label}</h4>
                      <p>{ms.bmc?.[f] || ''}</p>
                    </div>
                  ))}
                </div>
              </div>
              <div className="stack">
                <div className="panel">
                  <div className="panel-h">📜 Event Log</div>
                  <div className="log">
                    {log.length === 0 && <div className="empty-note">Deploy your first strategy to start the simulation…</div>}
                    {log.map((e, i) => (
                      <div key={`${e.tick}-${i}`} className="log-row">
                        <span className="tm">{e.time}</span>
                        <span className="tk">T{e.tick}</span>
                        <span className="g">+{fmt.currency(e.revenue, true)}</span>
                        <span className="c">{fmt.units(e.units)} units</span>
                        <span className="m">{Number(e.conv).toFixed(1)}% CVR</span>
                        {e.shocks.length > 0 && <span style={{ color: 'var(--gold)' }}>⚡ {e.shocks.join(', ')}</span>}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="panel">
                  <div className="panel-h">🏆 Leaderboard</div>
                  {(state?.leaderboard?.length ?? 0) === 0 && <div className="empty-note">No standings yet.</div>}
                  {(state?.leaderboard || []).slice(0, 6).map((t, i) => (
                    <div key={t.teamId} className="feed-row" style={{ paddingLeft: 0, paddingRight: 0 }}>
                      <span className="rank">{String(i + 1).padStart(2, '0')}</span>
                      <div className="grow">
                        <div className="nm">{t.teamName}{String(t.teamId) === String(teamId) ? ' ◄ you' : ''}</div>
                        <div className="sub">{t.startupName} · {t.category}</div>
                      </div>
                      <span className="mono" style={{ color: 'var(--green)', fontSize: 12 }}>{fmt.currency(t.totalRevenue, true)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {bmcEdit && <BmcModal edit={bmcEdit} onSave={saveBmc} onClose={() => setBmcEdit(null)} />}
      <Toasts items={items} />
    </div>
  );
}

function PhaseBadge({ phase }) {
  const cls = phase === 'active' ? 'badge-green badge-pulse' : phase === 'ended' ? 'badge-purple' : 'badge-amber';
  return <span className={`badge ${cls}`}>{phase === 'active' ? '● LIVE' : PHASE_LABEL[phase] || phase}</span>;
}

function QualityPanel({ quality, attrs }) {
  if (quality?.composite == null) {
    return (
      <div className="panel"><div className="panel-h">⭐ Judge Product-Rating</div>
        <div className="empty-note">Awaiting judge product-rating.</div></div>
    );
  }
  const list = attrs?.length ? attrs : [];
  return (
    <div className="panel"><div className="panel-h">⭐ Judge Product-Rating — {Number(quality.composite).toFixed(1)}/10</div>
      {list.map((a) => {
        const s = quality.scores?.[a.id];
        return (
          <div key={a.id} className="q-row">
            <span className="ql">{a.label} <span className="muted">×{a.weight}</span></span>
            {s == null ? <span className="muted">not rated</span> :
              <><span className="q-dots">{'●'.repeat(s)}{'○'.repeat(10 - s)}</span><span className="mono">{s}/10</span></>}
          </div>
        );
      })}
    </div>
  );
}

function Chart({ ms }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.offsetWidth, H = canvas.offsetHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let i = 0; i <= 4; i++) {
      const y = (H / 4) * i;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    const draw = (data, color, fill) => {
      if (!data || data.length < 2) return;
      const max = Math.max(...data, 1);
      const pts = data.map((v, i) => ({ x: (i / (data.length - 1)) * W, y: H - (v / max) * (H - 20) - 10 }));
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      if (fill) {
        ctx.save();
        ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
        const g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, 'rgba(255,122,0,0.35)'); g.addColorStop(1, 'rgba(255,122,0,0)');
        ctx.fillStyle = g; ctx.fill(); ctx.restore();
        ctx.beginPath();
        pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      }
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
      const last = pts[pts.length - 1];
      ctx.beginPath(); ctx.arc(last.x, last.y, 4, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    };
    draw(ms.revenueHistory, '#ff7a00', true);
    draw((ms.demandHistory || []).map((d) => d * 50), '#b388ff', false);
    ctx.font = '10px monospace'; ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fillText('Revenue', 8, 14); ctx.fillText('Demand ×50', 8, 28);
  }, [ms]);
  return <canvas ref={ref} className="chart" />;
}

/* Strategy console with draft-preserving sliders:
   server values seed the draft; polls only re-seed when the server value
   actually changed AND the user isn't touching the console. */
function Console({ ms, phase, busy, onDeploy }) {  const [draft, setDraft] = useState(() => ({
    price: ms.productPrice, mkt: ms.marketingSpend, segment: ms.targetSegment || 'mass',
  }));
  const synced = useRef({ price: ms.productPrice, mkt: ms.marketingSpend, segment: ms.targetSegment });
  const editing = useRef(false);

  useEffect(() => {
    if (editing.current) return;
    const s = synced.current;
    let changed = false;
    const next = { ...draft };
    if (ms.productPrice !== s.price) { next.price = ms.productPrice; changed = true; }
    if (ms.marketingSpend !== s.mkt) { next.mkt = ms.marketingSpend; changed = true; }
    if (ms.targetSegment !== s.segment) { next.segment = ms.targetSegment; changed = true; }
    if (changed) {
      setDraft(next);
      synced.current = { price: ms.productPrice, mkt: ms.marketingSpend, segment: ms.targetSegment };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms]);

  const deployable = phase === 'active' && !busy;
  const al = ms.allowance;
  const ticksLeft = al ? al.ticksMax - al.ticksUsed : null;
  const hourlyLeft = al ? al.hourlyMax - al.hourlyUsed : null;
  const capped = al && (ticksLeft <= 0 || hourlyLeft <= 0);
  const capReason = !al ? '' : ticksLeft <= 0
    ? `Tick allowance used up (${al.ticksUsed}/${al.ticksMax}). No more deploys this event.`
    : hourlyLeft <= 0
      ? `Hourly limit reached (${al.hourlyUsed}/${al.hourlyMax} this hour). Try again later.`
      : '';
  return (
    <div className="panel"
      onFocus={() => { editing.current = true; }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) editing.current = false; }}
      onPointerDown={() => { editing.current = true; }}
      onPointerUp={() => { editing.current = false; }}>
      <div className="panel-h">🎮 Strategy Console</div>

      {al && (
        <div className="row" style={{ marginBottom: 12 }}>
          <span className={`badge ${ticksLeft <= 0 ? 'badge-red' : 'badge-ember'}`}>🎟 Ticks {al.ticksMax - al.ticksUsed}/{al.ticksMax} left</span>
          <span className={`badge ${hourlyLeft <= 0 ? 'badge-red' : ''}`}>⏳ Hourly {al.hourlyMax - al.hourlyUsed}/{al.hourlyMax} left</span>
        </div>
      )}

      <div className="field">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <label className="label" htmlFor="dash-price">Unit Price</label>
          <span className="mono" style={{ color: 'var(--ember-hot)', fontWeight: 700 }}>{fmt.currency(draft.price)}</span>
        </div>
        <input id="dash-price" type="range" className="slider" min={99} max={9999} step={50}
          value={draft.price} onChange={(e) => setDraft((d) => ({ ...d, price: Number(e.target.value) }))} />
        <input className="input mono" type="number" min={99} max={9999}
          value={draft.price} onChange={(e) => setDraft((d) => ({ ...d, price: Number(e.target.value) }))} aria-label="Exact price" />
      </div>

      <div className="field">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <label className="label" htmlFor="dash-mkt">Marketing Spend / Tick</label>
          <span className="mono" style={{ color: 'var(--ember-hot)', fontWeight: 700 }}>{fmt.currency(draft.mkt)}</span>
        </div>
        <input id="dash-mkt" type="range" className="slider" min={0} max={30000} step={500}
          value={draft.mkt} onChange={(e) => setDraft((d) => ({ ...d, mkt: Number(e.target.value) }))} />
        <input className="input mono" type="number" min={0} max={30000}
          value={draft.mkt} onChange={(e) => setDraft((d) => ({ ...d, mkt: Number(e.target.value) }))} aria-label="Exact marketing spend" />
      </div>

      <div className="field">
        <label className="label" htmlFor="dash-seg">Target Segment</label>
        <select id="dash-seg" className="input" value={draft.segment} onChange={(e) => setDraft((d) => ({ ...d, segment: e.target.value }))}>
          <option value="mass">🌐 Mass Market — broad reach, avg CVR</option>
          <option value="premium">💎 Premium — smaller pool, 1.4× CVR</option>
          <option value="niche">🎯 Niche — ultra-targeted, 1.8× CVR</option>
        </select>
        <p className="muted" style={{ fontSize: 12, margin: '2px 0 0' }}>{SEGMENT_INFO[draft.segment]?.hint}</p>
      </div>

      <button className="btn btn-primary btn-full" disabled={!deployable || capped}
        title={phase !== 'active' ? 'Waiting for the Game Master' : capReason}
        onClick={() => onDeploy({ productPrice: draft.price, marketingSpend: draft.mkt, targetSegment: draft.segment })}>
        {busy && <span className="spinner" />} 🚀 Deploy Strategy
      </button>
      {capped && <p className="form-error" style={{ marginTop: 10 }}>{capReason}</p>}
      <p className="muted" style={{ fontSize: 12, textAlign: 'center' }}>Each deploy = one market simulation tick</p>
    </div>
  );
}

function BmcModal({ edit, onSave, onClose }) {
  const [value, setValue] = useState(edit.value);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    await onSave(edit.field, value.slice(0, 2000));
    setBusy(false);
  };
  return (
    <Modal title={`Edit: ${edit.label}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="field">
          <textarea className="input" value={value} onChange={(e) => setValue(e.target.value)} maxLength={2000} autoFocus />
          <span className="muted mono" style={{ fontSize: 11 }}>{value.length}/2000</span>
        </div>
        <button className="btn btn-primary btn-full" type="submit" disabled={busy}>
          {busy && <span className="spinner" />} Save Block
        </button>
      </form>
    </Modal>
  );
}
