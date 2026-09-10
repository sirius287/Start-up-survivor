/* API client + session helpers + formatters (talks to the existing Express API) */

async function request(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const err = new Error(body.error?.message || `Request failed (${res.status}).`);
    err.code = body.error?.code;
    err.status = res.status;
    throw err;
  }
  return body.data;
}

const CURRENT_KEY = 'ss_currentUser';

export function getCurrentUser() {
  try {
    return JSON.parse(sessionStorage.getItem(CURRENT_KEY));
  } catch {
    return null;
  }
}
export function setCurrentUser(user) {
  sessionStorage.setItem(CURRENT_KEY, JSON.stringify(user));
}
export function clearCurrentUser() {
  sessionStorage.removeItem(CURRENT_KEY);
}
export const teamIdOf = (user) => String(user?.teamId || user?.id || '');

function withTeam(user, team) {
  return { ...team, id: String(team.id), role: 'team' };
}

export const api = {
  registerTeam: async (details) => {
    const data = await request('/api/auth/team/register', { method: 'POST', body: JSON.stringify(details) });
    const user = withTeam(data, data.team);
    setCurrentUser(user);
    return user;
  },
  loginTeam: async ({ teamName, password }) => {
    const data = await request('/api/auth/team/login', { method: 'POST', body: JSON.stringify({ teamName, password }) });
    const user = withTeam(data, data.team);
    setCurrentUser(user);
    return user;
  },
  // Judges log in with a short code (no password) — as many judges as there
  // are JUDGE_<n>_CODE entries in the server env.
  loginJudgeCode: async (code) => {
    const user = await request('/api/auth/judge/login', { method: 'POST', body: JSON.stringify({ code }) });
    setCurrentUser(user);
    return user;
  },
  loginJudge: async (password) => {
    // NOTE: this "judge bunker" screen is actually the Game Master / admin
    // console (start/pause/shocks/reset) — real judges now log in with a
    // short code, not a password, via a separate (not-yet-built) judge
    // panel. Wired to /api/auth/admin/login as an interim bridge so this
    // existing control room keeps working under the new admin/judge role
    // split. See PLAN.md §2 / REDESIGN.md §C.3.
    const user = await request('/api/auth/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
    setCurrentUser(user);
    return user;
  },
  logout: async () => {
    await request('/api/auth/logout', { method: 'POST' }).catch(() => {});
    clearCurrentUser();
  },
  me: () => request('/api/auth/me'),
  gameState: () => request('/api/game/state'),
  leaderboard: () => request('/api/leaderboard'),
  catalog: () => request('/api/shocks'),
  // Two-step: submit a request (strategy + cited doc), then — once a judge
  // approves it — deploy. `deploy` takes no body; the approved request IS
  // the payload, so a team can never deploy numbers nobody approved.
  submitRequest: (teamId, payload) =>
    request(`/api/teams/${teamId}/strategy`, { method: 'POST', body: JSON.stringify(payload) }),
  myRequest: (teamId) => request(`/api/teams/${teamId}/request`),
  deploy: (teamId) => request(`/api/teams/${teamId}/deploy`, { method: 'POST' }),
  // Documents & links (deck, idea brief, GTM, financial model, etc.)
  docTypes: () => request('/api/docs/types'),
  myDocs: () => request('/api/docs/mine'),
  submitDoc: (teamId, docType, docUrl) =>
    request(`/api/teams/${teamId}/docs/${docType}`, { method: 'POST', body: JSON.stringify({ docUrl }) }),
  teamStats: (teamId) => request(`/api/teams/${teamId}/stats`),
  deployments: (teamId, limit = 50) =>
    request(`/api/deployments?limit=${limit}${teamId ? `&teamId=${teamId}` : ''}`),
  // judge
  gameAction: (action) => request(`/api/game/${action}`, { method: 'POST' }),
  resetGame: () => request('/api/game/reset', { method: 'POST' }),
  deployShock: (shockId, targetTeamId) =>
    request('/api/shocks/deploy', { method: 'POST', body: JSON.stringify({ shockId, targetTeamId }) }),
  customShock: (payload) => request('/api/shocks/custom', { method: 'POST', body: JSON.stringify(payload) }),
  resolveShock: (instanceId) => request(`/api/shocks/${instanceId}`, { method: 'DELETE' }),
  qualityAttributes: () => request('/api/quality/attributes'),
  allQuality: () => request('/api/quality'),
  scoreQuality: (teamId, scores) =>
    request(`/api/quality/${teamId}`, { method: 'POST', body: JSON.stringify({ scores }) }),
  // staff: doc review queue
  docQueue: () => request('/api/docs/queue'),
  addDocComment: (id, payload) =>
    request(`/api/docs/${id}/comments`, { method: 'POST', body: JSON.stringify(payload) }),
  claimDoc: (id) => request(`/api/docs/${id}/claim`, { method: 'POST' }),
  decideDoc: (id, decision, reason, opts = {}) =>
    request(`/api/docs/${id}/decide`, { method: 'POST', body: JSON.stringify({ decision, reason, ...opts }) }),
  powers: () => request('/api/powers'),
  grantPower: () => request('/api/events/power', { method: 'POST' }),
  fireGlobalEvent: (shockId) => request('/api/events/global', { method: 'POST', body: JSON.stringify({ shockId }) }),
  clearShock: (instanceId) => request(`/api/shocks/${instanceId}`, { method: 'DELETE' }),
  eventLog: ({ kind, teamId, limit = 200 } = {}) => {
    const q = new URLSearchParams({ limit: String(limit) });
    if (kind) q.set('kind', kind);
    if (teamId) q.set('teamId', teamId);
    return request(`/api/event-log?${q}`);
  },
  results: () => request('/api/results'),
  setResultWeights: (market, docs) => request('/api/results/weights', { method: 'POST', body: JSON.stringify({ market, docs }) }),
  freezeResults: () => request('/api/results/freeze', { method: 'POST' }),
  halftimeCutPreview: () => request('/api/game/halftime-cut/preview'),
  // admin: engine + schedule
  runTick: () => request('/api/engine/tick', { method: 'POST' }),
  advanceRound: () => request('/api/game/round/advance', { method: 'POST' }),
  extendDeadline: (minutes) => request('/api/game/extend', { method: 'POST', body: JSON.stringify({ minutes }) }),
  fireHalftimeShock: (shockId) =>
    request('/api/game/halftime-shock', { method: 'POST', body: JSON.stringify({ shockId }) }),
};

export const CATEGORIES = ['FinTech', 'HealthTech', 'EdTech', 'AgriTech', 'CleanTech', 'RetailTech'];
export const SEGMENTS = ['mass', 'premium', 'niche'];
export const SEGMENT_INFO = {
  mass: { label: 'Mass Market', hint: 'Maximum lead volume. Average conversion. Best during viral/boom shocks.' },
  premium: { label: 'Premium', hint: 'Smaller pool but 40% better conversion. Great for crisis resilience.' },
  niche: { label: 'Niche', hint: 'Ultra-targeted. 80% better CVR. Low volume but extremely high signal quality.' },
};
/* Human labels for submission states, so the team panel never shows a
   bare enum. */
export const DOC_STATUS = {
  submitted:     { label: 'Awaiting review', tone: 'amber' },
  under_review:  { label: 'Judge reviewing', tone: 'amber' },
  approved:      { label: 'Approved',        tone: 'green' },
  rejected:      { label: 'Rejected',        tone: 'red'   },
  carried_over:  { label: 'Not reviewed in time — carried over', tone: 'amber' },
  auto_approved: { label: 'Auto-approved at deadline', tone: 'green' },
};

/** mm:ss countdown against a server-provided deadline. */
export function countdown(deadlineMs, nowMs = Date.now()) {
  const left = Math.max(0, (deadlineMs || 0) - nowMs);
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  return { expired: left <= 0, ms: left, text: `${m}:${String(s).padStart(2, '0')}` };
}

export const fmt = {
  currency(n, compact = false) {
    n = Number(n) || 0;
    if (compact && Math.abs(n) >= 1000000) return '₹' + (n / 1000000).toFixed(2) + 'M';
    if (compact && Math.abs(n) >= 1000) return '₹' + (n / 1000).toFixed(1) + 'K';
    return '₹' + Math.max(0, n).toLocaleString('en-IN');
  },
  percent: (n) => `${Number(n || 0).toFixed(1)}%`,
  units: (n) => Math.max(0, Math.floor(Number(n) || 0)).toLocaleString(),
  delta(n) {
    n = Number(n) || 0;
    return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
  },
  time(ms) {
    return new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  },
};

export function shockTimeLeft(shock) {
  const ms = Number(shock.expiresAt) - Date.now();
  if (ms <= 0) return 'Expired';
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

export const PHASE_LABEL = { lobby: 'Waiting to Start', active: 'LIVE', paused: 'Paused', ended: 'Game Over' };
