import { useEffect, useState } from 'react';
import { api, getCurrentUser } from '../api.js';
import { Password, Toasts } from '../components.jsx';
import { useToasts } from '../hooks.js';

/* Standalone login pages for staff:
     #/judge  — judges, by code
     #/gm     — Game Master / admin, by passphrase
   Linked from the landing-page footer; each door only opens with the right
   credential. */
export default function StaffLogin({ kind, nav }) {
  const isJudge = kind === 'judge';
  const { items, toast } = useToasts();
  const [value, setValue] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const u = getCurrentUser();
    if (u?.role === 'judge') nav('/staff');
    else if (u?.role === 'admin') nav('/admin');
  }, [nav]);

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (!value.trim()) return setErr(isJudge ? 'Enter your judge code.' : 'Enter the passphrase.');
    setBusy(true);
    try {
      if (isJudge) { await api.loginJudgeCode(value.trim()); nav('/staff'); }
      else { await api.loginJudge(value); nav('/admin'); }
    } catch (ex) {
      setErr(ex.message);
      setBusy(false);
    }
  };

  return (
    <div className="page" style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
      <div className="panel" style={{ width: 'min(420px, 92vw)' }}>
        <p className="eyebrow" style={{ marginTop: 0 }}>Startup Survivor</p>
        <h1 className="h-display" style={{ fontSize: 28, margin: '0 0 4px' }}>
          {isJudge ? <>Judge <span className="fire">access</span></> : <>Game <span className="fire">Master</span></>}
        </h1>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          {isJudge
            ? 'Enter the code from your judge card. Every judge has their own, so scores and approvals are attributed to you.'
            : 'Run the event: phases, ticks, shocks and the halftime cut.'}
        </p>

        <form onSubmit={submit}>
          <div className="field">
            <label className="label" htmlFor="staff-secret">
              {isJudge ? 'Judge Code' : 'Access Passphrase'} <span className="req">*</span>
            </label>
            {isJudge ? (
              <input id="staff-secret" className="input mono" value={value} autoFocus autoComplete="off"
                style={{ textTransform: 'uppercase', letterSpacing: 2, fontSize: 18 }}
                placeholder="e.g. JUDGE1" onChange={(e) => setValue(e.target.value)} />
            ) : (
              <Password id="staff-secret" value={value} onChange={setValue}
                placeholder="Enter passphrase" autoComplete="current-password" />
            )}
          </div>
          {err && <p className="form-error">{err}</p>}
          <button className="btn btn-primary btn-full" type="submit" disabled={busy}>
            {busy && <span className="spinner" />} {isJudge ? 'Enter Judge Panel' : 'Enter Control Room'}
          </button>
        </form>

        <p className="switch-line" style={{ marginBottom: 0 }}>
          <button type="button" onClick={() => nav('/')}>← Back to the arena</button>
        </p>
      </div>
      <Toasts items={items} />
    </div>
  );
}
