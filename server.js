const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// In-memory Database
let state = {
  activeShock: null, // e.g. { name: "Tech Boom", demandMultiplier: 1.5, budgetMultiplier: 1.0 }
  startups: {} // socketId -> startup object
};

// Available Shocks for Judges
const SHOCKS = {
  "TECH_BOOM": { name: "Tech Boom 🚀", demandMultiplier: 1.5, budgetMultiplier: 1.0, description: "+50% Demand across all sectors!" },
  "RECESSION": { name: "Recession 📉", demandMultiplier: 0.7, budgetMultiplier: 0.7, description: "-30% Demand & -30% Budget limits!" },
  "PRIVACY_SCANDAL": { name: "Data Privacy Scandal 🔒", demandMultiplier: 0.5, budgetMultiplier: 1.0, description: "-50% Tech Conversion Rate!" },
  "NORMAL": { name: "Market Stabilized ⚖️", demandMultiplier: 1.0, budgetMultiplier: 1.0, description: "Market conditions returned to normal." }
};

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Register Startup
  socket.on('register_startup', (data) => {
    state.startups[socket.id] = {
      id: socket.id,
      name: data.name || "Stealth Startup",
      category: data.category || "Tech",
      unitPrice: parseFloat(data.unitPrice) || 50,
      budget: 10000,
      revenue: 0,
      totalUnitsSold: 0,
      lastTurnSales: 0,
      lastTurnConversion: 0
    };
    socket.emit('startup_updated', state.startups[socket.id]);
    io.emit('admin_state_update', state);
  });

  // Startup updates price/strategy
  socket.on('update_product', (data) => {
    if (state.startups[socket.id]) {
      state.startups[socket.id].unitPrice = Math.max(1, parseFloat(data.unitPrice) || 1);
      socket.emit('startup_updated', state.startups[socket.id]);
      io.emit('admin_state_update', state);
    }
  });

  // Admin throws a shock
  socket.on('trigger_shock', (shockKey) => {
    if (SHOCKS[shockKey]) {
      state.activeShock = SHOCKS[shockKey];
      io.emit('market_shock_event', state.activeShock);
      io.emit('admin_state_update', state);
    }
  });

  socket.on('disconnect', () => {
    delete state.startups[socket.id];
    io.emit('admin_state_update', state);
  });
});

// Simulation Loop (Runs every 4 seconds = 1 Market Cycle/Month)
setInterval(() => {
  const currentShock = state.activeShock || SHOCKS["NORMAL"];
  
  Object.keys(state.startups).forEach((id) => {
    let startup = state.startups[id];

    // Base market willingness to pay based on category
    let idealPrice = startup.category === "Tech" ? 100 : 40;
    let baseDemand = 100;

    // Price Elasticity Logic: Higher price = lower conversion
    let priceRatio = startup.unitPrice / idealPrice;
    let baseConversion = Math.max(0.05, Math.min(0.9, 1 / (priceRatio * priceRatio)));

    // Apply Active Shock Multipliers
    let effectiveDemand = baseDemand * currentShock.demandMultiplier;
    let finalConversion = baseConversion;

    if (currentShock.name.includes("Privacy") && startup.category === "Tech") {
      finalConversion *= 0.5; // Extra penalty for Tech in Privacy scandal
    }

    // Calculate Sales
    let potentialBuyers = Math.floor(effectiveDemand * (Math.random() * 0.4 + 0.8));
    let unitsSold = Math.floor(potentialBuyers * finalConversion);
    let cycleRevenue = unitsSold * startup.unitPrice;

    // Deduct fixed operational cost ($200 per cycle)
    let opCosts = 200;
    
    // Update Stats
    startup.totalUnitsSold += unitsSold;
    startup.revenue += cycleRevenue;
    startup.budget = startup.budget + cycleRevenue - opCosts;
    startup.lastTurnSales = unitsSold;
    startup.lastTurnConversion = (finalConversion * 100).toFixed(1);

    // Emit live stats to specific startup
    io.to(id).emit('cycle_tick', {
      startup: startup,
      activeShock: currentShock
    });
  });

  // Send aggregated data to Admin
  io.emit('admin_state_update', state);

}, 4000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Market Simulation Server running on http://localhost:${PORT}`);
});