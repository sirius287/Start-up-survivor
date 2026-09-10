/* ============================================================
   STARTUP SURVIVOR — Shared Product Quality helpers (frontend)
   Mirrors server/services/quality.js for previews + display.
   The server is authoritative: weights/validation live there.
   ============================================================ */

const Quality = {

  NEUTRAL: 5.5,
  WEIGHT: 0.25,

  /* Fallback attributes if the snapshot hasn't loaded yet.
     Live values always come from state.qualityAttributes. */
  FALLBACK_ATTRS: [
    { id: 'innovation',   label: 'Innovation',        description: 'How novel and differentiated is the product?',       weight: 0.25 },
    { id: 'usability',    label: 'Usability & Craft', description: 'How polished and usable is the experience?',         weight: 0.20 },
    { id: 'market_fit',   label: 'Market Fit',        description: 'Does it solve a real, sizable customer need?',      weight: 0.25 },
    { id: 'execution',    label: 'Execution',         description: 'Quality of delivery, BMC depth, crisis response.',  weight: 0.15 },
    { id: 'storytelling', label: 'Pitch & Story',     description: 'How compelling is the team\u2019s narrative?',                weight: 0.15 },
  ],

  /* Weighted composite (1-10) of a { attrId: score } map, or null. */
  composite(scores, attrs) {
    const list = attrs && attrs.length ? attrs : this.FALLBACK_ATTRS;
    let total = 0, weight = 0;
    for (const attr of list) {
      const raw = scores ? scores[attr.id] : undefined;
      if (raw === null || raw === undefined || raw === '') continue;
      const s = Number(raw);
      if (!Number.isFinite(s)) continue;
      total += Math.min(10, Math.max(1, s)) * attr.weight;
      weight += attr.weight;
    }
    return weight > 0 ? Number((total / weight).toFixed(1)) : null;
  },

  /* Demand multiplier the composite produces in the market model. */
  multiplier(composite) {
    if (composite === null || composite === undefined || !Number.isFinite(Number(composite))) return 1;
    const q = Math.min(10, Math.max(1, Number(composite)));
    return 1 + ((q - this.NEUTRAL) / (10 - this.NEUTRAL)) * this.WEIGHT;
  },

  format(composite) {
    return composite === null || composite === undefined ? '—' : `★ ${Number(composite).toFixed(1)}`;
  },

  color(composite) {
    if (composite === null || composite === undefined) return 'var(--text-muted)';
    if (composite >= 8)  return 'var(--green)';
    if (composite >= 6)  return 'var(--amber)';
    if (composite >= 4)  return 'var(--cyan)';
    return 'var(--red)';
  },
};
