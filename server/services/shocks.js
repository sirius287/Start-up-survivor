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
/* POWERS — the mirror image of shocks. Judges grant these, they are always
   POSITIVE, and they always land on every team at once. A judge never picks
   which team benefits and never picks which power lands: the server rolls it.
   That is the whole point — a judge can inject drama without being able to
   favour anyone. */
const POWERS = [
  ['viral_moment',   'Viral Moment',       '🔥', 'Your category catches fire on social. Attention floods in for everyone willing to spend on it.', 45, 0,  12, 2],
  ['press_feature',  'Press Feature',      '📰', 'A major outlet runs a feature on the sector. Every founder gets a hearing they did not have yesterday.', 30, 0,  6,  2],
  ['investor_cheque','Investor Cheque',    '💰', 'A fund writes cheques across the whole cohort. Runway extends for everyone.', 0,  30, 0,  3],
  ['trust_surge',    'Trust Surge',        '🤝', 'A trust mark lands for the category. Buyers who were hesitating start converting.', 10, 0,  20, 2],
  ['supply_deal',    'Supply Deal',        '📦', 'A group supply agreement cuts unit costs across the cohort.', 8,  20, 0,  3],
  ['ops_efficiency', 'Ops Efficiency',     '⚙️', 'A shared playbook lands. Burn drops for everyone who reads it.', 0,  25, 5,  3],
  ['talent_influx',  'Talent Influx',      '🧠', 'A wave of talent hits the market. Teams that can absorb it move faster.', 15, 10, 8,  2],
].map(([id, name, emoji, description, demand, budget, conversion, duration]) =>
  ({ id, name, emoji, description, category: 'power', severity: 'boost', effect: { demand, budget, conversion }, duration }));

function getCatalogShock(id) { return CATALOG.find(shock => shock.id === id); }
function getPower(id) { return POWERS.find(p => p.id === id); }
/** Server-rolled so a judge cannot choose who it favours or what it does. */
function randomPower() { return POWERS[Math.floor(Math.random() * POWERS.length)]; }
function serialize(row) { return { id: row.shock_id, instanceId: row.instance_id, name: row.name, emoji: row.emoji || '⚡', description: row.description, category: row.category, severity: row.severity, effect: { demand: Number(row.demand_effect), budget: Number(row.budget_effect), conversion: Number(row.conversion_effect) }, duration: row.duration, deployedAt: new Date(row.deployed_at).getTime(), expiresAt: new Date(row.expires_at).getTime(), targetTeamId: row.target_team_id ? String(row.target_team_id) : null, deployedBy: row.deployed_by || 'judge', resolved: row.resolved ?? false, resolvedAt: row.resolved_at ? new Date(row.resolved_at).getTime() : null }; }
module.exports = { CATALOG, POWERS, getCatalogShock, getPower, randomPower, serialize };
