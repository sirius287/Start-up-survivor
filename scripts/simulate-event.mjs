#!/usr/bin/env node
/* ============================================================
   Full-event dress rehearsal: 40 teams, 3 judges, 1 admin,
   4 ticks, a halftime shock with a cut, a pivot window, and a
   final winner — driven entirely over HTTP, exactly as the real
   event would run.

   Deliberately includes badly-behaved teams: some never submit,
   some submit only pricing, some are late, some price absurdly.
   The point is to prove the edge cases behave, not to produce a
   tidy demo.

   Run the server with MOCK_DOC_SNAPSHOTS=1, then:
     node scripts/simulate-event.mjs http://localhost:3999
   ============================================================ */

const BASE = process.argv[2] || 'http://localhost:3999';
const TEAM_COUNT = Number(process.env.TEAMS || 40);
const TRACKS = ['FinTech', 'HealthTech', 'EdTech', 'AgriTech', 'CleanTech', 'RetailTech'];
const DOC = (id) => `https://docs.google.com/document/d/${id}/edit`;

const jar = () => ({ cookie: '' });
async function req(s, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(s?.cookie ? { Cookie: s.cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('ss_session=')) s.cookie = c.split(';')[0];
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 60) }; }
  return { status: res.status, body: parsed, code: parsed?.error?.code, data: parsed?.data };
}

const inr = (n) => (n < 0 ? '−' : '+') + '₹' + Math.abs(Math.round(n)).toLocaleString('en-IN');
const bar = (n, max, w = 22) => '█'.repeat(Math.max(0, Math.round((n / (max || 1)) * w))).padEnd(w, '·');
function head(t) { console.log(`\n\x1b[1m${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}\x1b[0m`); }

// Deterministic pseudo-random so the rehearsal is reproducible.
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const admin = jar(), judges = [jar(), jar(), jar()];
const teams = [];
let stats = { submitted: 0, rated: 0, approved: 0, rejected: 0, skipped: 0, deployed: 0 };

