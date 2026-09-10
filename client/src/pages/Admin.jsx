import { useCallback, useEffect, useState } from 'react';
import { api, fmt, getCurrentUser, PHASE_LABEL } from '../api.js';
import { Modal, ShockCard, Toasts, TopBar } from '../components.jsx';
import { usePoll, useToasts } from '../hooks.js';

const FALLBACK_ATTRS = [
  { id: 'innovation', label: 'Innovation', weight: 0.25 },
  { id: 'usability', label: 'Usability & Craft', weight: 0.2 },
  { id: 'market_fit', label: 'Market Fit', weight: 0.25 },
  { id: 'execution', label: 'Execution', weight: 0.15 },
  { id: 'storytelling', label: 'Pitch & Story', weight: 0.15 },
];

export default function Admin({ nav }) {
  const [user] = useState(() => getCurrentUser());
  const { items, toast } = useToasts();
  const [state, setState] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [targeting, setTargeting] = useState(null); // shockId to deploy with target
  const [scoring, setScoring] = useState(null); // teamId being scored
  const [detail, setDetail] = useState(null); // team object for detail view
  const [grading, setGrading] = useState(null);

  useEffect(() => {
    if (!user || user.role !== 'admin') nav('/');
  }, [user, nav]);

  useEffect(() => {
    api.catalog().then(setCatalog).catch(() => {});
  }, []);

  // The tick is gated on grading, so admin needs to see exactly what is
  // outstanding rather than just being told "no".
  useEffect(() => {
    const load = () => api.gradingStatus().then(setGrading).catch(() => {});
    load();
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, []);

  const fetchState = useCallback(() => api.gameState(), []);
  const onState = useCallback((s) => setState(s), []);
  usePoll(fetchState, onState, 1500, !!user);

  const act = async (fn, okMsg, failMsg) => {
    try {
      const s = await fn();
      if (s && s.gamePhase) setState(s);
      else setState(await api.gameState());
      if (okMsg) toast.success(...okMsg);
    } catch (e) {
      toast.error(failMsg, e.message);
    }
  };

  const logout = async () => {
    await api.logout();
    nav('/');
  };

  if (!user) return null;
  const phase = state?.gamePhase || 'lobby';
  const teams = state?.teams || [];
  const attrs = state?.qualityAttributes?.length ? state.qualityAttributes : FALLBACK_ATTRS;

  return (
    <div className="page">
      <TopBar>
        <span className="badge badge-purple">Game Master</span>
        <span className={`badge ${phase === 'active' ? 'badge-green badge-pulse' : 'badge-amber'}`}>
          {phase === 'active' ? '● LIVE' : PHASE_LABEL[phase]}
        </span>
        <button className="btn btn-dark btn-sm" onClick={() => nav('/logs')}>📜 Logs</button>
        <button className="btn btn-dark btn-sm" onClick={logout}>Logout</button>
      </TopBar>

      <div className="wrap stack" style={{ marginTop: 20 }}>
        <div className="panel">
          <div className="panel-h">🎛 Game Control</div>
          <div className="row">
            <button className="btn btn-primary btn-sm" disabled={phase !== 'lobby'} onClick={() => act(() => api.gameAction('start'), ['Session started', 'Teams can now deploy.'], 'Start failed')}>▶ Start</button>
            <button className="btn btn-dark btn-sm" disabled={phase !== 'active'} onClick={() => act(() => api.gameAction('pause'), ['Paused'], 'Pause failed')}>⏸ Pause</button>
            <button className="btn btn-dark btn-sm" disabled={phase !== 'paused'} onClick={() => act(() => api.gameAction('resume'), ['Resumed'], 'Resume failed')}>⏵ Resume</button>
            <button className="btn btn-dark btn-sm" disabled={phase !== 'active' && phase !== 'paused'} onClick={() => act(() => api.gameAction('end'), ['Session ended'], 'End failed')}>🏁 End</button>
            <button className="btn btn-danger btn-sm" onClick={() => { if (window.confirm('Wipe all teams and reset the arena?')) act(() => api.resetGame(), ['Arena reset'], 'Reset failed'); }}>🗑 Reset</button>
            <span className="muted mono" style={{ fontSize: 12, marginLeft: 'auto' }}>Tick {state?.gameTick ?? 0} · {teams.length} teams</span>
          </div>
        </div>

        {/* Grading gate: the tick will not run on a half-graded field. */}
        <div className="panel" style={{ borderColor: grading?.complete ? 'var(--green)' : 'var(--gold)' }}>
          <div className="panel-h">
            {grading?.complete ? '✅ Grading complete — tick can run' : '⏳ Waiting on grading'}
            <span className="muted" style={{ textTransform: 'none', letterSpacing: 0, marginLeft: 8 }}>
              round {grading?.round ?? '—'} · tick {grading?.tick ?? '—'} · {grading?.gradingMinutes ?? 25} min window
            </span>
          </div>
          {!grading?.complete && (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                <b>{grading?.undecided?.length ?? 0}</b> pricing decision(s) and{' '}
                <b>{grading?.unrated?.length ?? 0}</b> unrated document(s) outstanding.
                Results are computed from document points, so the tick stays locked until
                judges finish.
              </p>
              <div className="log" style={{ maxHeight: 160 }}>
                {(grading?.undecided || []).map(u => (
                  <div key={`d${u.id}`} className="log-row">
                    <span className="badge badge-red">decide</span>
                    <span className="grow">{u.teamName} — {u.doc}</span>
                  </div>
                ))}
                {(grading?.unrated || []).map(u => (
                  <div key={`r${u.id}`} className="log-row">
                    <span className="badge badge-amber">rate</span>
                    <span className="grow">{u.teamName} — {u.doc}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn btn-primary btn-sm" disabled={phase !== 'active'}
              onClick={() => act(() => api.runTick(false), ['Tick complete'], 'Tick blocked')}>
              ▶ Run tick
            </button>
            <button className="btn btn-danger btn-sm" disabled={phase !== 'active' || grading?.complete}
              onClick={() => {
                if (window.confirm(`Force the tick with ${grading?.total ?? 0} item(s) still ungraded? This is logged.`))
                  act(() => api.runTick(true), ['Tick FORCED'], 'Force failed');
              }}>
              ⚠ Force tick (judge unavailable)
            </button>
          </div>
        </div>

        <div className="grid-2">
          <div className="panel">
            <div className="panel-h">👥 Teams ({teams.length}) — click a row for full detail</div>
            {teams.length === 0 && <div className="empty-note">No teams have joined yet. Share the URL.</div>}
            {teams.length > 0 && (
              <table className="tbl">
                <thead><tr><th>Squad</th><th>Revenue</th><th>Budget</th><th>Quality</th><th></th></tr></thead>
                <tbody>
                  {teams.map((t) => {
                    const lb = state?.leaderboard?.find((l) => String(l.teamId) === String(t.id));
                    const q = state?.quality?.[t.id];
                    return (
                      <tr key={t.id} onClick={() => setDetail(t)} style={{ cursor: 'pointer' }} title="Click for full team detail">
                        <td><b>{t.teamName}</b><br /><span className="muted" style={{ fontSize: 11 }}>{t.startupName} · {t.category}</span></td>
                        <td className="mono" style={{ color: 'var(--green)' }}>{fmt.currency(lb?.totalRevenue, true)}</td>
                        <td className="mono">{fmt.currency(lb?.budget, true)}</td>
                        <td className="mono" style={{ color: 'var(--gold)' }}>{q?.composite != null ? `★ ${Number(q.composite).toFixed(1)}` : '—'}</td>
                        <td><button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); setScoring(t); }}>Rate</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <div className="panel-h">🏆 Leaderboard</div>
            {(state?.leaderboard?.length ?? 0) === 0 && <div className="empty-note">Standings appear after first deploy.</div>}
            {(state?.leaderboard || []).map((t, i) => (
              <div key={t.teamId} className="feed-row" style={{ paddingLeft: 0, paddingRight: 0 }}>
                <span className="rank">{String(i + 1).padStart(2, '0')}</span>
                <div className="grow">
                  <div className="nm">{t.teamName}</div>
                  <div className="sub">{t.startupName} · T{t.tick}</div>
                </div>
                <span className="mono" style={{ color: 'var(--green)', fontSize: 12 }}>{fmt.currency(t.totalRevenue, true)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-h">⚡ Shock Arsenal — click to fire globally, or target a team</div>
          <div className="card-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
            {catalog.map((s) => (
              <div key={s.id} className="rule-card" style={{ textAlign: 'left' }}>
                <div style={{ fontSize: 26 }}>{s.emoji}</div>
                <h3 style={{ marginTop: 8 }}>{s.name}</h3>
                <p>{s.description}</p>
                <div className="row" style={{ marginTop: 12 }}>
                  <span className="badge">{s.category}</span>
                  <span className="badge badge-amber">{s.severity}</span>
                </div>
                <div className="row" style={{ marginTop: 12 }}>
                  <button className="btn btn-primary btn-sm" onClick={() => act(() => api.deployShock(s.id, null), [`${s.name} deployed`, 'All teams hit.'], 'Deploy failed')}>Fire all</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setTargeting(s)}>Target…</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <CustomShock toast={toast} teams={teams} refresh={() => api.gameState().then(setState)} />

        <DeploymentsPanel teams={teams} />

        <div className="panel">
          <div className="panel-h">🌩 Active Shocks ({state?.activeShocks?.length ?? 0})</div>
          {(state?.activeShocks?.length ?? 0) === 0 && <div className="empty-note">No active shocks. Deploy from the arsenal above.</div>}
          <div className="stack">
            {(state?.activeShocks || []).map((s) => (
              <div key={s.instanceId} className="row" style={{ alignItems: 'stretch' }}>
                <div style={{ flex: 1 }}><ShockCard shock={s} /></div>
                <button className="btn btn-dark btn-sm" onClick={() => act(() => api.resolveShock(s.instanceId), ['Shock resolved'], 'Resolve failed')}>Resolve</button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {targeting && <TargetModal shock={targeting} teams={teams} toast={toast} refresh={() => api.gameState().then(setState)} close={() => setTargeting(null)} />}
      {scoring && <ScoreModal team={scoring} attrs={attrs} existing={state?.quality?.[scoring.id]} toast={toast} refresh={() => api.gameState().then(setState)} close={() => setScoring(null)} />}
      {detail && <TeamDetail team={detail} toast={toast} close={() => setDetail(null)} />}
      <Toasts items={items} />
    </div>
  );
}

function DeploymentsPanel({ teams }) {
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState('');
  const load = useCallback(async () => {
    try {
      setRows(await api.deployments(filter || null, 50));
    } catch { /* best-effort live log */ }
  }, [filter]);
  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);
  return (
    <div className="panel">
      <div className="panel-h">📋 Deployment Log <span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>— every tick, every team</span></div>
      <div className="row" style={{ marginBottom: 12 }}>
        <select className="input" style={{ maxWidth: 260 }} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter by team">
          <option value="">🌍 All teams</option>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.teamName}</option>)}
        </select>
        <button className="btn btn-dark btn-sm" onClick={load}>↻ Refresh</button>
      </div>
      {rows.length === 0 && <div className="empty-note">No deployments yet. Ticks appear here live.</div>}
      {rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead><tr><th>Time</th><th>Team</th><th>Tk</th><th>Price</th><th>Mkt Spend</th><th>Seg</th><th>Units</th><th>Revenue</th><th>Cost</th><th>CVR</th></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>{fmt.time(d.at)}</td>
                  <td><b>{d.teamName}</b></td>
                  <td className="mono">T{d.tick}</td>
                  <td className="mono">{fmt.currency(d.price)}</td>
                  <td className="mono">{fmt.currency(d.marketingSpend, true)}</td>
                  <td><span className="badge">{d.targetSegment || '—'}</span></td>
                  <td className="mono">{fmt.units(d.units)}</td>
                  <td className="mono" style={{ color: 'var(--green)' }}>+{fmt.currency(d.revenue, true)}</td>
                  <td className="mono" style={{ color: 'var(--red)' }}>-{fmt.currency(d.cost, true)}</td>
                  <td className="mono">{fmt.percent(d.conversion)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TeamDetail({ team, toast, close }) {
  const [stats, setStats] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.teamStats(team.id).then(setStats).catch((e) => setErr(e.message));
  }, [team.id]);
  const m = stats?.market;
  return (
    <Modal title={`${team.teamName} <em>— dossier</em>`} onClose={close} wide>
      {!stats && !err && <p className="muted">Loading full team record…</p>}
      {err && <p className="form-error">{err}</p>}
      {stats && (
        <div className="stack">
          <div className="row">
            <span className="badge badge-ember">{stats.team.category}</span>
            <span className="muted" style={{ fontSize: 13 }}>{stats.team.startupName}{stats.team.tagline ? ` — "${stats.team.tagline}"` : ''}</span>
            <span className="badge" style={{ marginLeft: 'auto' }}>🎟 {stats.allowance.ticksMax - stats.allowance.ticksUsed}/{stats.allowance.ticksMax} ticks left · ⏳ {stats.allowance.hourlyMax - stats.allowance.hourlyUsed}/{stats.allowance.hourlyMax} hourly</span>
          </div>
          <div className="grid-4">
            <div className="metric"><div className="k">Revenue</div><div className="v" style={{ color: 'var(--green)' }}>{fmt.currency(m?.totalRevenue, true)}</div></div>
            <div className="metric"><div className="k">Net Profit</div><div className="v" style={{ color: (m?.netProfit ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmt.currency(m?.netProfit, true)}</div></div>
            <div className="metric"><div className="k">Budget</div><div className="v">{fmt.currency(m?.budget, true)}</div></div>
            <div className="metric"><div className="k">Units</div><div className="v">{fmt.units(stats.totals.units)}</div></div>
          </div>
          <div className="panel-h" style={{ marginBottom: 8 }}>💸 Spend breakdown ({stats.totals.deployments} ticks)</div>
          <div className="q-row"><span className="ql">📣 Marketing</span><span className="mono">{fmt.currency(stats.spend.marketing, true)}</span></div>
          <div className="q-row"><span className="ql"><b>Total spend</b></span><span className="mono" style={{ color: 'var(--red)' }}><b>{fmt.currency(stats.spend.total, true)}</b></span></div>
          <div className="q-row"><span className="ql">Avg price · segment mix</span><span className="mono">{fmt.currency(stats.totals.avgPrice)} · {(stats.segmentMix || []).map((s) => `${s.target_segment || '?'}×${s.n}`).join(' ') || '—'}</span></div>
          <div className="panel-h" style={{ marginBottom: 8, marginTop: 8 }}>📋 Deployment history</div>
          {(stats.deployments?.length ?? 0) === 0 && <div className="empty-note">No deployments yet.</div>}
          {(stats.deployments || []).map((d) => (
            <div key={d.id} className="log-row">
              <span className="tm">{fmt.time(d.at)}</span>
              <span className="tk">T{d.tick}</span>
              <span>{fmt.currency(d.price)}</span>
              <span className="m">mkt {fmt.currency(d.marketingSpend, true)}</span>
              <span className="c">{d.targetSegment || '—'}</span>
              <span className="g">+{fmt.currency(d.revenue, true)}</span>
              <span style={{ color: 'var(--red)' }}>-{fmt.currency(d.cost, true)}</span>
              <span className="m">{fmt.units(d.units)}u · {fmt.percent(d.conversion)}</span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function TargetModal({ shock, teams, toast, refresh, close }) {  const [teamId, setTeamId] = useState('');
  const [busy, setBusy] = useState(false);
  const fire = async () => {
    setBusy(true);
    try {
      await api.deployShock(shock.id, teamId || null);
      await refresh();
      toast.success(`${shock.name} deployed`, teamId ? 'Targeted strike.' : 'All teams hit.');
      close();
    } catch (e) {
      toast.error('Deploy failed', e.message);
      setBusy(false);
    }
  };
  return (
    <Modal title={`Target: ${shock.name}`} onClose={close}>
      <div className="field">
        <label className="label" htmlFor="tgt-team">Target team (blank = everyone)</label>
        <select id="tgt-team" className="input" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          <option value="">🌍 All teams</option>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.teamName} — {t.startupName}</option>)}
        </select>
      </div>
      <button className="btn btn-primary btn-full" disabled={busy} onClick={fire}>
        {busy && <span className="spinner" />} Fire {shock.emoji}
      </button>
    </Modal>
  );
}

function CustomShock({ toast, teams, refresh }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [demand, setDemand] = useState(0);
  const [budget, setBudget] = useState(0);
  const [conversion, setConversion] = useState(0);
  const [duration, setDuration] = useState(2);
  const [teamId, setTeamId] = useState('');
  const [busy, setBusy] = useState(false);

  const fire = async (e) => {
    e.preventDefault();
    if (!name.trim()) return toast.warning('Name required', 'Give the custom shock a name.');
    setBusy(true);
    try {
      await api.customShock({
        name: name.trim(), description,
        demandDelta: Number(demand), budgetDelta: Number(budget),
        conversionDelta: Number(conversion), durationMins: Number(duration),
        targetTeamId: teamId || null,
      });
      await refresh();
      toast.success('Custom shock deployed');
      setName(''); setDescription('');
    } catch (ex) {
      toast.error('Deploy failed', ex.message);
    }
    setBusy(false);
  };

  return (
    <div className="panel">
      <div className="panel-h">🧪 Custom Shock Lab</div>
      <form onSubmit={fire}>
        <div className="grid-2">
          <div className="field"><label className="label">Name *</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="e.g. Influencer Meltdown" /></div>
          <div className="field"><label className="label">Target (blank = all)</label>
            <select className="input" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">🌍 All teams</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.teamName}</option>)}
            </select></div>
        </div>
        <div className="field"><label className="label">Description</label>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} placeholder="What happened in the market…" /></div>
        <div className="grid-4">
          <div className="field"><label className="label">Demand % ({demand})</label>
            <input type="range" className="slider" min={-90} max={200} value={demand} onChange={(e) => setDemand(e.target.value)} /></div>
          <div className="field"><label className="label">Budget % ({budget})</label>
            <input type="range" className="slider" min={-90} max={200} value={budget} onChange={(e) => setBudget(e.target.value)} /></div>
          <div className="field"><label className="label">Conversion % ({conversion})</label>
            <input type="range" className="slider" min={-90} max={200} value={conversion} onChange={(e) => setConversion(e.target.value)} /></div>
          <div className="field"><label className="label">Duration (min)</label>
            <input type="number" className="input mono" min={1} max={60} value={duration} onChange={(e) => setDuration(e.target.value)} /></div>
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy}>{busy && <span className="spinner" />} ⚡ Fire Custom Shock</button>
      </form>
    </div>
  );
}

function ScoreModal({ team, attrs, existing, toast, refresh, close }) {
  const [scores, setScores] = useState(() => {
    const init = {};
    for (const a of attrs) if (existing?.scores?.[a.id] != null) init[a.id] = existing.scores[a.id];
    return init;
  });
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const filled = Object.fromEntries(Object.entries(scores).filter(([, v]) => v !== '' && v != null));
    if (Object.keys(filled).length === 0) return toast.warning('No scores', 'Rate at least one attribute 1–10.');
    setBusy(true);
    try {
      await api.scoreQuality(team.id, filled);
      await refresh();
      toast.success('Scores saved', `${team.teamName} rated.`);
      close();
    } catch (ex) {
      toast.error('Save failed', ex.message);
      setBusy(false);
    }
  };

  return (
    <Modal title={`Rate: ${team.teamName}`} onClose={close} wide>
      <form onSubmit={submit}>
        {attrs.map((a) => (
          <div key={a.id} className="field">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <label className="label" htmlFor={`q-${a.id}`}>{a.label} <span className="muted">×{a.weight}</span></label>
              <span className="mono" style={{ color: 'var(--ember-hot)', fontWeight: 700 }}>{scores[a.id] ?? '—'}/10</span>
            </div>
            <input id={`q-${a.id}`} type="range" className="slider" min={1} max={10} step={1}
              value={scores[a.id] ?? 5}
              onChange={(e) => setScores((s) => ({ ...s, [a.id]: Number(e.target.value) }))} />
          </div>
        ))}
        <button className="btn btn-primary btn-full" type="submit" disabled={busy}>
          {busy && <span className="spinner" />} Save Ratings
        </button>
      </form>
    </Modal>
  );
}
