/* ============================================================
   STARTUP SURVIVOR — market engine v2 (SPEC.md Part 1-2)

   Replaces the old formula, which had a dominant strategy at
   every lever (max price, max marketing, always "mass") because
   revenue was monotone in every input. This version gives every
   lever an interior optimum that a shock can shift, which is what
   makes the pivot round mean anything.

   Two passes per tick, across ALL active teams on a track:
     1. attractivenessFor(...)   - one team's pull on the shared pool
     2. allocateSharedPool(...)  - splits the track's pool by share
     3. applyTick(...)           - one team's full tick given its share
   ============================================================ */

const { rngNoise } = require('./rng');
const { qualityMultiplier } = require('./quality');

/* ---- tunable constants (all in one place, on purpose) ---- */
const SEGMENTS = {
  // [elasticity, conversionMultiplier] — elasticity > 1 means revenue
  // FALLS past some price (SPEC.md §2.1), unlike the old 0.6 exponent.
  mass:    { elasticity: 1.8, conversionMultiplier: 1.0 },
  premium: { elasticity: 1.15, conversionMultiplier: 1.4 },
  niche:   { elasticity: 0.85, conversionMultiplier: 1.8 },
};
const AWARENESS_DECAY = 0.75;       // §2.2 — awareness is a decaying stock
const AWARENESS_MAX = 3.0;          // saturating ceiling on the Hill response
const AWARENESS_HALF = 10000;       // marketing spend that buys half of AWARENESS_MAX
const AWARENESS_FLOOR = 0.15;       // organic/word-of-mouth reach at $0 marketing —
                                     // without this, zero spend gives EXACTLY zero
                                     // attractiveness (sqrt(0)=0), which is a hard
                                     // wall, not a disadvantage: a team that skips
                                     // marketing one tick would get 0% of the shared
                                     // pool regardless of price. A small organic floor
                                     // keeps marketing a real lever, not a gate.
const BASE_CHURN = 0.18;            // §2.5 — per-tick churn before quality/shocks
const QUALITY_CHURN_WEIGHT = 0.5;   // quality can cut churn by up to 50%
const DEBT_INTEREST = 0.08;         // §2.8 — compounds against negative cash
const INSOLVENCY_DEBT_MULTIPLE = 2; // debt > 2x starting budget => insolvent
const INSOLVENCY_ATTRACTIVENESS_PENALTY = 0.4;
const REPUTATION_SCAR_DECAY = 0.15; // per tick, once solvent again
const FIXED_BURN_RATIO = 0.05;      // of starting budget, per tick
const POOL_UNITS_PER_TEAM = 220;    // §2.6 — shared pool scales with field size
// How much judge-rated documents move the market. docScore is 0..1 (points
// awarded / points available so far). 1.0 => +30% pull, 0.0 => −30%, an
// unrated team sits neutral at 1.0x. This is the mechanism by which "the
// idea and the pricing get graded, and the market acts accordingly".
const DOC_SCORE_WEIGHT = 0.30;
const DEMAND_MULTIPLIER_BOUNDS = [0.2, 3.0]; // §2.10 — bounded combined shock stacking

function clamp(value, lo, hi) { return Math.max(lo, Math.min(hi, value)); }

/** Combine every active shock's effect on one channel into one bounded
 *  multiplier. `shocks[i].trackMultipliers` (an object like
 *  { HealthTech: 1.8, default: 1.0 }) scales that shock's effect for this
 *  team's track — replaces the old hardcoded id-string if-chain. */
function combinedMultiplier(shocks, channel, trackId) {
  let m = 1;
  for (const s of shocks) {
    const base = Number(s[channel] || 0) / 100;
    const trackScale = s.trackMultipliers
      ? Number(s.trackMultipliers[trackId] ?? s.trackMultipliers.default ?? 1)
      : 1;
    m *= 1 + base * trackScale;
  }
  return clamp(m, DEMAND_MULTIPLIER_BOUNDS[0], DEMAND_MULTIPLIER_BOUNDS[1]);
}

/** One team's pull on the shared pool this tick — awareness, price
 *  elasticity, and quality, each shock-adjusted. Pure function; does not
 *  mutate state. Returns { attractiveness, awareness, elasticity, conversion }. */