async function main() {
  const t0 = Date.now();
  head(`STARTUP SURVIVOR — full event rehearsal · ${TEAM_COUNT} teams · ${BASE}`);

  if ((await req(jar(), 'GET', '/api/health')).status !== 200) {
    console.error('Server not reachable.'); process.exit(1);
  }

  /* ---- 1. Registration ---- */
  head('1. REGISTRATION');
  const stamp = Date.now().toString().slice(-5);
  for (let i = 0; i < TEAM_COUNT; i++) {
    const s = jar();
    const name = `Team${String(i + 1).padStart(2, '0')}_${stamp}`;
    const track = TRACKS[i % TRACKS.length];
    const r = await req(s, 'POST', '/api/auth/team/register', {
      teamName: name, startupName: `Startup${i + 1}`, category: track, password: 'password123',
    });
    if (!r.data?.teamId) { console.error('register failed', r.body); process.exit(1); }
    // Behaviour archetypes, so the run covers real edge cases.
    const archetype = i < 4 ? 'ghost'        // never submits anything
      : i < 8 ? 'pricing-only'               // skips documents
      : i < 12 ? 'sloppy'                    // absurd pricing
      : i < 16 ? 'lean'                      // no marketing spend
      : 'diligent';
    teams.push({ i, id: r.data.teamId, name, track, s, archetype, deployed: 0 });
  }
  const counts = teams.reduce((a, t) => ({ ...a, [t.archetype]: (a[t.archetype] || 0) + 1 }), {});
  console.log(`  registered ${teams.length} teams across ${TRACKS.length} tracks`);
  console.log(`  archetypes: ${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(', ')}`);

  await req(admin, 'POST', '/api/auth/admin/login', { password: 'admin-pass' });
  for (let j = 0; j < 3; j++) await req(judges[j], 'POST', '/api/auth/judge/login', { code: `JUDGE${j + 1}` });
  console.log('  admin + 3 judges logged in');

  const alloc = (await req(judges[0], 'GET', '/api/judging/assignment')).data;
  console.log(`  judging mode: \x1b[1m${alloc.mode}\x1b[0m (threshold ${alloc.threshold} teams)`);
  console.log(`  split: ${alloc.judges.map(j => `${j.name}=${j.teamCount}`).join(', ')}`);

  await req(admin, 'POST', '/api/game/start');
  console.log('  game started');

  /* ---- 2. Four ticks ---- */
  const SCHEDULE = { 1: 'idea_brief', 2: 'pitch_deck', 3: 'financial_model', 4: 'final_deck' };

  for (let tick = 1; tick <= 4; tick++) {
    head(`2.${tick}  TICK ${tick}${tick === 3 ? '  (post-shock, round 2)' : ''}`);

    // --- documents due this tick ---
    const docType = SCHEDULE[tick];
    let docsIn = 0;
    for (const t of teams) {
      if (t.archetype === 'ghost' || t.archetype === 'pricing-only') { stats.skipped++; continue; }
      if (t.cut) continue;
      const r = await req(t.s, 'POST', `/api/teams/${t.id}/docs/${docType}`, { docUrl: DOC(`${docType}_${t.id}`) });
      if (r.status < 300) { docsIn++; stats.submitted++; }
    }
    console.log(`  ${docsIn} teams submitted "${docType}"`);

    // --- strategies + pricing docs ---
    let strategies = 0;
    for (const t of teams) {
      if (t.archetype === 'ghost' || t.cut) { stats.skipped++; continue; }
      const track = t.track;
      let price, mkt, seg;
      if (t.archetype === 'sloppy') { price = 9999; mkt = 30000; seg = 'mass'; }        // overpriced + overspending
      else if (t.archetype === 'lean') { price = 800 + Math.round(rnd() * 400); mkt = 0; seg = 'niche'; }
      else { price = 900 + Math.round(rnd() * 2600); mkt = 6000 + Math.round(rnd() * 16000); seg = pick(['mass', 'premium', 'niche']); }
      const r = await req(t.s, 'POST', `/api/teams/${t.id}/strategy`, {
        productPrice: price, marketingSpend: mkt, targetSegment: seg, docUrl: DOC(`price_${t.id}_t${tick}`),
      });
      if (r.status < 300) { strategies++; t.lastStrategy = { price, mkt, seg }; }
    }
    console.log(`  ${strategies} teams submitted a strategy + pricing doc`);

    // --- judges work the queue ---
    let approved = 0, rejected = 0, rated = 0;
    for (let round = 0; round < 3; round++) {
      for (let j = 0; j < judges.length; j++) {
        const queue = (await req(judges[j], 'GET', '/api/docs/queue')).data || [];
        for (const item of queue.slice(0, 40)) {
          if (item.claimedByName && item.claimedBy && !item.gatesTick) continue;
          if (item.gatesTick) {
            // Pricing: approve/reject. Reject the absurd ones.
            const c = await req(judges[j], 'POST', `/api/docs/${item.id}/claim`);
            if (c.status >= 300) continue;
            const bad = Number(item.price) >= 9999;
            const d = await req(judges[j], 'POST', `/api/docs/${item.id}/decide`,
              bad ? { decision: 'rejected', reason: 'Price unjustified by the citations.' } : { decision: 'approved' });
            if (d.status < 300) { bad ? rejected++ : approved++; }
          } else {
            // Documents: rated for points, several judges may rate the same one.
            const pts = Math.round(item.maxPoints * (0.35 + rnd() * 0.6));
            const d = await req(judges[j], 'POST', `/api/docs/${item.id}/decide`, { decision: 'rated', points: pts });
            if (d.status < 300) rated++;
          }
        }
      }
    }
    stats.approved += approved; stats.rejected += rejected; stats.rated += rated;
    console.log(`  judges: ${approved} pricing approved, ${rejected} rejected, ${rated} document ratings`);

    // --- rubric scoring (judges score their assigned teams) ---
    let scored = 0;
    if (tick === 2 || tick === 4) {
      for (let j = 0; j < judges.length; j++) {
        const mine = (await req(judges[j], 'GET', '/api/judging/assignment')).data?.myTeamIds || [];
        for (const teamId of mine) {
          const base = 3 + rnd() * 6; // each judge has their own habitual range
          const r = await req(judges[j], 'POST', `/api/quality/${teamId}`, {
            scores: {
              innovation: Math.min(10, Math.max(1, Math.round(base + rnd() * 2))),
              market_fit: Math.min(10, Math.max(1, Math.round(base + rnd() * 2))),
              usability: Math.min(10, Math.max(1, Math.round(base + rnd() * 2))),
              execution: Math.min(10, Math.max(1, Math.round(base + rnd() * 2))),
              storytelling: Math.min(10, Math.max(1, Math.round(base + rnd() * 2))),
            },
          });
          if (r.status < 300) scored++;
        }
      }
      console.log(`  ${scored} rubric scores recorded across judges`);
    }

    // --- a judge injects a universal event ---
    const power = await req(judges[tick % 3], 'POST', tick % 2 ? '/api/events/power' : '/api/events/global',
      tick % 2 ? undefined : { shockId: pick(['tech_boom', 'viral_trend', 'investor_frenzy']) });
    if (power.status < 300) console.log(`  judge event: ${power.data.emoji} ${power.data.name} — every team`);
    else console.log(`  judge event skipped (${power.code})`);

    // --- some teams self-deploy, the rest auto-deploy at the tick ---
    let selfDeployed = 0;
    for (const t of teams) {
      if (t.cut || t.archetype === 'ghost') continue;
      if (rnd() < 0.5) {
        const r = await req(t.s, 'POST', `/api/teams/${t.id}/deploy`);
        if (r.status < 300) { selfDeployed++; t.deployed++; stats.deployed++; }
      }
    }
    console.log(`  ${selfDeployed} teams clicked Deploy themselves`);

    const tickRes = await req(admin, 'POST', '/api/engine/tick');
    console.log(`  \x1b[1mENGINE TICK ${tick}\x1b[0m → ${tickRes.data?.teamsUpdated} teams simulated (rest already self-deployed)`);

    /* ---- halftime, after tick 2 ---- */
    if (tick === 2) {
      head('3.  HALFTIME SHOCK + CUT');
      const preview = (await req(admin, 'GET', '/api/game/halftime-cut/preview')).data;
      console.log(`  cut rule: at least ${preview.minDocs} document(s) before halftime (points bar ${preview.minPoints}, ceiling ${preview.ceiling})`);
      console.log(`  preview → ${preview.safe.length} safe, ${preview.cut.length} to cut, ${preview.atRisk.length} at risk`);

      const shock = await req(admin, 'POST', '/api/game/halftime-shock', { shockId: 'recession' });
      console.log(`  \x1b[1m⚡ ${shock.data.name}\x1b[0m fired at every team`);
      const cut = shock.data.cut;
      console.log(`  \x1b[31mDISQUALIFIED: ${cut.cut.length}\x1b[0m — ${cut.cut.slice(0, 5).map(c => c.teamName).join(', ')}${cut.cut.length > 5 ? ` +${cut.cut.length - 5} more` : ''}`);
      for (const c of cut.cut) { const t = teams.find(x => String(x.id) === String(c.teamId)); if (t) t.cut = true; }

      // locked out?
      const victim = teams.find(t => t.cut);
      if (victim) {
        const blocked = await req(victim.s, 'POST', `/api/teams/${victim.id}/strategy`,
          { productPrice: 1000, marketingSpend: 0, targetSegment: 'mass', docUrl: DOC('x') });
        console.log(`  disqualified team submitting → ${blocked.code}`);
      }

      head('4.  PIVOT WINDOW');
      let pivots = 0;
      for (const t of teams) {
        if (t.cut || t.archetype === 'ghost') continue;
        const r = await req(t.s, 'POST', `/api/teams/${t.id}/docs/pivot_rationale`, { docUrl: DOC(`pivot_${t.id}`) });
        if (r.status < 300) pivots++;
      }
      console.log(`  ${pivots} pivot rationales submitted (25 pts each — the biggest single score)`);
      let pivotRated = 0;
      for (let j = 0; j < judges.length; j++) {
        const queue = (await req(judges[j], 'GET', '/api/docs/queue')).data || [];
        for (const item of queue.filter(q => q.docType === 'pivot_rationale')) {
          const d = await req(judges[j], 'POST', `/api/docs/${item.id}/decide`,
            { decision: 'rated', points: Math.round(25 * (0.3 + rnd() * 0.65)) });
          if (d.status < 300) pivotRated++;
        }
      }
      console.log(`  ${pivotRated} pivot ratings recorded`);
      await req(admin, 'POST', '/api/game/round/advance');
      console.log('  advanced to round 2');
    }
  }

  /* ---- 5. Results ---- */
  head('5.  FINAL RESULTS');
  await req(admin, 'POST', '/api/results/freeze');
  const results = (await req(admin, 'GET', '/api/results')).data;
  console.log(`  ${results.formula}`);
  console.log(`  weights: market ${results.weights.market}% / documents ${results.weights.docs}%   status: ${results.frozenAt ? 'FROZEN' : 'open'}\n`);

  const top = results.results.slice(0, 10);
  const maxFinal = Math.max(...results.results.map(r => r.finalScore), 1);
  console.log('   #  TEAM            MONEY        REVENUE   DOCS  ★     PTS   MKT    FINAL');
  for (const r of top) {
    console.log(
      `  ${String(r.rank).padStart(2)}  ${r.teamName.slice(0, 14).padEnd(15)}` +
      `${inr(r.moneyDelta).padStart(11)}  ${('₹' + Math.round(r.totalRevenue / 1000) + 'K').padStart(8)}  ` +
      `${(r.submissions + '/' + r.submissionsPossible).padEnd(5)} ` +
      `${(r.qualityScore == null ? '—' : r.qualityScore.toFixed(1)).padStart(4)}  ` +
      `${String(r.docPoints).padStart(4)}  ${String(r.marketScore).padStart(6)}  ` +
      `\x1b[1m${String(r.finalScore).padStart(6)}\x1b[0m  ${bar(r.finalScore, maxFinal, 14)}`
    );
  }
  const dq = results.results.filter(r => r.isDisqualified);
  console.log(`\n  ...${results.results.length - top.length} more · ${dq.length} disqualified (ranked last)`);

  const w = results.results[0];
  console.log(`\n  \x1b[1m🏆 WINNER: ${w.teamName} (${w.startupName}, ${w.category})\x1b[0m`);
  console.log(`     final ${w.finalScore}  =  market ${w.marketScore} × ${results.weights.market}%  +  documents ${w.docScore} × ${results.weights.docs}%`);
  console.log(`     money ${inr(w.moneyDelta)} · revenue ₹${Math.round(w.totalRevenue).toLocaleString('en-IN')} · ${w.docPoints}/${w.docCeiling} doc pts · judge ★${w.qualityScore ?? '—'}`);

  /* ---- 6. Evidence from the log ---- */
  head('6.  AUDIT TRAIL');
  const log = (await req(admin, 'GET', '/api/event-log?limit=500')).data || [];
  const byKind = log.reduce((a, r) => ({ ...a, [r.kind]: (a[r.kind] || 0) + 1 }), {});
  console.log(`  ${log.length} events recorded (most recent 500)\n`);
  for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(24)} ${String(v).padStart(4)}  ${bar(v, Math.max(...Object.values(byKind)), 24)}`);
  }
  console.log('\n  sample entries:');
  for (const kind of ['shock.halftime', 'team.disqualified', 'event.power', 'tick.complete', 'doc.rejected']) {
    const e = log.find(r => r.kind === kind);
    if (e) console.log(`    \x1b[2m${kind.padEnd(20)}\x1b[0m ${e.summary.slice(0, 90)}`);
  }

  head('SUMMARY');
  console.log(`  teams ${teams.length} · ticks 4 · docs submitted ${stats.submitted} · ratings ${stats.rated}`);
  console.log(`  pricing approved ${stats.approved} · rejected ${stats.rejected} · self-deploys ${stats.deployed}`);
  console.log(`  disqualified ${dq.length} · events logged ${log.length}`);
  console.log(`  completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error('Simulation failed:', e); process.exit(1); });
