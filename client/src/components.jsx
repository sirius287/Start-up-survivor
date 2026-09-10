import { useState } from 'react';
import { fmt, shockTimeLeft } from './api.js';

export function Modal({ title, onClose, children, wide }) {
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" style={wide ? { maxWidth: 640 } : undefined}>
        <div className="modal-h">
          <h2 dangerouslySetInnerHTML={{ __html: title }} />
          <button className="x-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Toasts({ items }) {
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind} ${t.bye ? 'bye' : ''}`}>
          <div>
            <strong>{t.title}</strong>
            {t.msg && <span>{t.msg}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Password({ id, value, onChange, placeholder, autoComplete, minLength }) {
  const [show, setShow] = useState(false);
  return (
    <div className="pw-wrap">
      <input
        className="input" id={id} type={show ? 'text' : 'password'}
        value={value} onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder} autoComplete={autoComplete} minLength={minLength}
      />
      <button type="button" className="pw-eye" onClick={() => setShow((s) => !s)} aria-label="Toggle visibility">
        {show ? '🙈' : '👁'}
      </button>
    </div>
  );
}

export function Metric({ label, value, delta, color }) {
  return (
    <div className="metric">
      <div className="k">{label}</div>
      <div className="v" style={color ? { color } : undefined}>{value}</div>
      {delta !== undefined && delta !== null && (
        <div className={`d ${delta >= 0 ? 'up' : 'down'}`}>{delta >= 0 ? '▲' : '▼'} {fmt.delta(delta)}</div>
      )}
    </div>
  );
}

export function ShockCard({ shock, category }) {
  const e = { ...shock.effect };
  if (shock.id === 'pandemic_surge') e.demand = category === 'HealthTech' ? 100 : -30;
  if (shock.id === 'green_mandate') e.demand = category === 'CleanTech' ? 40 : -10;
  const fx = [
    e.demand ? ['Demand', e.demand, e.demand > 0 ? 'var(--green)' : 'var(--red)'] : null,
    e.budget ? ['Budget', e.budget, e.budget > 0 ? 'var(--green)' : 'var(--red)'] : null,
    e.conversion ? ['Conversion', e.conversion, e.conversion > 0 ? 'var(--green)' : 'var(--red)'] : null,
  ].filter(Boolean);
  return (
    <div className={`shock ${shock.category}`}>
      <div className="shock-top">
        <span className="em">{shock.emoji}</span>
        <div>
          <div className="tt">{shock.name}</div>
          <div className="ds">{shock.description}</div>
        </div>
        <div className="rt">
          <span className="badge badge-amber">{shock.severity}</span>
          <span className="mono" style={{ fontSize: 12, color: 'var(--gold)' }}>⏱ {shockTimeLeft(shock)}</span>
        </div>
      </div>
      {fx.length > 0 && (
        <div className="shock-fx">
          {fx.map(([label, v, color]) => (
            <span key={label} className="pill" style={{ color, borderColor: `${color}55` }}>
              {label} {v > 0 ? '+' : ''}{v}%
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function TopBar({ children }) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <span className="brand">🔥 Startup <em>Survivor</em></span>
        <span className="spacer" />
        {children}
      </div>
    </header>
  );
}
