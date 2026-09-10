/* ============================================================
   STARTUP SURVIVOR — Shock Catalog & Application Logic
   ============================================================ */

const Shocks = {

  /* ── Pre-built Shock Catalog ── */
  CATALOG: [
    {
      id: 'tech_boom',
      name: 'Tech Boom',
      emoji: '🚀',
      description: 'A wave of tech adoption sweeps the market. Digital solutions are in high demand as enterprises scramble to digitize.',
      category: 'opportunity',
      severity: 'high',
      effect: { demand: 50, budget: 0, conversion: 10 },
      duration: 3,
    },
    {
      id: 'recession',
      name: 'Recession',
      emoji: '📉',
      description: 'Economic downturn hits hard. Consumer spending drops, budgets get slashed, and every rupee is scrutinized.',
      category: 'threat',
      severity: 'critical',
      effect: { demand: -20, budget: -30, conversion: -8 },
      duration: 4,
    },
    {
      id: 'data_scandal',
      name: 'Data Privacy Scandal',
      emoji: '🔓',
      description: 'A major data breach rocks the industry. Customer trust collapses overnight and regulators close in.',
      category: 'threat',
      severity: 'high',
      effect: { demand: -40, budget: -10, conversion: -15 },
      duration: 3,
    },
    {
      id: 'competitor_entry',
      name: 'Competitor Entry',
      emoji: '⚔️',
      description: 'A well-funded rival enters your space. Market share dilutes and customer acquisition becomes a costly battle.',
      category: 'threat',
      severity: 'medium',
      effect: { demand: -20, budget: 0, conversion: -12 },
      duration: 2,
    },
    {
      id: 'viral_trend',
      name: 'Viral Trend',
      emoji: '🔥',
      description: 'Your category explodes on social media. Organic traffic surges and you\'re riding a perfect wave of attention.',
      category: 'opportunity',
      severity: 'high',
      effect: { demand: 80, budget: 0, conversion: 20 },
      duration: 2,
    },
    {
      id: 'supply_chain',
      name: 'Supply Chain Crisis',
      emoji: '🚢',
      description: 'Global logistics collapse. Delivery delays, cost overruns, and unhappy customers test your resilience.',
      category: 'threat',
      severity: 'high',
      effect: { demand: -25, budget: -20, conversion: -5 },
      duration: 3,
    },
    {
      id: 'regulatory_crackdown',
      name: 'Regulatory Crackdown',
      emoji: '⚖️',
      description: 'New regulations mandate compliance changes immediately. Legal costs spike and product launches are delayed.',
      category: 'threat',
      severity: 'high',
      effect: { demand: -15, budget: -25, conversion: -3 },
      duration: 4,
    },
    {
      id: 'investor_frenzy',
      name: 'Investor Frenzy',
      emoji: '💰',
      description: 'VCs are flush with cash and your sector is hot. Valuations soar and every startup gets a budget injection.',
      category: 'opportunity',
      severity: 'medium',
      effect: { demand: 30, budget: 20, conversion: 5 },
      duration: 2,
    },
    {
      id: 'market_crash',
      name: 'Market Crash',
      emoji: '💥',
      description: 'Black swan event. Markets implode, budgets are cut to zero, and only the most agile teams will survive.',
      category: 'threat',
      severity: 'critical',
      effect: { demand: -60, budget: -40, conversion: -20 },
      duration: 5,
    },
    {
      id: 'talent_exodus',
      name: 'Talent Exodus',
      emoji: '🚪',
      description: 'Key talent is being poached by giants offering massive packages. Productivity drops and morale tanks.',
      category: 'threat',
      severity: 'medium',
      effect: { demand: -10, budget: -15, conversion: -6 },
      duration: 3,
    },
    {
      id: 'pandemic_surge',
      name: 'Pandemic Surge',
      emoji: '🦠',
      description: 'A health crisis reshapes priorities. HealthTech rockets; others face demand collapse as behavior shifts.',
      category: 'wildcard',
      severity: 'critical',
      effect: { demand: -30, budget: 0, conversion: -10 },  // overridden per category in market.js
      duration: 4,
    },
    {
      id: 'green_mandate',
      name: 'Green Mandate',
      emoji: '🌱',
      description: 'Government mandates ESG compliance. CleanTech soars; polluting industries face heavy penalties.',
      category: 'wildcard',
      severity: 'medium',
      effect: { demand: -10, budget: -10, conversion: 0 },  // overridden per category
      duration: 3,
    },
  ],

  /* ── Apply a shock globally ── */
  deployShock(shockId, targetTeamId = null) {
    return this.CATALOG.find(s => s.id === shockId) || null;
  },

  /* ── Deploy a custom shock ── */
  deployCustomShock({ name, description, demandDelta, budgetDelta, conversionDelta, durationMins, targetTeamId }) {
    return SS.request('/api/shocks/custom', { method: 'POST', body: JSON.stringify({ name, description, demandDelta, budgetDelta, conversionDelta, durationMins, targetTeamId }) });
  },

  /* ── Expire old shocks ── */
  pruneExpired() {
    return Promise.resolve();
  },

  /* ── Get shocks relevant to a specific team ── */
  getForTeam(teamId, activeShocks) {
    return activeShocks.filter(s => !s.targetTeamId || s.targetTeamId === teamId);
  },

  /* ── Severity color ── */
  severityColor(severity) {
    return { low: '#00ff88', medium: '#ffaa00', high: '#ff6b35', critical: '#ff4444' }[severity] || '#ffffff';
  },

  /* ── Category color ── */
  categoryColor(cat) {
    return { opportunity: '#00ff88', threat: '#ff4444', wildcard: '#7c3aed', custom: '#00f5ff' }[cat] || '#ffffff';
  },

  /* ── Remaining time label ── */
  timeLeft(shock) {
    const ms = shock.expiresAt - Date.now();
    if (ms <= 0) return 'Expired';
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  },
};