function docMultiplier(docScore) {
  if (docScore === null || docScore === undefined) return 1; // nothing rated yet
  const s = Math.max(0, Math.min(1, Number(docScore)));
  return 1 + (s - 0.5) * 2 * DOC_SCORE_WEIGHT;
}

function attractivenessFor(state, track, strategy, shocks, quality, docScore = null) {
  const seg = SEGMENTS[strategy.targetSegment] || SEGMENTS.mass;
  const priorAwareness = Number(state.awareness || 0);
  const spend = Math.max(0, Number(strategy.marketingSpend || 0));
  const awareness = priorAwareness * AWARENESS_DECAY + AWARENESS_MAX * (spend / (spend + AWARENESS_HALF));

  const demandMult = combinedMultiplier(shocks, 'demand', track.id);
  const conversionMult = combinedMultiplier(shocks, 'conversion', track.id);

  const q = qualityMultiplier(quality); // 1 when unrated, bounded otherwise
  const priceRatio = Math.pow(Number(track.base_price) / Math.max(1, Number(strategy.productPrice)), seg.elasticity);

  const reputationPenalty = 1 - clamp(Number(state.reputation_scar || 0), 0, INSOLVENCY_ATTRACTIVENESS_PENALTY);
  const insolvencyPenalty = state.is_insolvent ? (1 - INSOLVENCY_ATTRACTIVENESS_PENALTY) : 1;

  const docMult = docMultiplier(docScore);
  const attractiveness = Math.max(0.0001,
    Math.sqrt(Math.max(AWARENESS_FLOOR, awareness)) * priceRatio * Math.pow(q, 0.3) * demandMult * docMult * reputationPenalty * insolvencyPenalty
  );
  const conversion = clamp(
    (Number(track.base_conversion) * seg.conversionMultiplier) * conversionMult * (1 + (q - 1) * 0.5),
    0.1, 60
  );
  return { attractiveness, awareness, conversion };
}

/** Splits a track's shared pool across every active team on that track,
 *  proportional to attractiveness (SPEC.md §2.6). `entries` is
 *  [{ teamId, attractiveness }]. Returns a Map(teamId -> share 0..1). */
function allocateSharedPool(entries) {
  const total = entries.reduce((sum, e) => sum + e.attractiveness, 0) || 1;
  const shares = new Map();
  for (const e of entries) shares.set(e.teamId, e.attractiveness / total);
  return shares;
}

/**
 * One team's full tick, given its already-computed share of the track pool.
 * `gameId`/`teamId`/`tick` seed the deterministic noise (SPEC.md §2.8).
 */
