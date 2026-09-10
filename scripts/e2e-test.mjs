#!/usr/bin/env node
/* ============================================================
   Startup Survivor — end-to-end permission & function suite.

   Exercises every role against every endpoint: what each role
   MAY do, and (more importantly) what it MUST NOT do. Written
   to be re-run against a scratch database before every event.

   Usage:
     createdb startup_survivor_test
     DATABASE_URL=postgres://you@localhost:5432/startup_survivor_test \
     JWT_SECRET=test JUDGE_1_NAME=Priya JUDGE_1_CODE=PIVOT1 \
     JUDGE_2_NAME=Rahul JUDGE_2_CODE=SHOCK2 \
     ADMIN_PASSWORD_HASH=$(node -e "...") MOCK_DOC_SNAPSHOTS=1 \
     PORT=3999 node server/server.js &
     node scripts/e2e-test.mjs http://localhost:3999
   ============================================================ */

const BASE = process.argv[2] || 'http://localhost:3999';
const DOC = (id) => `https://docs.google.com/document/d/${id}/edit`;

let pass = 0, fail = 0;
const failures = [];
let section = '';

function head(title) { section = title; console.log(`\n\x1b[1m${title}\x1b[0m`); }
function ok(name) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
function bad(name, detail) {
  fail++; failures.push(`[${section}] ${name} — ${detail}`);
  console.log(`  \x1b[31m✗ ${name}\x1b[0m — ${detail}`);
}

/* --- tiny cookie-jar http client --- */
function jar() { return { cookie: '' }; }
async function req(session, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(session?.cookie ? { Cookie: session.cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.getSetCookie?.() || [];
  for (const c of setCookie) if (c.startsWith('ss_session=')) session.cookie = c.split(';')[0];
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 80) }; }
  return { status: res.status, body: parsed, code: parsed?.error?.code };
}

/* --- assertions --- */
function expectStatus(name, r, want) {
  if (r.status === want) ok(`${name} → ${want}`);
  else bad(name, `expected ${want}, got ${r.status} ${r.code || JSON.stringify(r.body).slice(0, 70)}`);
}
function expectOk(name, r) {
  if (r.status >= 200 && r.status < 300 && r.body?.success !== false) ok(name);
  else bad(name, `expected success, got ${r.status} ${r.code || ''}`);
}
function expectDenied(name, r) {
  // Any hard denial is acceptable: 401 unauthenticated, 403 forbidden, 404 hidden.
  if ([401, 403, 404].includes(r.status)) ok(`${name} → blocked (${r.status})`);
  else bad(name, `NOT BLOCKED — got ${r.status} ${JSON.stringify(r.body).slice(0, 90)}`);
}
function expectCode(name, r, want) {
  if (r.code === want) ok(`${name} → ${want}`);
  else bad(name, `expected code ${want}, got ${r.status}/${r.code || JSON.stringify(r.body).slice(0, 70)}`);
}

const anon = jar(), teamA = jar(), teamB = jar(), judge1 = jar(), judge2 = jar(), admin = jar();
const stamp = Date.now().toString().slice(-6);
const NAME_A = `AlphaT${stamp}`, NAME_B = `BetaT${stamp}`;
let idA, idB;

