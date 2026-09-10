/* ============================================================
   STARTUP SURVIVOR — Shared State, Auth & Event Bus
   ============================================================ */

const SS = {
  POLL_INTERVAL: 1500,  // ms between state sync polls
  _state: null,
  _defaultState() { return { teams: [], marketState: {}, activeShocks: [], shockHistory: [], gamePhase: 'lobby', gameStartTime: null, gameTick: 0, leaderboard: [], lastUpdate: 0 }; },
  load() { return this._state || this._defaultState(); },
  async refresh() { const response = await this.request('/api/game/state'); this._state = response; return response; },
  async request(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) throw new Error(body.error?.message || 'Request failed.');
    return body.data;
  },

  /* ── Auth ── */
  CURRENT_KEY: 'ss_currentUser',

  getCurrentUser() {
    try { return JSON.parse(sessionStorage.getItem(this.CURRENT_KEY)); }
    catch { return null; }
  },

  setCurrentUser(user) {
    sessionStorage.setItem(this.CURRENT_KEY, JSON.stringify(user));
  },

  clearCurrentUser() {
    sessionStorage.removeItem(this.CURRENT_KEY);
  },

  async loginTeam(details) {
    const data = await this.request('/api/auth/team/register', { method: 'POST', body: JSON.stringify(details) });
    const user = { ...data.team, id: String(data.teamId), role: 'team' };
    this.setCurrentUser(user);
    return user;
  },

  async loginJudge(password) {
    const user = await this.request('/api/auth/judge/login', { method: 'POST', body: JSON.stringify({ password }) });
    this.setCurrentUser(user);
    return user;
  },

  /* ── Reset ── */
  async logout() {
    await this.request('/api/auth/logout', { method: 'POST' }).catch(() => {});
    this.clearCurrentUser();
    this._state = null;
  },
};

/* ── Toast System ── */
const Toast = {
  _container: null,

  init() {
    if (!document.getElementById('toast-container')) {
      const c = document.createElement('div');
      c.id = 'toast-container';
      document.body.appendChild(c);
    }
    this._container = document.getElementById('toast-container');
  },

  show(type, title, msg, duration = 4000) {
    if (!this._container) this.init();

    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️', shock: '⚡' };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `
      <div class="toast-icon">${icons[type] || 'ℹ️'}</div>
      <div class="toast-body">
        <div class="toast-title">${title}</div>
        ${msg ? `<div class="toast-msg">${msg}</div>` : ''}
      </div>
    `;
    this._container.appendChild(el);

    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 300);
    }, duration);
  },

  success(title, msg) { this.show('success', title, msg); },
  error(title, msg)   { this.show('error',   title, msg, 5000); },
  warning(title, msg) { this.show('warning', title, msg); },
  info(title, msg)    { this.show('info',    title, msg); },
  shock(title, msg)   { this.show('shock',   title, msg, 6000); },
};

/* ── Format Helpers ── */
const Fmt = {
  currency(n, compact = false) {
    if (compact && Math.abs(n) >= 1000000) return '₹' + (n/1000000).toFixed(2) + 'M';
    if (compact && Math.abs(n) >= 1000)    return '₹' + (n/1000).toFixed(1) + 'K';
    return '₹' + Math.max(0, n).toLocaleString('en-IN');
  },
  percent(n) { return n.toFixed(1) + '%'; },
  units(n)   { return Math.max(0, Math.floor(n)).toLocaleString(); },
  delta(n)   {
    const sign = n >= 0 ? '+' : '';
    return `${sign}${n.toFixed(1)}%`;
  },
};

/* ── State Poller (cross-tab sync) ── */
const Poller = {
  _lastUpdate: 0,
  _interval: null,
  _callbacks: [],

  start(cb, interval = SS.POLL_INTERVAL) {
    if (cb) this._callbacks.push(cb);
    if (this._interval) return;
    const poll = async () => {
      try { const state = await SS.refresh(); this._lastUpdate = state.lastUpdate; this._callbacks.forEach(fn => fn(state)); }
      catch (error) { if (error.message.includes('session')) { SS.clearCurrentUser(); window.location.href = 'index.html'; } }
    };
    poll();
    this._interval = setInterval(poll, interval);
  },

  stop() {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
  },

  on(cb) { this._callbacks.push(cb); },
};

/* ── Guard: redirect if not authenticated ── */
function requireAuth(expectedRole) {
  const user = SS.getCurrentUser();
  if (!user) {
    window.location.href = 'index.html';
    return null;
  }
  if (expectedRole && user.role !== expectedRole) {
    window.location.href = 'index.html';
    return null;
  }
  return user;
}

/* ── Number animation helper ── */
function animateNumber(el, from, to, duration = 600, formatter = (n) => n) {
  if (!el) return;
  const start = performance.now();
  const update = (now) => {
    const t = Math.min((now - start) / duration, 1);
    const eased = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
    el.textContent = formatter(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(update);
  };
  requestAnimationFrame(update);
}

/* ── Init toast on load ── */
document.addEventListener('DOMContentLoaded', () => Toast.init());