function applyTick({ state, track, strategy, shocks, quality, share, teamsOnTrack, gameId, teamId, tick, docScore = null }) {
  const { attractiveness, awareness, conversion } = attractivenessFor(state, track, strategy, shocks, quality, docScore);
  const budgetMult = combinedMultiplier(shocks, 'budget', track.id);

  const poolSize = POOL_UNITS_PER_TEAM * Math.max(1, teamsOnTrack);
  const noise = 1 + rngNoise(gameId, teamId, tick, 0.05); // ±5%, seeded & reproducible
  const potentialUnits = poolSize * share * (conversion / 100) * noise;

  const capacity = Number(state.capacity || 500);
  const servedUnits = Math.min(potentialUnits, capacity);
  const overflow = Math.max(0, potentialUnits - capacity); // lost demand -> churn/reputation, not revenue

  // Retention: active customers compound tick over tick (SPEC.md §2.5).
  const q = qualityMultiplier(quality);
  const churnShockMult = combinedMultiplier(shocks, 'churn', track.id); // opt-in channel, default neutral
  const baseChurn = clamp(BASE_CHURN * (1 - QUALITY_CHURN_WEIGHT * (q - 1) / 0.25) * churnShockMult, 0.02, 0.9);
  const priorActive = Number(state.active_customers || 0);
  const activeCustomers = priorActive * (1 - baseChurn) + servedUnits;
  const unitsSold = Math.max(0, Math.round(Math.min(activeCustomers, capacity + servedUnits)));

  const revenue = unitsSold * Number(strategy.productPrice);
  const cogs = unitsSold * Number(strategy.productPrice) * Number(track.cogs_ratio || 0.35);
  const fixedBurn = Number(track.starting_budget) * FIXED_BURN_RATIO;
  const marketingCost = Math.max(0, Number(strategy.marketingSpend || 0));
  const cost = (cogs + marketingCost + fixedBurn) * budgetMult;
  const contribution = revenue - cost;

  // Debt, not a floor (SPEC.md §2.8): budget can go negative and compounds.
  const priorBudget = Number(state.budget);
  const interest = priorBudget < 0 ? Math.abs(priorBudget) * DEBT_INTEREST : 0;
  const budget = Number((priorBudget - interest + contribution).toFixed(2));
  const debt = Math.max(0, -budget);
  const isInsolvent = debt > INSOLVENCY_DEBT_MULTIPLE * Number(track.starting_budget);

  // Reputation scarring: rises while insolvent/overflowing, decays otherwise.
  let reputationScar = Number(state.reputation_scar || 0);
  if (isInsolvent || overflow > 0) reputationScar = clamp(reputationScar + 0.08, 0, INSOLVENCY_ATTRACTIVENESS_PENALTY);
  else reputationScar = clamp(reputationScar - REPUTATION_SCAR_DECAY * reputationScar, 0, INSOLVENCY_ATTRACTIVENESS_PENALTY);

  return {
    tick: Number(state.tick) + 1,
    budget,
    debt: Number(debt.toFixed(2)),
    isInsolvent,
    productPrice: Number(strategy.productPrice),
    marketingSpend: marketingCost,
    targetSegment: strategy.targetSegment,
    awareness: Number(awareness.toFixed(4)),
    activeCustomers: Number(activeCustomers.toFixed(2)),
    capacity,
    reputationScar: Number(reputationScar.toFixed(4)),
    demandIndex: Number(attractiveness.toFixed(4)),
    conversionRate: Number(conversion.toFixed(2)),
    unitsSold,
    totalUnitsSold: Number(state.total_units_sold || 0) + unitsSold,
    totalRevenue: Number((Number(state.total_revenue || 0) + revenue).toFixed(2)),
    totalCost: Number((Number(state.total_cost || 0) + cost).toFixed(2)),
    netProfit: Number((Number(state.total_revenue || 0) + revenue - Number(state.total_cost || 0) - cost).toFixed(2)),
    deployCount: Number(state.deploy_count || 0) + 1,
    quality: quality ?? null,
    qualityMultiplier: Number(q.toFixed(4)),
    revenue: Number(revenue.toFixed(2)),
    cost: Number(cost.toFixed(2)),
    overflowUnits: Math.round(overflow),
    appliedShocks: shocks.map(s => s.shock_id || s.id),
    // Full per-tick decomposition — this is what powers the "why did my
    // number change" screen (SPEC.md §4.4), not a black box.
    decomposition: {
      poolSize: POOL_UNITS_PER_TEAM * Math.max(1, teamsOnTrack),
      share: Number(share.toFixed(4)),
      conversion: Number(conversion.toFixed(2)),
      unitsSold, revenue: Number(revenue.toFixed(2)),
      cogs: Number(cogs.toFixed(2)), marketingCost, fixedBurn: Number(fixedBurn.toFixed(2)),
      budgetShockMultiplier: Number(budgetMult.toFixed(3)),
      docScore: docScore == null ? null : Number(Number(docScore).toFixed(3)),
      docMultiplier: Number(docMultiplier(docScore).toFixed(3)),
      interest: Number(interest.toFixed(2)),
      overflowUnits: Math.round(overflow),
    },
  };
}

function initialState(track) {
  return {
    trackId: track.id,
    budget: Number(track.starting_budget),
    maxBudget: Number(track.starting_budget),
    productPrice: Number(track.base_price),
    marketingSpend: 0,
    targetSegment: 'mass',
    demandIndex: Number(track.base_demand),
    baseDemand: Number(track.base_demand),
    conversionRate: Number(track.base_conversion),
    baseConversion: Number(track.base_conversion),
    burnRate: Number(track.starting_budget) * FIXED_BURN_RATIO,
    awareness: 0,
    capacity: 500,
    activeCustomers: 0,
    debt: 0,
    isInsolvent: false,
    reputationScar: 0,
  };
}

module.exports = {
  SEGMENTS, attractivenessFor, allocateSharedPool, applyTick, initialState,
  combinedMultiplier, docMultiplier, POOL_UNITS_PER_TEAM, DOC_SCORE_WEIGHT,
};