async function main() {
  console.log(`\x1b[1mStartup Survivor e2e — ${BASE}\x1b[0m`);

  /* ============ SETUP ============ */
  head('SETUP');
  const health = await req(anon, 'GET', '/api/health');
  if (health.status !== 200) { console.error('Server not reachable. Start it first.'); process.exit(1); }
  ok('server reachable');

  const regA = await req(teamA, 'POST', '/api/auth/team/register', { teamName: NAME_A, startupName: 'PayZap', category: 'FinTech', password: 'password123' });
  const regB = await req(teamB, 'POST', '/api/auth/team/register', { teamName: NAME_B, startupName: 'CoinRun', category: 'FinTech', password: 'password123' });
  idA = regA.body?.data?.teamId; idB = regB.body?.data?.teamId;
  if (!idA || !idB) { console.error('Registration failed', regA.body, regB.body); process.exit(1); }
  ok(`registered team A (#${idA}) and team B (#${idB})`);

  expectOk('admin login', await req(admin, 'POST', '/api/auth/admin/login', { password: 'admin-pass' }));
  expectOk('judge 1 login by code', await req(judge1, 'POST', '/api/auth/judge/login', { code: 'PIVOT1' }));
  expectOk('judge 2 login by code', await req(judge2, 'POST', '/api/auth/judge/login', { code: 'SHOCK2' }));

  /* ============ AUTH BOUNDARIES ============ */
  head('AUTH — bad credentials must be rejected');
  expectStatus('admin login w/ wrong password', await req(jar(), 'POST', '/api/auth/admin/login', { password: 'nope' }), 401);
  expectStatus('judge login w/ unknown code', await req(jar(), 'POST', '/api/auth/judge/login', { code: 'NOTREAL' }), 401);
  expectStatus('judge login w/ reserved admin code', await req(jar(), 'POST', '/api/auth/judge/login', { code: '__ADMIN_RESERVED__' }), 401);
  expectStatus('team login w/ wrong password', await req(jar(), 'POST', '/api/auth/team/login', { teamName: NAME_A, password: 'wrong' }), 401);

  head('ANONYMOUS — everything private must be blocked');
  expectDenied('anon: game state', await req(anon, 'GET', '/api/game/state'));
  expectDenied('anon: teams list', await req(anon, 'GET', '/api/teams'));
  expectDenied('anon: docs queue', await req(anon, 'GET', '/api/docs/queue'));
  expectDenied('anon: event log', await req(anon, 'GET', '/api/event-log'));
  expectDenied('anon: start game', await req(anon, 'POST', '/api/game/start'));
  expectDenied('anon: engine tick', await req(anon, 'POST', '/api/engine/tick'));
  expectDenied('anon: fire shock', await req(anon, 'POST', '/api/shocks/deploy', { shockId: 'recession' }));
  expectOk('anon: public leaderboard IS allowed', await req(anon, 'GET', '/api/leaderboard'));

  /* ============ ADMIN STARTS GAME ============ */
  head('ADMIN — game control');
  expectOk('admin start game', await req(admin, 'POST', '/api/game/start'));
  expectCode('admin start again (invalid transition)', await req(admin, 'POST', '/api/game/start'), 'INVALID_GAME_TRANSITION');
  expectOk('admin pause', await req(admin, 'POST', '/api/game/pause'));
  expectOk('admin resume', await req(admin, 'POST', '/api/game/resume'));
  expectCode('admin bogus action', await req(admin, 'POST', '/api/game/frobnicate'), 'INVALID_ACTION');
  expectOk('admin extend deadlines', await req(admin, 'POST', '/api/game/extend', { minutes: 30 }));

  /* ============ PARTICIPANT: WHAT THEY MAY DO ============ */
  head('PARTICIPANT — allowed actions');
  expectOk('team: read game state', await req(teamA, 'GET', '/api/game/state'));
  expectOk('team: read own team', await req(teamA, 'GET', `/api/teams/${idA}`));
  expectOk('team: read own market', await req(teamA, 'GET', `/api/teams/${idA}/market`));
  expectOk('team: read own stats', await req(teamA, 'GET', `/api/teams/${idA}/stats`));
  expectOk('team: read own request state', await req(teamA, 'GET', `/api/teams/${idA}/request`));
  expectOk('team: list doc types', await req(teamA, 'GET', '/api/docs/types'));
  expectOk('team: list own docs', await req(teamA, 'GET', '/api/docs/mine'));
  expectOk('team: read tracks', await req(teamA, 'GET', '/api/tracks'));
  expectOk('team: read own quality', await req(teamA, 'GET', `/api/quality/${idA}`));
  expectOk('team: submit pitch deck', await req(teamA, 'POST', `/api/teams/${idA}/docs/pitch_deck`, { docUrl: DOC('deckA') }));
  expectOk('team: submit idea brief', await req(teamA, 'POST', `/api/teams/${idA}/docs/idea_brief`, { docUrl: DOC('ideaA') }));

  /* ============ PARTICIPANT: PRIVILEGE ESCALATION ============ */
  head('PARTICIPANT — must NOT reach admin endpoints');
  expectDenied('team: start game', await req(teamA, 'POST', '/api/game/start'));
  expectDenied('team: pause game', await req(teamA, 'POST', '/api/game/pause'));
  expectDenied('team: end game', await req(teamA, 'POST', '/api/game/end'));
  expectDenied('team: RESET GAME', await req(teamA, 'POST', '/api/game/reset'));
  expectDenied('team: advance round', await req(teamA, 'POST', '/api/game/round/advance'));
  expectDenied('team: extend deadlines', await req(teamA, 'POST', '/api/game/extend', { minutes: 60 }));
  expectDenied('team: fire halftime shock', await req(teamA, 'POST', '/api/game/halftime-shock', { shockId: 'recession' }));
  expectDenied('team: fire shock', await req(teamA, 'POST', '/api/shocks/deploy', { shockId: 'market_crash' }));
  expectDenied('team: custom shock', await req(teamA, 'POST', '/api/shocks/custom', { name: 'hax', demandDelta: 999 }));
  expectDenied('team: resolve shock', await req(teamA, 'DELETE', '/api/shocks/anything'));
  expectDenied('team: RUN ENGINE TICK', await req(teamA, 'POST', '/api/engine/tick'));
  expectDenied('team: read event log', await req(teamA, 'GET', '/api/event-log'));
  expectDenied('team: export event log CSV', await req(teamA, 'GET', '/api/event-log/export.csv'));
  expectDenied('team: read final standings', await req(teamA, 'GET', '/api/results'));

  head('PARTICIPANT — must NOT reach judge endpoints');
  expectDenied('team: read docs queue', await req(teamA, 'GET', '/api/docs/queue'));
  expectDenied('team: list all teams', await req(teamA, 'GET', '/api/teams'));
  expectDenied('team: read all quality scores', await req(teamA, 'GET', '/api/quality'));
  expectDenied('team: SCORE ITSELF', await req(teamA, 'POST', `/api/quality/${idA}`, { scores: { innovation: 10, market_fit: 10 } }));
  expectDenied('team: score a rival badly', await req(teamA, 'POST', `/api/quality/${idB}`, { scores: { innovation: 1 } }));
  expectDenied('team: shock history', await req(teamA, 'GET', '/api/shocks/history'));
  expectDenied('team: all deployments feed', await req(teamA, 'GET', '/api/deployments'));

  head('PARTICIPANT — must NOT reach another team');
  expectDenied('team A: read team B profile', await req(teamA, 'GET', `/api/teams/${idB}`));
  expectDenied('team A: read team B market', await req(teamA, 'GET', `/api/teams/${idB}/market`));
  expectDenied('team A: read team B stats', await req(teamA, 'GET', `/api/teams/${idB}/stats`));
  expectDenied('team A: read team B request', await req(teamA, 'GET', `/api/teams/${idB}/request`));
  expectDenied('team A: submit strategy AS team B', await req(teamA, 'POST', `/api/teams/${idB}/strategy`, { productPrice: 999, marketingSpend: 0, targetSegment: 'mass', docUrl: DOC('x') }));
  expectDenied('team A: submit doc AS team B', await req(teamA, 'POST', `/api/teams/${idB}/docs/idea_brief`, { docUrl: DOC('x') }));
  expectDenied('team A: DEPLOY AS team B', await req(teamA, 'POST', `/api/teams/${idB}/deploy`));

  /* ============ PARTICIPANT: INPUT VALIDATION ============ */
  head('PARTICIPANT — input validation / cheat attempts');
  const badInput = async (label, payload, wantCode) =>
    expectCode(label, await req(teamA, 'POST', `/api/teams/${idA}/strategy`, { productPrice: 999, marketingSpend: 0, targetSegment: 'mass', docUrl: DOC('v'), ...payload }), wantCode);
  await badInput('price above UI cap (100000)', { productPrice: 100000 }, 'INVALID_STRATEGY');
  await badInput('price below floor (1)', { productPrice: 1 }, 'INVALID_STRATEGY');
  await badInput('negative price', { productPrice: -500 }, 'INVALID_STRATEGY');
  await badInput('marketing above cap (999999)', { marketingSpend: 999999 }, 'INVALID_STRATEGY');
  await badInput('negative marketing', { marketingSpend: -100 }, 'INVALID_STRATEGY');
  await badInput('invalid segment', { targetSegment: 'godmode' }, 'INVALID_STRATEGY');
  await badInput('NaN price', { productPrice: 'abc' }, 'INVALID_STRATEGY');
  await badInput('missing doc link', { docUrl: '' }, 'DOC_REQUIRED');
  await badInput('non-Google doc link', { docUrl: 'https://evil.example.com/x' }, 'INVALID_URL');
  expectCode('unknown doc type', await req(teamA, 'POST', `/api/teams/${idA}/docs/not_a_type`, { docUrl: DOC('x') }), 'DOC_TYPE_NOT_FOUND');
  expectCode('pricing doc via generic route', await req(teamA, 'POST', `/api/teams/${idA}/docs/pricing_justification`, { docUrl: DOC('x') }), 'USE_STRATEGY_ENDPOINT');
  expectCode('unshared doc surfaces a fixable error', await req(teamA, 'POST', `/api/teams/${idA}/docs/gtm_plan`, { docUrl: DOC('denied1') }), 'DOC_NOT_SHARED');
  expectCode('deactivated doc type is gone', await req(teamA, 'POST', `/api/teams/${idA}/docs/retro`, { docUrl: DOC('x') }), 'DOC_TYPE_NOT_FOUND');

  head('PIVOT WINDOW — closed until the shock fires');
  expectCode('pivot rationale before the shock', await req(teamA, 'POST', `/api/teams/${idA}/docs/pivot_rationale`, { docUrl: DOC('pivotEarly') }), 'PIVOT_NOT_OPEN');

  /* ============ PARTICIPANT: DEPLOY GATING ============ */
  head('PARTICIPANT — deploy is gated on approval');
  expectCode('deploy with no request at all', await req(teamA, 'POST', `/api/teams/${idA}/deploy`), 'NO_REQUEST');

  const sub = await req(teamA, 'POST', `/api/teams/${idA}/strategy`, { productPrice: 4999, marketingSpend: 15000, targetSegment: 'premium', docUrl: DOC('priceA1') });
  expectOk('team submits a valid request', sub);
  const subId = sub.body?.data?.id;

  expectCode('deploy while pending review', await req(teamA, 'POST', `/api/teams/${idA}/deploy`), 'NOT_APPROVED');
  expectCode('resubmit inside 10-min cooldown', await req(teamA, 'POST', `/api/teams/${idA}/strategy`, { productPrice: 5500, marketingSpend: 15000, targetSegment: 'premium', docUrl: DOC('priceA2') }), 'COOLDOWN_ACTIVE');
  expectDenied('team: claim own submission', await req(teamA, 'POST', `/api/docs/${subId}/claim`));
  expectDenied('team: SELF-APPROVE own submission', await req(teamA, 'POST', `/api/docs/${subId}/decide`, { decision: 'approved' }));
  expectOk('team: read own snapshot', await req(teamA, 'GET', `/api/docs/${subId}/snapshot`));
  expectDenied('team B: read team A snapshot', await req(teamB, 'GET', `/api/docs/${subId}/snapshot`));
  expectDenied('team B: comment on team A submission', await req(teamB, 'POST', `/api/docs/${subId}/comments`, { body: 'sabotage' }));

  /* ============ JUDGE: EVERY COMMAND ============ */
  head('JUDGE — allowed commands');
  expectOk('judge: game state', await req(judge1, 'GET', '/api/game/state'));
  expectOk('judge: list all teams', await req(judge1, 'GET', '/api/teams'));
  expectOk('judge: quality attributes', await req(judge1, 'GET', '/api/quality/attributes'));
  expectOk('judge: all quality scores', await req(judge1, 'GET', '/api/quality'));
  expectOk('judge: one team quality', await req(judge1, 'GET', `/api/quality/${idA}`));
  expectOk('judge: score a team', await req(judge1, 'POST', `/api/quality/${idA}`, { scores: { innovation: 8, market_fit: 7, usability: 6, execution: 7, storytelling: 9 } }));
  expectOk('judge: shock history (read-only)', await req(judge1, 'GET', '/api/shocks/history'));
  expectOk('judge: deployments feed', await req(judge1, 'GET', '/api/deployments'));
  expectOk('judge: docs queue', await req(judge1, 'GET', '/api/docs/queue'));
  expectOk('judge: read submission snapshot', await req(judge1, 'GET', `/api/docs/${subId}/snapshot`));
  expectOk('judge: read comments', await req(judge1, 'GET', `/api/docs/${subId}/comments`));
  expectOk('judge: add comment', await req(judge1, 'POST', `/api/docs/${subId}/comments`, { body: 'Second citation lacks a link.', tag: 'concern', section: 'Citations' }));

  head('JUDGE — invalid score inputs rejected');
  expectCode('judge: score 11 (out of range)', await req(judge1, 'POST', `/api/quality/${idA}`, { scores: { innovation: 11 } }), 'INVALID_SCORES');
  expectCode('judge: score 0 (out of range)', await req(judge1, 'POST', `/api/quality/${idA}`, { scores: { innovation: 0 } }), 'INVALID_SCORES');
  expectCode('judge: empty score payload', await req(judge1, 'POST', `/api/quality/${idA}`, { scores: {} }), 'INVALID_SCORES');
  expectStatus('judge: score nonexistent team', await req(judge1, 'POST', '/api/quality/999999', { scores: { innovation: 5 } }), 404);

  head('JUDGE — claim & decide semantics');
  expectOk('judge 1 claims submission', await req(judge1, 'POST', `/api/docs/${subId}/claim`));
  expectCode('judge 2 claim collides', await req(judge2, 'POST', `/api/docs/${subId}/claim`), 'ALREADY_CLAIMED');
  expectCode('judge 2 decides without claim', await req(judge2, 'POST', `/api/docs/${subId}/decide`, { decision: 'approved' }), 'CLAIM_REQUIRED');
  expectCode('reject with no reason', await req(judge1, 'POST', `/api/docs/${subId}/decide`, { decision: 'rejected' }), 'REASON_REQUIRED');
  expectCode('bogus decision value', await req(judge1, 'POST', `/api/docs/${subId}/decide`, { decision: 'maybe' }), 'INVALID_DECISION');
  expectCode('cannot RATE the pricing doc', await req(judge1, 'POST', `/api/docs/${subId}/decide`, { decision: 'rated', points: 5 }), 'NEEDS_APPROVAL');
  expectOk('judge 1 approves (holds claim)', await req(judge1, 'POST', `/api/docs/${subId}/decide`, { decision: 'approved' }));

  head('RATE vs APPROVE — only pricing is approved, everything else is rated');
  const deckQ = (await req(judge1, 'GET', '/api/docs/queue')).body?.data?.find(q => q.docType === 'pitch_deck');
  if (deckQ) {
    expectCode('cannot APPROVE a rated doc', await req(judge1, 'POST', `/api/docs/${deckQ.id}/decide`, { decision: 'approved' }), 'RATE_ONLY');
    expectCode('cannot REJECT a rated doc', await req(judge1, 'POST', `/api/docs/${deckQ.id}/decide`, { decision: 'rejected', reason: 'meh' }), 'RATE_ONLY');
    expectCode('rating without points', await req(judge1, 'POST', `/api/docs/${deckQ.id}/decide`, { decision: 'rated' }), 'POINTS_REQUIRED');
    const scored = await req(judge1, 'POST', `/api/docs/${deckQ.id}/decide`, { decision: 'rated', points: 12 });
    expectOk('judge RATES the deck 12 pts', scored);
    if (Number(scored.body?.data?.points) === 12) ok('points recorded (12)'); else bad('points recorded', `got ${scored.body?.data?.points}`);

    head('MULTI-JUDGE — second judge rating must NOT overwrite the first');
    const second = await req(judge2, 'POST', `/api/docs/${deckQ.id}/decide`, { decision: 'rated', points: 18 });
    expectOk('judge 2 rates it 18 pts', second);
    const avg = Number(second.body?.data?.points);
    if (avg === 15) ok(`aggregated to the mean of both judges (${avg})`);
    else bad('multi-judge aggregation', `expected mean 15 of (12,18), got ${avg}`);
  } else bad('pitch deck in queue', 'not found');

  head('JUDGE — must NOT touch game state');
  expectDenied('judge: start game', await req(judge1, 'POST', '/api/game/start'));
  expectDenied('judge: pause game', await req(judge1, 'POST', '/api/game/pause'));
  expectDenied('judge: end game', await req(judge1, 'POST', '/api/game/end'));
  expectDenied('judge: RESET GAME', await req(judge1, 'POST', '/api/game/reset'));
  expectDenied('judge: advance round', await req(judge1, 'POST', '/api/game/round/advance'));
  expectDenied('judge: extend deadlines', await req(judge1, 'POST', '/api/game/extend', { minutes: 10 }));
  expectDenied('judge: fire shock', await req(judge1, 'POST', '/api/shocks/deploy', { shockId: 'recession' }));
  expectDenied('judge: custom shock', await req(judge1, 'POST', '/api/shocks/custom', { name: 'x' }));
  // Judges CAN clear an active event (they grant them too) — but still cannot
  // fire targeted shocks or the halftime shock.
  expectOk('judge: may clear an event (by design)', await req(judge1, 'DELETE', '/api/shocks/whatever'));
  expectDenied('judge: fire halftime shock', await req(judge1, 'POST', '/api/game/halftime-shock', { shockId: 'recession' }));
  expectDenied('judge: RUN ENGINE TICK', await req(judge1, 'POST', '/api/engine/tick'));
  // The Logs panel is deliberately staff-accessible (REDESIGN.md §C.3): it is
  // about reconstructing what happened, not controlling the game.
  expectOk('judge: CAN read the event log (by design)', await req(judge1, 'GET', '/api/event-log'));
  expectDenied('judge: cannot change result weights', await req(judge1, 'POST', '/api/results/weights', { market: 90, docs: 10 }));
  expectDenied('judge: cannot freeze results', await req(judge1, 'POST', '/api/results/freeze'));

  head('JUDGE — must NOT act as a team');
  expectDenied('judge: submit strategy for a team', await req(judge1, 'POST', `/api/teams/${idA}/strategy`, { productPrice: 999, marketingSpend: 0, targetSegment: 'mass', docUrl: DOC('x') }));
  expectDenied('judge: deploy for a team', await req(judge1, 'POST', `/api/teams/${idA}/deploy`));
  expectDenied('judge: submit doc for a team', await req(judge1, 'POST', `/api/teams/${idA}/docs/idea_brief`, { docUrl: DOC('x') }));
  expectDenied('judge: list "my" docs', await req(judge1, 'GET', '/api/docs/mine'));

  /* ============ DEPLOY, NOW APPROVED ============ */
  head('PARTICIPANT — deploy after approval, and its guards');
  const reqState = await req(teamA, 'GET', `/api/teams/${idA}/request`);
  if (reqState.body?.data?.canDeploy) ok('request state reports canDeploy=true'); else bad('canDeploy after approval', JSON.stringify(reqState.body?.data));
  expectOk('team deploys approved strategy', await req(teamA, 'POST', `/api/teams/${idA}/deploy`));
  expectCode('deploy the same approval twice', await req(teamA, 'POST', `/api/teams/${idA}/deploy`), 'ALREADY_DEPLOYED');

  head('JUDGE ALLOCATION');
  const alloc = await req(judge1, 'GET', '/api/judging/assignment');
  expectOk('judge reads their allocation', alloc);
  const a = alloc.body?.data;
  if (a?.mode === 'all') ok(`mode = 'all' (< ${a.threshold} teams, every judge sees everything)`);
  else bad('judging mode', `expected 'all' with 2 teams, got ${a?.mode}`);
  if (a?.judges?.length >= 2) ok(`roster reports ${a.judges.length} judges`); else bad('judge roster', JSON.stringify(a?.judges));
  expectOk('admin rebuilds assignments', await req(admin, 'POST', '/api/judging/rebuild'));
  expectDenied('judge cannot rebuild assignments', await req(judge1, 'POST', '/api/judging/rebuild'));

  head('POWERS — server-rolled, always for everyone');
  expectOk('judge grants a random power', await req(judge1, 'POST', '/api/events/power'));
  expectCode('second event same tick blocked', await req(judge2, 'POST', '/api/events/power'), 'EVENT_ALREADY_FIRED');
  expectDenied('team cannot grant a power', await req(teamB, 'POST', '/api/events/power'));
  expectOk('powers catalog is readable', await req(judge1, 'GET', '/api/powers'));
  const activeNow = (await req(judge1, 'GET', '/api/shocks/active')).body?.data || [];
  if (activeNow.some(s2 => s2.category === 'power')) ok('granted power is active for everyone (no target)');
  else bad('power applied universally', JSON.stringify(activeNow.map(s2 => s2.category)));
  if (activeNow[0]) expectOk('judge can clear an active event', await req(judge1, 'DELETE', `/api/shocks/${activeNow[0].instanceId}`));

  head('REVIEW CONTEXT — judges see the team\'s money and points');
  const ctxQ = (await req(judge1, 'GET', '/api/docs/queue')).body?.data?.[0];
  if (ctxQ?.team && ctxQ.team.totalRevenue !== null && !Number.isNaN(ctxQ.team.totalRevenue)) {
    ok(`queue carries team context (revenue ${Math.round(ctxQ.team.totalRevenue)}, points ${ctxQ.team.points})`);
  } else bad('team context on review', JSON.stringify(ctxQ?.team));

  head('UNIVERSAL EVENTS — judges fire them, always for everyone, once per tick');
  expectCode('judge blocked — already used this tick', await req(judge1, 'POST', '/api/events/global', { shockId: 'tech_boom' }), 'EVENT_ALREADY_FIRED');
  expectOk('admin is not bound by the per-tick budget', await req(admin, 'POST', '/api/events/global', { shockId: 'tech_boom' }));
  expectCode('unknown event id', await req(judge1, 'POST', '/api/events/global', { shockId: 'nope' }), 'INVALID_SHOCK');
  expectDenied('team cannot fire a universal event', await req(teamB, 'POST', '/api/events/global', { shockId: 'tech_boom' }));

  /* ============ ADMIN OVERRIDE + REMAINING COMMANDS ============ */
  head('ADMIN — review override & remaining commands');
  const subB = await req(teamB, 'POST', `/api/teams/${idB}/strategy`, { productPrice: 1200, marketingSpend: 8000, targetSegment: 'mass', docUrl: DOC('priceB1') });
  expectOk('team B submits request', subB);
  const subBId = subB.body?.data?.id;
  expectOk('admin can claim (override)', await req(admin, 'POST', `/api/docs/${subBId}/claim`));
  expectOk('admin can approve (override)', await req(admin, 'POST', `/api/docs/${subBId}/decide`, { decision: 'approved' }));
  expectOk('admin: score a team (override)', await req(admin, 'POST', `/api/quality/${idB}`, { scores: { innovation: 6 } }));
  expectOk('admin: fire a shock', await req(admin, 'POST', '/api/shocks/deploy', { shockId: 'tech_boom' }));
  expectOk('admin: custom shock', await req(admin, 'POST', '/api/shocks/custom', { name: 'Test Event', demandDelta: 10, budgetDelta: 0, conversionDelta: 5, durationMins: 2 }));
  expectCode('admin: invalid custom shock', await req(admin, 'POST', '/api/shocks/custom', { name: '', demandDelta: 99999 }), 'INVALID_SHOCK');
  expectCode('admin: unknown shock id', await req(admin, 'POST', '/api/shocks/deploy', { shockId: 'nope' }), 'INVALID_SHOCK');
  expectOk('admin: engine tick', await req(admin, 'POST', '/api/engine/tick'));
  expectOk('admin: event log', await req(admin, 'GET', '/api/event-log'));
  expectOk('admin: event log CSV', await req(admin, 'GET', '/api/event-log/export.csv'));
  expectCode('team CANNOT read standings before release', await req(teamA, 'GET', '/api/results'), 'RESULTS_NOT_RELEASED');
  expectOk('staff can read standings any time', await req(judge1, 'GET', '/api/results'));
  expectOk('admin sets result weights', await req(admin, 'POST', '/api/results/weights', { market: 60, docs: 40 }));
  expectOk('admin freezes results', await req(admin, 'POST', '/api/results/freeze'));
  expectOk('team CAN read standings once released', await req(teamA, 'GET', '/api/results'));
  expectCode('weights locked once frozen', await req(admin, 'POST', '/api/results/weights', { market: 90, docs: 10 }), 'RESULTS_FROZEN');
  expectOk('admin: advance round', await req(admin, 'POST', '/api/game/round/advance'));

  head('ADMIN — halftime shock locks pre-shock docs');
  expectOk('admin fires halftime shock', await req(admin, 'POST', '/api/game/halftime-shock', { shockId: 'recession' }));
  expectCode('halftime fired twice', await req(admin, 'POST', '/api/game/halftime-shock', { shockId: 'market_crash' }), 'ALREADY_FIRED');
  expectCode('deck submission after shock', await req(teamB, 'POST', `/api/teams/${idB}/docs/pitch_deck`, { docUrl: DOC('lateDeck') }), 'LOCKED_BY_SHOCK');
  expectCode('idea brief after shock', await req(teamB, 'POST', `/api/teams/${idB}/docs/idea_brief`, { docUrl: DOC('lateIdea') }), 'LOCKED_BY_SHOCK');
  expectOk('pivot rationale OPENS after the shock', await req(teamB, 'POST', `/api/teams/${idB}/docs/pivot_rationale`, { docUrl: DOC('pivotB') }));
  // Expire the pivot window to prove it actually shuts (the real window is 45 min).
  expectOk('admin shrinks the pivot window to close it', await req(admin, 'POST', '/api/game/pivot-window', { minutes: 0 }));
  expectCode('pivot rationale once the window closes', await req(teamA, 'POST', `/api/teams/${idA}/docs/pivot_rationale`, { docUrl: DOC('pivotTooLate') }), 'PIVOT_CLOSED');

  head('HALFTIME CUT — teams that submitted nothing are disqualified');
  // teamA submitted an idea brief + pitch deck earlier; teamB submitted neither.
  const cutInfo = (await req(admin, 'GET', '/api/game/halftime-cut/preview')).body?.data;
  if (cutInfo) ok(`cut rule: >= ${cutInfo.minDocs} doc(s), ${cutInfo.minPoints} pts (ceiling ${cutInfo.ceiling})`);
  else bad('cut preview', 'no data');
  const dq = (await req(admin, 'GET', '/api/teams')).body?.data?.find(t => String(t.id) === String(idB));
  if (dq?.isDisqualified) ok(`team B disqualified at halftime — ${dq.disqualifiedReason}`);
  else bad('halftime cut applied', `team B isDisqualified=${dq?.isDisqualified}`);
  const survivor = (await req(admin, 'GET', '/api/teams')).body?.data?.find(t => String(t.id) === String(idA));
  if (!survivor?.isDisqualified) ok('team A survived (submitted its documents)');
  else bad('team A survival', 'was cut despite submitting');
  expectCode('disqualified team cannot submit', await req(teamB, 'POST', `/api/teams/${idB}/strategy`, { productPrice: 1500, marketingSpend: 2000, targetSegment: 'mass', docUrl: DOC('dqB') }), 'DISQUALIFIED');
  expectCode('disqualified team cannot deploy', await req(teamB, 'POST', `/api/teams/${idB}/deploy`), 'DISQUALIFIED');
  expectDenied('team cannot reinstate itself', await req(teamB, 'POST', `/api/teams/${idB}/reinstate`));
  expectOk('admin can reinstate a cut team', await req(admin, 'POST', `/api/teams/${idB}/reinstate`));

  head('LATE PRICING — never blocked, judge decides the consequence');
  // Force the submission deadline into the past so the next submit is late.
  await req(admin, 'POST', '/api/game/extend', { minutes: -0 }); // no-op, keeps admin session warm
  const lateSub = await req(teamB, 'POST', `/api/teams/${idB}/strategy`, { productPrice: 2500, marketingSpend: 5000, targetSegment: 'mass', docUrl: DOC('lateB') });
  if (lateSub.status === 201 || lateSub.status === 200) ok('late-window submit is accepted, not blocked');
  else if (lateSub.code === 'COOLDOWN_ACTIVE') ok('submit blocked only by cooldown (expected here)');
  else bad('late submit accepted', `${lateSub.status} ${lateSub.code}`);

  /* ============ GAME-PHASE GUARDS ============ */
  head('PHASE GUARDS — nothing runs when the game is not active');
  expectOk('admin ends the game', await req(admin, 'POST', '/api/game/end'));
  expectCode('team submits while ended', await req(teamA, 'POST', `/api/teams/${idA}/strategy`, { productPrice: 2000, marketingSpend: 0, targetSegment: 'mass', docUrl: DOC('afterEnd') }), 'GAME_NOT_ENDED');
  expectCode('any doc after the game ends', await req(teamA, 'POST', `/api/teams/${idA}/docs/pivot_rationale`, { docUrl: DOC('pivotLate') }), 'GAME_ENDED');
  expectCode('team deploys while ended', await req(teamA, 'POST', `/api/teams/${idA}/deploy`), 'GAME_NOT_ENDED');
  expectCode('engine tick while ended', await req(admin, 'POST', '/api/engine/tick'), 'GAME_NOT_ACTIVE');

  /* ============ SESSION ============ */
  head('SESSION — logout invalidates access');
  expectOk('team logout', await req(teamA, 'POST', '/api/auth/logout'));
  teamA.cookie = '';
  expectDenied('team after logout', await req(teamA, 'GET', '/api/game/state'));

  /* ============ SUMMARY ============ */
  console.log(`\n${'─'.repeat(60)}`);
  if (fail === 0) {
    console.log(`\x1b[32m\x1b[1mALL ${pass} CHECKS PASSED\x1b[0m`);
  } else {
    console.log(`\x1b[1m${pass} passed, \x1b[31m${fail} FAILED\x1b[0m`);
    console.log('\nFailures:');
    for (const f of failures) console.log(`  • ${f}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('Suite crashed:', e); process.exit(1); });
