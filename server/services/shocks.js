const CATALOG = [
  ['tech_boom','Tech Boom','🚀','A wave of tech adoption sweeps the market. Digital solutions are in high demand as enterprises scramble to digitize.','opportunity','high',50,0,10,3],
  ['recession','Recession','📉','Economic downturn hits hard. Consumer spending drops, budgets get slashed, and every rupee is scrutinized.','threat','critical',-20,-30,-8,4],
  ['data_scandal','Data Privacy Scandal','🔓','A major data breach rocks the industry. Customer trust collapses overnight and regulators close in.','threat','high',-40,-10,-15,3],
  ['competitor_entry','Competitor Entry','⚔️','A well-funded rival enters your space. Market share dilutes and customer acquisition becomes a costly battle.','threat','medium',-20,0,-12,2],
  ['viral_trend','Viral Trend','🔥','Your category explodes on social media. Organic traffic surges and you are riding a perfect wave of attention.','opportunity','high',80,0,20,2],
  ['supply_chain','Supply Chain Crisis','🚢','Global logistics collapse. Delivery delays, cost overruns, and unhappy customers test your resilience.','threat','high',-25,-20,-5,3],
  ['regulatory_crackdown','Regulatory Crackdown','⚖️','New regulations mandate compliance changes immediately. Legal costs spike and product launches are delayed.','threat','high',-15,-25,-3,4],
  ['investor_frenzy','Investor Frenzy','💰','VCs are flush with cash and your sector is hot. Valuations soar and every startup gets a budget injection.','opportunity','medium',30,20,5,2],
  ['market_crash','Market Crash','💥','Black swan event. Markets implode, budgets are cut to zero, and only the most agile teams will survive.','threat','critical',-60,-40,-20,5],
  ['talent_exodus','Talent Exodus','🚪','Key talent is being poached by giants offering massive packages. Productivity drops and morale tanks.','threat','medium',-10,-15,-6,3],
  ['pandemic_surge','Pandemic Surge','🦠','A health crisis reshapes priorities. HealthTech rockets; others face demand collapse as behavior shifts.','wildcard','critical',-30,0,-10,4],
  ['green_mandate','Green Mandate','🌱','Government mandates ESG compliance. CleanTech soars; polluting industries face heavy penalties.','wildcard','medium',-10,-10,0,3]
].map(([id,name,emoji,description,category,severity,demand,budget,conversion,duration]) => ({ id,name,emoji,description,category,severity,effect:{ demand,budget,conversion },duration }));
function getCatalogShock(id) { return CATALOG.find(shock => shock.id === id); }
function serialize(row) { return { id: row.shock_id, instanceId: row.instance_id, name: row.name, emoji: row.emoji || '⚡', description: row.description, category: row.category, severity: row.severity, effect: { demand: Number(row.demand_effect), budget: Number(row.budget_effect), conversion: Number(row.conversion_effect) }, duration: row.duration, deployedAt: new Date(row.deployed_at).getTime(), expiresAt: new Date(row.expires_at).getTime(), targetTeamId: row.target_team_id ? String(row.target_team_id) : null, deployedBy: row.deployed_by || 'judge', resolved: row.resolved ?? false, resolvedAt: row.resolved_at ? new Date(row.resolved_at).getTime() : null }; }
module.exports = { CATALOG, getCatalogShock, serialize };
