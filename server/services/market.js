const CATEGORIES = {
  FinTech: { baseDemand: 70, baseConversion: 8.5, basePrice: 999, budgetMonthly: 80000 },
  HealthTech: { baseDemand: 65, baseConversion: 7.2, basePrice: 1499, budgetMonthly: 100000 },
  EdTech: { baseDemand: 80, baseConversion: 12, basePrice: 599, budgetMonthly: 60000 },
  AgriTech: { baseDemand: 55, baseConversion: 6, basePrice: 799, budgetMonthly: 70000 },
  CleanTech: { baseDemand: 60, baseConversion: 5.5, basePrice: 2499, budgetMonthly: 120000 },
  RetailTech: { baseDemand: 75, baseConversion: 10, basePrice: 449, budgetMonthly: 55000 }
};
const segments = { mass: [1, 1], premium: [0.65, 1.4], niche: [0.5, 1.8] };
function initialState(category) { const c = CATEGORIES[category] || CATEGORIES.FinTech; return { category, budget: c.budgetMonthly, maxBudget: c.budgetMonthly, productPrice: c.basePrice, marketingSpend: 0, targetSegment: 'mass', demandIndex: c.baseDemand, baseDemand: c.baseDemand, conversionRate: c.baseConversion, baseConversion: c.baseConversion, burnRate: c.budgetMonthly * 0.1 }; }
function effectFor(shock, category) { const e = { demand: Number(shock.demand_effect ?? shock.effect?.demand ?? 0), budget: Number(shock.budget_effect ?? shock.effect?.budget ?? 0), conversion: Number(shock.conversion_effect ?? shock.effect?.conversion ?? 0) }; if (shock.shock_id === 'pandemic_surge' && category === 'HealthTech') e.demand = 100; else if (shock.shock_id === 'pandemic_surge') e.demand = -30; if (shock.shock_id === 'green_mandate') e.demand = category === 'CleanTech' ? 40 : -10; if (shock.shock_id === 'tech_boom' && ['FinTech','RetailTech'].includes(category)) e.demand += 15; return e; }
function runTick(state, shocks, strategy) {
  const c = CATEGORIES[state.category] || CATEGORIES.FinTech;
  let demandMultiplier = 1, budgetMultiplier = 1, conversionMultiplier = 1;
  shocks.forEach(shock => { const e = effectFor(shock, state.category); demandMultiplier *= 1 + e.demand / 100; budgetMultiplier *= 1 + e.budget / 100; conversionMultiplier *= 1 + e.conversion / 100; });
  const marketingRatio = Math.min(strategy.marketingSpend / 10000, 3);
  const [segmentMultiplier, segmentConversion] = segments[strategy.targetSegment];
  const priceElasticity = Math.pow(c.basePrice / strategy.productPrice, 0.6);
  const demand = Math.max(0, (c.baseDemand + marketingRatio * 8) * demandMultiplier * priceElasticity * segmentMultiplier + (Math.random() - 0.4) * 8);
  const conversion = Math.max(0.1, Math.min(30, (c.baseConversion + marketingRatio * 1.5) * conversionMultiplier * segmentConversion + (Math.random() - 0.4) * 1.5));
  const units = Math.floor(demand * 200 * conversion / 100);
  const revenue = units * strategy.productPrice;
  const cost = strategy.marketingSpend + Number(state.burn_rate ?? state.burnRate ?? 0) + c.budgetMonthly * 0.05;
  const budget = Math.max(0, state.budget - cost - cost * (budgetMultiplier - 1) + revenue * 0.1);
  return { tick: state.tick + 1, budget: Number(budget.toFixed(2)), productPrice: strategy.productPrice, marketingSpend: strategy.marketingSpend, targetSegment: strategy.targetSegment, demandIndex: Number(demand.toFixed(2)), conversionRate: Number(conversion.toFixed(2)), unitsSold: units, units, totalUnitsSold: Number(state.total_units_sold ?? state.totalUnitsSold ?? 0) + units, totalRevenue: Number((Number(state.total_revenue ?? state.totalRevenue ?? 0) + revenue).toFixed(2)), totalCost: Number((Number(state.total_cost ?? state.totalCost ?? 0) + cost).toFixed(2)), netProfit: Number((Number(state.total_revenue ?? state.totalRevenue ?? 0) + revenue - Number(state.total_cost ?? state.totalCost ?? 0) - cost).toFixed(2)), lastDeployedAt: new Date(), deployCount: state.deploy_count + 1, demand, conversion, revenue, cost, appliedShocks: shocks.map(s => s.shock_id) };
}
module.exports = { CATEGORIES, initialState, runTick };
