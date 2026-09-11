import { useEffect, useState } from 'react';
import { api, getCurrentUser } from '../api.js';
import { Modal, Password, Toasts } from '../components.jsx';
import { useToasts } from '../hooks.js';

const RULES = [
  ['01', '🔨', 'Build', 'Design your Business Model Canvas live. Lock in your value prop, channels and revenue model before the chaos begins.'],
  ['02', '🌊', 'Survive', 'The Game Master fires market shocks without warning. Recession. Scandals. Viral surges. One shock can wipe a bad team out.'],
  ['03', '🔄', 'Pivot', 'Adjust pricing, marketing spend and segment every tick. Stale strategies bleed money. Adapt or burn your budget.'],
  ['04', '🏆', 'Win', 'Highest revenue plus the most compelling pivot story wins the VC panel. Numbers talk. Narrative seals the deal.'],
];

const TICKER = [
  ['EduBiz.io', '₹0', 'Regulatory Crackdown'], ['DeliverFast', '-62%', 'Supply Chain Collapse'],
  ['CryptoSave', '+₹12K', 'DeFi Surge'], ['MediCore', '+142%', 'Post-pandemic Demand'],
  ['PayBridge', '-40%', 'Data Privacy Scandal'], ['GreenPath', '+38%', 'Carbon Mandate'],
  ['FundZap', '₹0', 'Series B Failed'], ['AgriSense', '+22%', 'AI Farming Boom'],
  ['SnapRetail', '-28%', 'Competitor Entry'], ['HealthTrack', '+89%', 'Viral Campaign'],
  ['LoanQuick', '-55%', 'Recession Q2'],
];

