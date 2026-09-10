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

  useEffect(() => {
    if (!user || user.role !== 'judge') nav('/');
  }, [user, nav]);

  useEffect(() => {
    api.catalog().then(setCatalog).catch(() => {});
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

        <div className="grid-2">
          <div className="panel">
            <div className="panel-h">👥 Teams ({teams.length})</div>
            {teams.length === 0 && <div className="empty-note">No teams have joined yet. Share the URL.</div>}
            {teams.length > 0 && (
              <table className="tbl">
                <thead><tr><th>Squad</th><th>Revenue</th><th>Budget</th><th>Quality</th><th></th></tr></thead>
                <tbody>
                  {teams.map((t) => {
                    const lb = state?.leaderboard?.find((l) => String(l.teamId) === String(t.id));
                    const q = state?.quality?.[t.id];
                    return (
                      <tr key={t.id}>
                        <td><b>{t.teamName}</b><br /><span className="muted" style={{ fontSize: 11 }}>{t.startupName} · {t.category}</span></td>
                        <td className="mono" style={{ color: 'var(--green)' }}>{fmt.currency(lb?.totalRevenue, true)}</td>
                        <td className="mono">{fmt.currency(lb?.budget, true)}</td>
                        <td className="mono" style={{ color: 'var(--gold)' }}>{q?.composite != null ? `★ ${Number(q.composite).toFixed(1)}` : '—'}</td>
                        <td><button className="btn btn-ghost btn-sm" onClick={() => setScoring(t)}>Rate</button></td>
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
      <Toasts items={items} />
    </div>
  );
}

function TargetModal({ shock, teams, toast, refresh, close }) {
  const [teamId, setTeamId] = useState('');
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
