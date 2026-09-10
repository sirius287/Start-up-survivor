/* ============================================================
   STARTUP SURVIVOR — Shared State, Auth & Event Bus
   ============================================================ */

const SS = {
  STORE_KEY: 'startupSurvivor_v2',
  JUDGE_PASSWORD: 'gauntlet2026',
  POLL_INTERVAL: 1500,  // ms between state sync polls

  /* ── Initial State ── */
  defaultState() {
    return {
      teams: [],
      marketState: {},       // keyed by teamId
      activeShocks: [],      // global shocks active right now
      shockHistory: [],
      gamePhase: 'lobby',    // lobby | active | paused | ended
      gameStartTime: null,
      gameTick: 0,
      leaderboard: [],
      lastUpdate: Date.now(),
    };
  },

  /* ── Storage Helpers ── */
  load() {
    try {
      const raw = localStorage.getItem(this.STORE_KEY);
      if (!raw) return this.defaultState();
      return { ...this.defaultState(), ...JSON.parse(raw) };
    } catch (e) {
      return this.defaultState();
    }
  },

  save(state) {
    state.lastUpdate = Date.now();
    localStorage.setItem(this.STORE_KEY, JSON.stringify(state));
  },

  get() { return this.load(); },

  patch(updater) {
    const state = this.load();
    updater(state);
    this.save(state);
    return state;
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

  loginTeam({ teamName, startupName, category, tagline }) {
    const state = this.load();
    const teamId = 'team_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

    const team = {
      id: teamId,
      teamName,
      startupName,
      category,
      tagline,
      joinedAt: Date.now(),
      isActive: true,
    };

    // Check if team name already exists, reassign
    const existing = state.teams.find(t => t.teamName.toLowerCase() === teamName.toLowerCase());
    if (existing) {
      // Re-login existing team
      this.setCurrentUser({ ...existing, role: 'team' });
      return existing;
    }

    state.teams.push(team);

    // Init market state for this team
    state.marketState[teamId] = Market.initTeamState(category);

    this.save(state);
    this.setCurrentUser({ ...team, role: 'team' });
    return team;
  },

  loginJudge(password) {
    if (password !== this.JUDGE_PASSWORD) return false;
    this.setCurrentUser({ role: 'judge', name: 'Game Master' });
    return true;
  },

  /* ── Reset ── */
  resetAll() {
    localStorage.removeItem(this.STORE_KEY);
    sessionStorage.removeItem(this.CURRENT_KEY);
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
    this._interval = setInterval(() => {
      const state = SS.load();
      if (state.lastUpdate !== this._lastUpdate) {
        this._lastUpdate = state.lastUpdate;
        this._callbacks.forEach(fn => fn(state));
      }
    }, interval);
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
