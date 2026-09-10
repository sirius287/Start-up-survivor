/* ============================================================
   STARTUP SURVIVOR — Market Simulation Engine
   ============================================================ */

const Market = {

  /* ── Category base configs ── */
  CATEGORIES: {
    FinTech:    { baseDemand: 70, baseConversion: 8.5,  basePrice: 999,  budgetMonthly: 80000,  demandColor: '#00f5ff' },
    HealthTech: { baseDemand: 65, baseConversion: 7.2,  basePrice: 1499, budgetMonthly: 100000, demandColor: '#00ff88' },
    EdTech:     { baseDemand: 80, baseConversion: 12.0, basePrice: 599,  budgetMonthly: 60000,  demandColor: '#7c3aed' },
    AgriTech:   { baseDemand: 55, baseConversion: 6.0,  basePrice: 799,  budgetMonthly: 70000,  demandColor: '#ffaa00' },
    CleanTech:  { baseDemand: 60, baseConversion: 5.5,  basePrice: 2499, budgetMonthly: 120000, demandColor: '#ff4444' },
    RetailTech: { baseDemand: 75, baseConversion: 10.0, basePrice: 449,  budgetMonthly: 55000,  demandColor: '#ff6b6b' },
  },

  /* ── Init a fresh team market state ── */
  initTeamState(category) {
    const cfg = this.CATEGORIES[category] || this.CATEGORIES.FinTech;
    return {
      category,
      tick: 0,
      budget: cfg.budgetMonthly,
      maxBudget: cfg.budgetMonthly,
      productPrice: cfg.basePrice,
      marketingSpend: 0,
      targetSegment: 'mass',

      demandIndex: cfg.baseDemand,
      baseDemand: cfg.baseDemand,
      conversionRate: cfg.baseConversion,
      baseConversion: cfg.baseConversion,

      unitsSold: 0,
      totalUnitsSold: 0,
      totalRevenue: 0,
      totalCost: 0,
      netProfit: 0,
      burnRate: cfg.budgetMonthly * 0.1,

      revenueHistory: [0],
      unitsHistory: [0],
      demandHistory: [cfg.baseDemand],
      conversionHistory: [cfg.baseConversion],

      bmc: {
        keyPartners: '',
        keyActivities: '',
        keyResources: '',
        valueProposition: '',
        customerRelationships: '',
        channels: '',
        customerSegments: '',
        costStructure: '',
        revenueStreams: '',
      },

      lastDeployedAt: null,
      deployCount: 0,

      appliedShocks: [],
      shockMultipliers: {
        demand: 1,
        budget: 1,
        conversion: 1,
        price: 1,
      },
    };
  },

  /* ── Run a single market tick for a team ── */
  runTick(teamState, globalShocks = []) {
    const cfg = this.CATEGORIES[teamState.category] || this.CATEGORIES.FinTech;
    const st = { ...teamState };

    // Compute composite shock multipliers
    let demMult = 1, budMult = 1, convMult = 1;
    for (const shock of globalShocks) {
      const effect = this._resolveEffect(shock, st.category);
      demMult  *= (1 + effect.demand / 100);
      budMult  *= (1 + effect.budget / 100);
      convMult *= (1 + effect.conversion / 100);
    }

    // Marketing spend boosts demand and conversion
    const marketingRatio = Math.min(st.marketingSpend / 10000, 3);
    const marketingDemandBoost   = marketingRatio * 8;
    const marketingConversionBoost = marketingRatio * 1.5;

    // Segment multipliers
    const segMults = { mass: 1.0, premium: 0.65, niche: 0.5 };
    const segConvMults = { mass: 1.0, premium: 1.4, niche: 1.8 };
    const segMult = segMults[st.targetSegment] || 1;
    const segConvMult = segConvMults[st.targetSegment] || 1;

    // Price elasticity: higher price → lower demand
    const priceElasticity = Math.pow(cfg.basePrice / st.productPrice, 0.6);

    // Effective demand
    const effectiveDemand = Math.max(0,
      (cfg.baseDemand + marketingDemandBoost) * demMult * priceElasticity * segMult
      + (Math.random() - 0.4) * 8
    );

    // Effective conversion
    const effectiveConversion = Math.max(0.1, Math.min(30,
      (cfg.baseConversion + marketingConversionBoost) * convMult * segConvMult
      + (Math.random() - 0.4) * 1.5
    ));

    // Units sold this tick (demand = potential customers / 1000, conversion = %)
    const potentialCustomers = effectiveDemand * 200;
    const unitsSoldThisTick = Math.floor(potentialCustomers * (effectiveConversion / 100));

    // Revenue
    const revenueThisTick = unitsSoldThisTick * st.productPrice;

    // Costs: marketing + burn + fixed overhead
    const fixedOverhead = cfg.budgetMonthly * 0.05;
    const costThisTick  = st.marketingSpend + st.burnRate + fixedOverhead;

    // Budget impact from shocks
    const budgetDelta = costThisTick * (budMult - 1); // extra drain from shocks
    const newBudget   = Math.max(0, st.budget - costThisTick - budgetDelta + revenueThisTick * 0.1);

    // Accumulate
    st.tick += 1;
    st.demandIndex     = parseFloat(effectiveDemand.toFixed(2));
    st.conversionRate  = parseFloat(effectiveConversion.toFixed(2));
    st.unitsSold       = unitsSoldThisTick;
    st.totalUnitsSold += unitsSoldThisTick;
    st.totalRevenue   += revenueThisTick;
    st.totalCost      += costThisTick;
    st.netProfit       = st.totalRevenue - st.totalCost;
    st.budget          = parseFloat(newBudget.toFixed(2));
    st.lastDeployedAt  = Date.now();
    st.deployCount    += 1;

    // History (keep last 20)
    const push = (arr, val) => { arr.push(val); if (arr.length > 20) arr.shift(); };
    push(st.revenueHistory,    revenueThisTick);
    push(st.unitsHistory,      unitsSoldThisTick);
    push(st.demandHistory,     effectiveDemand);
    push(st.conversionHistory, effectiveConversion);

    st.appliedShocks = globalShocks.map(s => s.id);

    return st;
  },

  /* ── Resolve shock effects, with category modifiers ── */
  _resolveEffect(shock, category) {
    const base = { ...shock.effect };

    // Category-specific overrides
    if (shock.id === 'pandemic_surge') {
      if (category === 'HealthTech') { base.demand = 100; }
      else { base.demand = -30; }
    }
    if (shock.id === 'green_mandate') {
      if (category === 'CleanTech') { base.demand = 40; }
      else { base.demand = -10; }
    }
    if (shock.id === 'tech_boom') {
      if (category === 'FinTech' || category === 'RetailTech') base.demand += 15;
    }
    return base;
  },

  /* ── Compute leaderboard from all team states ── */
  computeLeaderboard(state) {
    return state.teams
      .filter(t => t.isActive)
      .map(t => {
        const ms = state.marketState[t.id] || {};
        return {
          teamId:       t.id,
          teamName:     t.teamName,
          startupName:  t.startupName,
          category:     t.category,
          totalRevenue: ms.totalRevenue || 0,
          netProfit:    ms.netProfit || 0,
          budget:       ms.budget || 0,
          convRate:     ms.conversionRate || 0,
          unitsSold:    ms.totalUnitsSold || 0,
          tick:         ms.tick || 0,
        };
      })
      .sort((a, b) => b.totalRevenue - a.totalRevenue);
  },
};
