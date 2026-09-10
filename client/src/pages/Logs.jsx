import { useCallback, useEffect, useState } from 'react';
import { api, fmt, getCurrentUser } from '../api.js';
import { TopBar } from '../components.jsx';

/* The Logs panel — its own surface, not a tab buried in the control room
   (REDESIGN.md §C.3). It answers a different question from every other
   screen: not "what do I do now" but "what happened, and can I prove it."
   Staff-accessible; the write actions all live elsewhere. */

const KIND_TONE = {
  'tick.run': 'cyan', 'tick.complete': 'cyan', 'tick.auto_deploy': 'cyan', 'tick.carry_over': 'amber',
  'deploy.run': 'green', 'doc.submit': '', 'doc.submit_late': 'amber',
  'doc.approved': 'green', 'doc.rated': 'green', 'doc.rejected': 'red', 'doc.disqualified': 'red',
  'shock.fire': 'amber', 'shock.halftime': 'red', 'event.global': 'amber',
  'team.disqualified': 'red', 'team.reinstate': 'green', 'admin.reset': 'red',
  'score.set': 'purple', 'game.phase': 'purple',
};

export default function Logs({ nav }) {
  const [user] = useState(() => getCurrentUser());
  const [rows, setRows] = useState([]);
  const [results, setResults] = useState(null);
  const [kind, setKind] = useState('');
  const [teamId, setTeamId] = useState('');
  const [tab, setTab] = useState('log');
  const [err, setErr] = useState('');

  useEffect(() => { if (!user || (user.role !== 'admin' && user.role !== 'judge')) nav('/'); }, [user, nav]);

  const load = useCallback(async () => {
    try {
      setRows(await api.eventLog({ kind: kind || undefined, teamId: teamId || undefined, limit: 250 }));
      setErr('');
    } catch (e) { setErr(e.message); }
  }, [kind, teamId]);

  useEffect(() => { load(); const id = setInterval(load, 5000); return () => clearInterval(id); }, [load]);
  useEffect(() => { api.results().then(setResults).catch(() => {}); }, [tab]);

  if (!user) return null;
  const kinds = [...new Set(rows.map(r => r.kind))].sort();

  return (
    <div className="page">
      <TopBar>
        <span className="badge badge-purple">Logs · {user.name || user.role}</span>
        <button className="btn btn-dark btn-sm" onClick={() => nav(user.role === 'admin' ? '/admin' : '/staff')}>← Back</button>
      </TopBar>

      <div className="wrap" style={{ marginTop: 16 }}>
        <div className="row" style={{ gap: 8 }}>
          <button className={`btn btn-sm ${tab === 'log' ? 'btn-primary' : 'btn-dark'}`} onClick={() => setTab('log')}>📜 Event log</button>
          <button className={`btn btn-sm ${tab === 'results' ? 'btn-primary' : 'btn-dark'}`} onClick={() => setTab('results')}>🏁 Final standings</button>
          <a className="btn btn-ghost btn-sm" href="/api/event-log/export.csv" style={{ marginLeft: 'auto' }}>⬇ Export CSV</a>
        </div>
      </div>

      {tab === 'log' && (
        <div className="wrap stack" style={{ marginTop: 14 }}>
          <div className="panel">
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <select className="input" style={{ maxWidth: 220 }} value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="">All event types</option>
                {kinds.map(k => <option key={k} value={k}>{k}</option>)}
              </select>
              <input className="input" style={{ maxWidth: 160 }} placeholder="Filter by team id"
                value={teamId} onChange={(e) => setTeamId(e.target.value)} />
              <button className="btn btn-dark btn-sm" onClick={() => { setKind(''); setTeamId(''); }}>Clear</button>
              <span className="muted mono" style={{ marginLeft: 'auto', fontSize: 12 }}>{rows.length} entries</span>
            </div>
          </div>

          {err && <div className="panel"><p className="form-error" style={{ margin: 0 }}>{err}</p></div>}

          <div className="panel">
            <div className="panel-h">📜 Append-only event log — newest first</div>
            {rows.length === 0 && <div className="empty-note">Nothing logged yet.</div>}
            <div className="log">
              {rows.map(r => (
                <div key={r.id} className="log-row" style={{ alignItems: 'flex-start' }}>
                  <span className="tm" style={{ minWidth: 76 }}>{fmt.time(r.at)}</span>
                  <span className={`badge badge-${KIND_TONE[r.kind] ?? ''}`} style={{ minWidth: 128, justifyContent: 'center' }}>{r.kind}</span>
                  <span className="grow">{r.summary}</span>
                  <span className="muted mono" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                    {r.actorName || r.actorType}{r.teamId ? ` · team ${r.teamId}` : ''}{r.tick != null ? ` · T${r.tick}` : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === 'results' && (
        <div className="wrap stack" style={{ marginTop: 14 }}>
          <div className="panel">
            <div className="panel-h">🏁 How the final total is built</div>
            <p className="muted" style={{ marginTop: 0 }}>{results?.formula}</p>
            <div className="row" style={{ gap: 20, flexWrap: 'wrap' }}>
              <div><div className="eyebrow" style={{ margin: 0 }}>Market weight</div><div className="mono" style={{ fontSize: 20 }}>{results?.weights?.market ?? '—'}%</div></div>
              <div><div className="eyebrow" style={{ margin: 0 }}>Documents weight</div><div className="mono" style={{ fontSize: 20 }}>{results?.weights?.docs ?? '—'}%</div></div>
              <div><div className="eyebrow" style={{ margin: 0 }}>Status</div>
                <div className="mono" style={{ fontSize: 14 }}>{results?.frozenAt ? '🔒 frozen' : 'open'}</div></div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-h">Standings</div>
            {(results?.results?.length ?? 0) === 0 && <div className="empty-note">No teams yet.</div>}
            {results?.results?.length > 0 && (
              <table className="tbl">
                <thead><tr>
                  <th>#</th><th>Team</th>
                  <th>Money made / lost</th>
                  <th>Revenue</th>
                  <th>Docs in</th>
                  <th>Judge ★</th>
                  <th>Doc pts</th>
                  <th>Market /100</th>
                  <th>FINAL</th>
                </tr></thead>
                <tbody>
                  {results.results.map(r => (
                    <tr key={r.teamId} style={r.isDisqualified ? { opacity: 0.45 } : undefined}>
                      <td className="mono">{r.rank}</td>
                      <td>
                        <b style={r.isDisqualified ? { textDecoration: 'line-through' } : undefined}>{r.teamName}</b>
                        {r.isDisqualified && <span className="badge badge-red" style={{ marginLeft: 6 }}>DQ</span>}
                        {r.isInsolvent && <span className="badge badge-red" style={{ marginLeft: 6 }}>insolvent</span>}
                        <br /><span className="muted" style={{ fontSize: 11 }}>{r.startupName} · {r.category}</span>
                      </td>
                      {/* The headline number: what their cash actually did. */}
                      <td className="mono" style={{ color: r.moneyDelta >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>
                        {r.moneyDelta >= 0 ? '+' : '−'}{fmt.currency(Math.abs(r.moneyDelta), true)}
                        {r.debt > 0 && <span className="muted" style={{ display: 'block', fontSize: 10 }}>debt {fmt.currency(r.debt, true)}</span>}
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {fmt.currency(r.totalRevenue, true)}
                        <span className="muted" style={{ display: 'block', fontSize: 10 }}>{r.ticksPlayed} tick{r.ticksPlayed === 1 ? '' : 's'}</span>
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {r.submissions}/{r.submissionsPossible}
                        <span className="muted" style={{ display: 'block', fontSize: 10 }}>{r.pricingApproved} pricing ok</span>
                      </td>
                      <td className="mono" style={{ color: 'var(--gold)' }}>
                        {r.qualityScore == null ? '—' : `★ ${r.qualityScore.toFixed(1)}`}
                      </td>
                      <td className="mono">{r.docPoints}/{r.docCeiling}</td>
                      <td className="mono">{r.marketScore}</td>
                      <td className="mono" style={{ color: 'var(--ember-hot)', fontWeight: 700, fontSize: 16 }}>{r.finalScore}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
              <b>Money made / lost</b> is cash against the starting budget — what a team would
              actually recognise. <b>Market /100</b> is what the ranking uses: each tick scored
              against the field and averaged, so one lucky tick can't carry a team.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