export default function Landing({ nav }) {
  const { items, toast } = useToasts();
  const [modal, setModal] = useState(null); // 'register' | 'login' | 'judge'
  const [teams, setTeams] = useState([]);

  useEffect(() => {
    const u = getCurrentUser();
    if (u?.role === 'team') nav('/dashboard');
    else if (u?.role === 'judge') nav('/staff');
    else if (u?.role === 'admin') nav('/admin');
  }, [nav]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const lb = await api.leaderboard();
        if (alive) setTeams(lb);
      } catch { /* public feed is best-effort */ }
    };
    load();
    const id = setInterval(load, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return (
    <div className="page">
      <section className="hero">
        <p className="eyebrow">V-TAPP · V-Launchpad · VIT-AP IIEC &amp; VTBIF</p>
        <h1 className="h-display hero-title">
          <span className="ghost">startup</span>
          <span className="fire">Survivor</span>
        </h1>
        <p className="hero-sub">The ultimate V-Launchpad challenge. <b>Will your startup survive?</b></p>
        <div className="hero-ctas">
          <button className="btn btn-primary" onClick={() => setModal('register')}>⚔ Register Squad</button>
          <button className="btn btn-ghost" onClick={() => setModal('login')}>🔑 Team Login</button>
        </div>
        <div className="stat-strip">
          <div><span className="n">{teams.length}</span><span className="l">Contenders</span></div>
          <div><span className="n">12</span><span className="l">Shocks Armed</span></div>
          <div><span className="n">🔥</span><span className="l">Mercy: Off</span></div>
        </div>
      </section>

      <section className="section wrap">
        <p className="eyebrow" style={{ textAlign: 'center' }}>// Rules of Engagement</p>
        <h2>What happens inside the arena</h2>
        <div className="card-grid">
          {RULES.map(([n, ic, h, p]) => (
            <div key={h} className="rule-card">
              <div className="n">{n}</div>
              <div className="ic">{ic}</div>
              <h3>{h}</h3>
              <p>{p}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section wrap">
        <p className="eyebrow" style={{ textAlign: 'center' }}>// Live Arena Intel</p>
        <h2>Registered squads</h2>
        <div className="feed">
          <div className="feed-h"><span className="eyebrow">Contenders</span><span className="badge badge-green badge-pulse">● live</span></div>
          {teams.length === 0 && <div className="empty-note">No squads registered yet. Share the arena link.</div>}
          {teams.slice(0, 8).map((t, i) => (
            <div key={t.teamId} className="feed-row">
              <span className="rank">{String(i + 1).padStart(2, '0')}</span>
              <div className="grow">
                <div className="nm">{t.teamName}</div>
                <div className="sub">{t.startupName} · {t.category}</div>
              </div>
              <span className="mono" style={{ color: 'var(--green)', fontSize: 12 }}>✓</span>
            </div>
          ))}
        </div>
      </section>

      <div className="ticker">
        <div className="ticker-track">
          {[...TICKER, ...TICKER].map(([n, v, w], i) => (
            <span key={i} style={{ padding: '0 26px' }}>
              <b>{n}</b> <span style={{ color: v.startsWith('+') ? 'var(--green)' : 'var(--red)' }}>{v}</span>
              <span style={{ opacity: 0.5 }}> · {w}</span>
            </span>
          ))}
        </div>
      </div>

      <footer className="footer">
        <div className="footer-brand">STARTUP SURVIVOR <span className="footer-sep">//</span> V-LAUNCHPAD</div>
        <nav className="footer-nav">
          <button type="button" onClick={() => nav('/judge')}>judge door</button>
          <span className="footer-sep">·</span>
          <button type="button" onClick={() => nav('/gm')}>game master</button>
        </nav>
        <div className="footer-credits">VIT-AP Entrepreneurship Club · IIEC &amp; VTBIF</div>
      </footer>

      {modal === 'register' && <RegisterModal nav={nav} toast={toast} switchTo={() => setModal('login')} close={() => setModal(null)} />}
      {modal === 'login' && <LoginModal nav={nav} toast={toast} switchTo={() => setModal('register')} close={() => setModal(null)} />}
      <Toasts items={items} />
    </div>
  );
}

function RegisterModal({ nav, toast, switchTo, close }) {
  const [teamName, setTeamName] = useState('');
  const [startupName, setStartupName] = useState('');
  const [password, setPassword] = useState('');
  const [category, setCategory] = useState('');
  const [tagline, setTagline] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (teamName.trim().length < 2) return setErr('Team name must be at least 2 characters.');
    if (startupName.trim().length < 2) return setErr('Startup name must be at least 2 characters.');
    if (!category) return setErr('Pick your industry sector.');
    if (password.length < 8) return setErr('Team password must be at least 8 characters.');
    setBusy(true);
    try {
      await api.registerTeam({ teamName: teamName.trim(), startupName: startupName.trim(), category, tagline: tagline.trim(), password });
      nav('/dashboard');
    } catch (ex) {
      setErr(ex.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Register your <em>squad</em>" onClose={close}>
      <form onSubmit={submit}>
        <div className="field"><label className="label" htmlFor="rg-team">Squad / Team Name <span className="req">*</span></label>
          <input id="rg-team" className="input" value={teamName} onChange={(e) => setTeamName(e.target.value)} maxLength={40} placeholder="e.g. The Pivoteers" /></div>
        <div className="field"><label className="label" htmlFor="rg-startup">Startup / Product Name <span className="req">*</span></label>
          <input id="rg-startup" className="input" value={startupName} onChange={(e) => setStartupName(e.target.value)} maxLength={50} placeholder="e.g. PayZap" /></div>
        <div className="field"><label className="label" htmlFor="rg-pass">Team Password <span className="req">*</span></label>
          <Password id="rg-pass" value={password} onChange={setPassword} placeholder="At least 8 characters" autoComplete="new-password" /></div>
        <div className="field"><label className="label" htmlFor="rg-cat">Industry Sector <span className="req">*</span></label>
          <select id="rg-cat" className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="" disabled>Choose your battleground…</option>
            <option value="FinTech">FinTech — Payments · Lending · InsurTech</option>
            <option value="HealthTech">HealthTech — MedTech · Wellness · BioTech</option>
            <option value="EdTech">EdTech — Learning · Upskilling</option>
            <option value="AgriTech">AgriTech — Farming · Supply Chain</option>
            <option value="CleanTech">CleanTech — Renewables · EVs</option>
            <option value="RetailTech">RetailTech — D2C · Logistics</option>
          </select></div>
        <div className="field"><label className="label" htmlFor="rg-tag">One-Line Killer Pitch (optional)</label>
          <input id="rg-tag" className="input" value={tagline} onChange={(e) => setTagline(e.target.value)} maxLength={80} placeholder="The OS for Indian healthcare payments" /></div>
        {err && <p className="form-error">{err}</p>}
        <button className="btn btn-primary btn-full" type="submit" disabled={busy}>
          {busy && <span className="spinner" />} Enter the Gauntlet
        </button>
        <p className="switch-line">Already registered? <button type="button" onClick={switchTo}>Log in here</button></p>
      </form>
    </Modal>
  );
}

function LoginModal({ nav, toast, switchTo, close }) {
  const [teamName, setTeamName] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (teamName.trim().length < 2) return setErr('Enter your squad / team name.');
    if (!password) return setErr('Enter your team password.');
    setBusy(true);
    try {
      await api.loginTeam({ teamName: teamName.trim(), password });
      nav('/dashboard');
    } catch (ex) {
      setErr(ex.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Squad <em>login</em>" onClose={close}>
      <form onSubmit={submit}>
        <div className="field"><label className="label" htmlFor="lg-team">Squad / Team Name <span className="req">*</span></label>
          <input id="lg-team" className="input" value={teamName} onChange={(e) => setTeamName(e.target.value)} maxLength={40} placeholder="e.g. The Pivoteers" autoComplete="username" /></div>
        <div className="field"><label className="label" htmlFor="lg-pass">Team Password <span className="req">*</span></label>
          <Password id="lg-pass" value={password} onChange={setPassword} placeholder="Your squad password" autoComplete="current-password" /></div>
        {err && <p className="form-error">{err}</p>}
        <button className="btn btn-primary btn-full" type="submit" disabled={busy}>
          {busy && <span className="spinner" />} Re-enter the Arena
        </button>
        <p className="switch-line">New squad? <button type="button" onClick={switchTo}>Register here</button></p>
      </form>
    </Modal>
  );
}

