/* ============================================================
   STARTUP SURVIVOR — Product Quality Scoring (judge-rated)
   Judges rate each team's product 1-10 across weighted
   attributes. The weighted composite feeds the market model
   as a bounded demand/conversion multiplier.
   ============================================================ */

const QUALITY_ATTRIBUTES = [
  { id: 'innovation',    label: 'Innovation',         description: 'How novel and differentiated is the product?',      weight: 0.25 },
  { id: 'usability',     label: 'Usability & Craft',  description: 'How polished and usable is the experience?',        weight: 0.20 },
  { id: 'market_fit',    label: 'Market Fit',         description: 'Does it solve a real, sizable customer need?',     weight: 0.25 },
  { id: 'execution',     label: 'Execution',          description: 'Quality of delivery, BMC depth, crisis response.', weight: 0.15 },
  { id: 'storytelling',  label: 'Pitch & Story',      description: 'How compelling is the team\u2019s narrative?',               weight: 0.15 },
];

const QUALITY_MIN = 1;
const QUALITY_MAX = 10;
// Composite at/below NEUTRAL neither helps nor hurts; 10/10 gives the full bonus.
const QUALITY_NEUTRAL = 5.5;
// Max demand swing at the extremes: Q=10 -> +25% demand, Q=1 -> -25% demand.
const QUALITY_WEIGHT = 0.25;

function clampScore(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(QUALITY_MAX, Math.max(QUALITY_MIN, n));
}

/* Weighted composite (1-10) across the attributes present in `scores`.
   Missing attributes are excluded and remaining weights renormalised,
   so a partially-scored team is never penalised for unscored attributes.
   Returns null when nothing has been scored yet. */
function compositeQuality(scores) {
  if (!scores || typeof scores !== 'object') return null;
  let total = 0, weight = 0;
  for (const attr of QUALITY_ATTRIBUTES) {
    const s = clampScore(scores[attr.id]);
    if (s === null) continue;
    total += s * attr.weight;
    weight += attr.weight;
  }
  if (weight <= 0) return null;
  return Number((total / weight).toFixed(2));
}

/* Bounded demand multiplier for a composite quality q (1-10).
   null/undefined (not yet rated) -> 1, i.e. the model behaves exactly
   as before until a judge scores the team. */
function qualityMultiplier(quality) {
  const q = clampScore(quality);
  if (q === null) return 1;
  return 1 + ((q - QUALITY_NEUTRAL) / (QUALITY_MAX - QUALITY_NEUTRAL)) * QUALITY_WEIGHT;
}

module.exports = { QUALITY_ATTRIBUTES, QUALITY_MIN, QUALITY_MAX, QUALITY_NEUTRAL, QUALITY_WEIGHT, compositeQuality, qualityMultiplier };
