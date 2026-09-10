/* API client + session helpers + formatters (talks to the existing Express API) */

async function request(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new Error(body.error?.message || `Request failed (${res.status}).`);
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
  loginJudge: async (password) => {
    const user = await request('/api/auth/judge/login', { method: 'POST', body: JSON.stringify({ password }) });
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
  deploy: (teamId, strategy) =>
    request(`/api/teams/${teamId}/deploy`, { method: 'POST', body: JSON.stringify(strategy) }),
  saveBmc: (teamId, field, value) =>
    request(`/api/teams/${teamId}/bmc`, { method: 'PATCH', body: JSON.stringify({ field, value }) }),
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
};

export const CATEGORIES = ['FinTech', 'HealthTech', 'EdTech', 'AgriTech', 'CleanTech', 'RetailTech'];
export const SEGMENTS = ['mass', 'premium', 'niche'];
export const SEGMENT_INFO = {
  mass: { label: 'Mass Market', hint: 'Maximum lead volume. Average conversion. Best during viral/boom shocks.' },
  premium: { label: 'Premium', hint: 'Smaller pool but 40% better conversion. Great for crisis resilience.' },
  niche: { label: 'Niche', hint: 'Ultra-targeted. 80% better CVR. Low volume but extremely high signal quality.' },
};
export const BMC_FIELDS = [
  ['keyPartners', 'Key Partners'],
  ['keyActivities', 'Key Activities'],
  ['keyResources', 'Key Resources'],
  ['valueProposition', 'Value Proposition'],
  ['customerRelationships', 'Customer Relationships'],
  ['channels', 'Channels'],
  ['customerSegments', 'Customer Segments'],
  ['costStructure', 'Cost Structure'],
  ['revenueStreams', 'Revenue Streams'],
];

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
