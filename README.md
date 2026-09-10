# Startup Survivor

6 hour event. teams pick a track, build a startup idea, submit docs, run a market
simulation, get hit by a shock at halftime, pivot, run again. judges grade
everything. highest final score wins.

this file is the only doc. it covers what was broken, what got built, and how it
all actually works.

---

## running it

```bash
npm install && npm install --prefix client
npm run build:client
npm start
```

open http://localhost:3000

you need postgres running and a `.env`:

```
PORT=3000
DATABASE_URL=postgres://you@localhost:5432/startup_survivor
JWT_SECRET=long-random-string
ADMIN_PASSWORD_HASH=<bcrypt hash>

JUDGE_1_NAME=Judge One
JUDGE_1_CODE=JUDGE1
JUDGE_2_NAME=Judge Two
JUDGE_2_CODE=JUDGE2
JUDGE_3_NAME=Judge Three
JUDGE_3_CODE=JUDGE3
```

judges are defined **entirely in env**. want a 7th judge? add
`JUDGE_7_NAME` + `JUDGE_7_CODE`, restart, done. no signup screen, no admin form.
however many pairs exist, that many judges exist. the schema syncs them on every
boot and nobody already logged in gets disturbed.

get the admin hash with:

```bash
node -e "require('bcrypt').hash('your-passphrase',12).then(console.log)"
```

**the links:**

| who | url | login with |
|---|---|---|
| teams | `/` | register / team password |
| judges | `/#/judge` | their code (JUDGE1 etc) |
| game master | `/#/gm` | the admin passphrase |
| logs | `/#/logs` | staff only |

judge and gm are **not linked from the landing page**. participants only see
register + team login. staff bookmark their own url.

**testing:**

```bash
npm test          # syntax check
npm run test:e2e  # 192 permission + function checks
npm run simulate  # full 40-team event, start to finish, ~10s
```

---

# part 1 — what was fucked

i swept the old code before touching anything. it wasn't "needs polish", it was
broken at the foundation.

### 1. the game was already solved

every single lever had one correct answer. there was no strategy at all.

price: `revenue ∝ P^0.4`. that exponent is below 1, which means **revenue goes up
forever as you raise price**. i swept it:

| price | units | revenue |
|---|---|---|
| ₹199 | 6,434 | ₹1.28M |
| ₹999 | 2,444 | ₹2.44M |
| ₹9,999 | 613 | ₹6.13M |
| ₹100,000 | 154 | **₹15.4M** |

marketing: ₹30k of spend turned ₹2.98M into ₹6.13M. a **100× return** with no
diminishing point anywhere in the allowed range. never a reason to spend less
than max.

segments: mass 1.00, premium 0.91, niche 0.90. mass wins every time. three
options, one right answer, always.

so the whole game was: **max price, max marketing, mass, click deploy as many
times as allowed.** that's it. whoever noticed won. that's not a strategy game,
that's a did-you-notice contest.

### 2. the slider capped at 9,999 but the api accepted 100,000

open devtools, POST directly, get **2.5× everyone else's revenue**. free win for
anyone who thought to try it.

### 3. it wasn't a simulation, it was a clicking contest

`POST /deploy` advanced *that one team's* tick. leaderboard sorted on
accumulated revenue. a team that clicked 20 times beat an identical team that
clicked 3 times by ~7×. there was no shared clock at all — `global_tick` existed
in the schema and **was never incremented anywhere in the codebase**.

### 4. shocks were dodgeable by doing nothing

shocks were wall-clock windows and only applied at the moment *you* pressed
deploy. see "recession, 4 min"? wait it out, take zero damage. the teams paying
attention got punished, the idle ones went free. exactly backwards.

### 5. unseeded `Math.random()` every tick

identical strategies gave different results. nothing reproducible. you could not
defend a contested placing to a team that complained.

### 6. judge timing decided the winner

quality applied forward-only. rated 9/10 at minute 5 = boost on every remaining
tick. same 9/10 at minute 40 = almost nothing. whichever team the judges walked
to first won.

### 7. there was one judge account

one shared passphrase. `users.role` only allowed team or judge. every judge was
literally the same login, so scores overwrote each other, and the person running
the game was the same account as the person scoring it.

### 8. judges scored products they couldn't see

the admin panel showed revenue, budget, and a "Rate" button. it never showed the
team's canvas, pitch, or anything else. judges were rating *innovation* off a
table of numbers.

### 9. nothing in the code matched the actual event

no tracks. no rounds. no halfway point. **no pivot entity at all** — no
submission, no rubric, no score, no storage. steps 1, 4, 5 and 6 of the format
simply did not exist.

### 10. it was slow because of n+1 queries

every `/api/game/state` looped one query per team, then another per team for
quality. ~63 round trips. every client polled that every 1.5s. at 40 teams
that's **~5,400 queries/sec** against one pool. that's why it felt dead.

### 11. ~4,500 lines of dead legacy html/css/js still shipped

deleted now.

---

# part 2 — bugs found while building

these were found by actually running the thing, not by reading it. logging them
because they'd all have hit you live.

**the venue wifi would have broken registration.** auth was rate limited to 10
req/min *per ip*. at a venue all 40 teams are behind one NAT so they share one
public ip — **team #11 onwards gets locked out**. found it in the 40-team
rehearsal, first thing it did. now 300/min, tunable via `AUTH_RATE_LIMIT`.

**round 2 silently accepted zero strategies.** `doc_submissions` was unique on
`(team, doc_type, tick)`. round 2 restarts tick numbering at 1, so every round-2
pricing doc collided with its round-1 row and got blocked by *that* row's
10-minute cooldown. ticks 3 and 4 ran entirely on carried-over strategies and
nothing complained. fixed by putting `round` in the key.

**multiple judges overwrote each other.** `judge_scores` was unique on
`(team, attribute)` with no `judge_id`. judge 3's score silently replaced judge
1's. same for doc ratings. "all judges score then average" was flat out
impossible. now per-judge rows + a `doc_ratings` table.

**pg returns BIGINT as a string.** so `Number(teamId) !== row.team_id` was always
true and teams couldn't read their own submissions. worse, two of my "access
blocked" tests were passing for the wrong reason.

**the jwt didn't carry the judge id.** `req.user.id` was undefined everywhere, so
claim ownership silently broke and every approve failed.

**claims blocked multi-judge rating.** claiming is exclusivity for a *decision*.
ratings are independent. the first judge to rate was locking everyone else out.

**express route order.** `/api/game/:action` was registered before
`/api/game/halftime-shock`, so the wildcard swallowed it and halftime returned
"unknown game action".

**zero marketing = exactly zero market share.** `sqrt(0) = 0` meant a team that
skipped marketing for one tick got 0% of the pool no matter how good their
price. that's a wall, not a disadvantage. added an organic-reach floor.

**docs were accepted after the game ended.** now `GAME_ENDED`.

**standings leaked.** `/api/results` returned every rival's money, scores and
rank to any logged-in team, live, mid-event. now staff-only until admin
releases them.

---

# part 3 — how the game actually works now

## the schedule

45 min per tick, 2 ticks per round, 2 rounds = 4 ticks. halftime is after tick 2.

```
tick 1        tick 2        ⚡ HALFTIME      tick 3        tick 4
idea brief    pitch deck    + the cut       financial     final deck
(15 pts)      (20 pts)      + pivot window  model (10)    (20 pts)
                            pivot (25 pts)  gtm (10)
```

each 45-min tick splits: **27 min submit → 8 min judges review → 10 min buffer →
tick fires**. the buffer is a fix-it gap. submissions freeze, judges keep
working, and if something's wrong there's room to fix it before the market runs.

every countdown is on **server time**. a team's own clock is irrelevant.

## the tick loop

1. team submits a **request** — price, marketing spend, segment, plus a pricing
   justification doc with citations
2. a judge **approves or rejects** it
3. **deploy** unlocks. the button is dead until approval lands
4. the market runs for everyone at once

clicking fast does nothing. approval is the gate, not reflexes.

### what happens if they don't submit

| what happened | what the tick does |
|---|---|
| never submitted | carries over their last approved strategy |
| submitted, judge never got to it | carries over, logged as `carried_over` |
| rejected, didn't resubmit | carries over |
| **approved but never clicked deploy** | **auto-deploys** — approval is the gate, not reaction time |
| already self-deployed | skipped, a tick can never double-apply |

nobody loses a tick for waiting, for a slow laptop, or for a slow judge queue.

### pricing is never blocked by the clock

miss the deadline and you can **still submit**. it gets flagged **late** and the
judge decides:

- approve normally
- **approve with a penalty** (−10/25/50%, scales down that tick's units, revenue
  and profit)
- **disqualify that tick**

missing a deadline is a judgement call, not an automatic zero.

## the economics

every lever now has a real optimum that a shock can move.

**price** — real elasticity per segment. mass 1.8, premium 1.15, niche 0.85.
elasticity above 1 means **revenue falls if you overprice**. combined with unit
cost there's an actual profit-maximising price, and it's different per segment,
per track, and per shock state.

**marketing** — builds an **awareness stock that decays** at 0.75/tick with a
saturating response. spend once and coast doesn't work. spend nothing doesn't
work. there's an organic floor so zero spend still gets you something.

**real unit economics** — COGS per track, gross margin, CAC, contribution.
scored on **profit, not revenue**. revenue-max is always gameable.

**capacity** — you can only serve so many units. demand above that becomes churn
and a reputation hit, not free money.

**retention** — customers compound tick over tick. churn drops with judge
quality. so a well-judged product wins slowly and durably instead of getting an
arbitrary +25% knob.

**shared market pool** — teams on the same track compete for the same customers,
split by attractiveness. undercutting a rival actually takes their customers.

**debt, not a floor** — cash goes negative and compounds at 8%/tick. past 2× your
starting budget you're **insolvent**: marketing capped at zero, standing −40%
attractiveness that decays slowly, forced fire-sale as the only lever. you're
never eliminated, you always get another tick — but you can genuinely crater.

**seeded rng** — `hash(gameId, teamId, tick)`, ±5%. same inputs, same output,
every time. reproducible and defensible.

## documents

one doc due before each tick. judges rate them **as they come in**, so points
build up through the event instead of landing all at the end.

| doc | due | worth | how it's judged |
|---|---|---|---|
| idea & problem statement | tick 1 | 15 | rated |
| pitch deck | tick 2 | 20 | rated |
| pricing justification | every tick | — | **approved / rejected only** |
| pivot rationale | pivot window | 25 | rated |
| financial model | tick 3 | 10 | rated |
| go-to-market plan | tick 3 | 10 | rated |
| final pitch deck | tick 4 | 20 | rated |

**only pricing gets approved.** everything else gets **rated for points**. the
server enforces this both ways — you can't approve a deck, you can't rate a
pricing doc.

the six scored docs total exactly **100 points**.

**doc ratings move the market.** points earned / points available becomes a ±30%
multiplier on your market pull. a strong idea and a well-argued price literally
make the market kinder to you. that's the whole "judges affect the outcome" ask.

### how submissions work

everything is a **google docs link**. every doc type shows its **required format**
inline in the submit form — teams click "required format" and see exactly what
sections to write.

sharing must be **anyone with the link → viewer**, and the server checks that on
submit, so a wrongly-shared doc fails immediately with a fixable error instead
of a judge discovering it later.

**on submit the server fetches a frozen pdf snapshot.** that's the audited record.
a team editing the live doc after approval **cannot** change what was judged.
without this every approval would be provisional forever.

rules: **10 min cooldown** after every submit, max **2 revisions** per tick. a
permissions-only fix doesn't burn a revision.

## halftime

admin fires the shock. three things happen at once:

1. it hits **every team equally**
2. **pre-shock docs lock permanently** — you can't rewrite your pitch around a
   shock you've already seen
3. **the cut runs** — teams that submitted **zero** documents before halftime are
   disqualified

on the cut: originally the ask was 30 points, but only **35 points exist** before
halftime (idea 15 + deck 20), so 30 would have been 86% and wiped the field. it's
now a participation gate — **submit at least 1 doc or you're out**. the points bar
still exists as a separate optional knob, default off.

two safety rails, because this ends someone's event:

- a team is **never cut for docs the judges haven't rated yet**. those show up as
  `atRisk` for you to chase instead
- **preview the cut before firing it**, and admin can reinstate anyone

## the pivot

opens the instant the shock fires. runs **45 min**. then closes hard. doesn't
exist before the shock, doesn't exist after the window.

worth **25 points — the biggest single score in the event.** the template asks
teams to reconcile the original idea against what actually happened. a deck that
pretends the shock never hit scores badly.

## judges

**allocation** — under 20 teams every judge sees every team and scores get
averaged. at 20+ teams they get **split evenly and deterministically** (40 teams
/ 3 judges = 14/13/13). the mode locks at the first tick so it can never flip
mid-event. late-registering teams auto-assign to whoever has fewest.

**normalization** — when judging is partitioned a team is seen by one judge, so
drawing a harsh judge would be a penalty they didn't earn. scores get **z-score
normalized per judge** before combining. a judge who marks everything 6–8 and one
who ranges 2–10 end up contributing comparably.

**claiming** — opening a submission claims it so two judges can't collide on the
same decision. auto-expires after 3 min idle. *ratings* don't need a claim,
because several judges rating the same doc is the expected case.

**powers** — judges can roll a **random power for everyone**. the server picks
which power lands and it hits the whole field. the judge chooses neither the
power nor the recipients. that's deliberate — a judge can inject drama but
**structurally cannot favour anyone**. one event per tick. there is no targeting
parameter on that endpoint at all.

judges can also fire universal events and clear active ones. they **cannot**
start/pause/reset the game, fire targeted shocks, fire the halftime shock, run
ticks, or change scoring weights.

**what they see when reviewing** — before the document, the modal shows where that
team actually stands: money made/lost, revenue, points so far, judge score, plus
an insolvency warning. no more rating a pricing doc without knowing the team is
bleeding money.

judges also get the **live leaderboard**.

## the final score

two components, each already 0–100, split 50/50 (tunable, and freezable so they
can't be tuned once standings are known):

**market score** — the mean of your per-tick normalized scores. each tick you're
scored 0–100 on contribution against your track, then averaged. with only 4 ticks
raw rupees would let one lucky tick decide the whole event. this makes all four
weigh the same.

**document score** — judge-awarded points out of 100.

judge rubric scores are deliberately **not** a third component — they already move
the market through the quality multiplier, and counting them twice would be
double-scoring the same opinion.

disqualified teams always rank below everyone still standing, no matter how well
they did.

standings show **money made/lost, revenue, docs submitted, judge ★, doc points,
market score, final** — so nobody has to take the number on faith.

---

# part 4 — proof it works

`npm run simulate` runs the whole event: 40 teams, 3 judges, 4 ticks, halftime
shock, cut, pivot window, final winner. ~10 seconds.

it includes deliberately badly-behaved teams:

| archetype | what they do | what happens |
|---|---|---|
| ghost ×4 | never submit anything | **disqualified** at halftime |
| pricing-only ×4 | pricing but no docs | **disqualified** |
| sloppy ×4 | ₹9,999 + max spend | pricing **rejected**, market score 0.6–21 |
| lean ×4 | zero marketing | survive, decent cash, low market share |

last run's winner:

```
🏆 Team25 (Startup25, FinTech) — final 79.81
   market 97.63 × 50%  +  documents 62 × 50%
   money +₹5,49,972 · revenue ₹9,29,496 · 62/100 doc pts · judge ★5.4
```

the team that made the **most money** in the top ten placed **10th** — high
revenue, weaker per-tick contribution, fewer doc points. money alone doesn't win.

all 8 disqualified teams landed at ranks 33–40. one of them had a market score of
**92** and still ranked 33rd because it never submitted a document.

`npm run test:e2e` runs **192 checks** covering every role against every endpoint.
the important half is what's *blocked*: teams can't reach admin endpoints, can't
reach judge endpoints, can't read another team's anything, can't deploy as
someone else, can't approve their own work, can't submit a price above the ui
cap. judges can't touch game state. everything is checked, not assumed.

---

# part 5 — the log

everything is written to an append-only `event_log` **in the same transaction as
the action**, so the log can never disagree with the data. `/#/logs`, filterable,
with csv export.

a 40-team run produces ~500 events:

```
doc.submit          160    doc.rated            96
score.set            59    doc.approved         56
tick.auto_deploy     44    deploy.run           44
tick.carry_over      16    doc.rejected          8
team.disqualified     8    tick.complete         3
```

real entries look like:

```
HALFTIME SHOCK fired: Recession. Pre-shock document submissions are now locked.
Team08 disqualified at halftime: Submitted 0 of the 1 document(s) required
Judge One granted a random power to every team: 🤝 Trust Surge.
Judge Three rejected pricing_justification for team 12.
Tick 1 carried over team 3's previous strategy (no approved request): 15 units, ₹14985.
```

if a team argues about a placing, it's all there.

---

# part 6 — what's not done

being straight about this rather than letting you find out later.

**late submission for a *previous* tick.** the schema is in
(`for_past_tick`, `backfilled_at`, `late_backfill_penalty_pct`) and the decision
was made — credit it to that team's cumulative totals with a penalty, never
re-run the past tick, because re-running would recompute the shared pool and
change every other team's already-published result. the endpoint and ui aren't
built.

**halftime cut preview in the ui.** the api works
(`GET /api/game/halftime-cut/preview`) but admin has to call it directly instead
of seeing it in the panel before firing.

**scale work for 50+ teams.** the 40-team rehearsal completes in 10s so the
engine is fine, but the polling architecture is still n+1 per snapshot. at ~130
concurrent browsers that's real load. the fix is a cached shared snapshot + SSE
instead of 1.5s polling, and running on one long-lived host rather than
serverless (each serverless instance opens its own pg pool). not needed for 40
teams on one box, needed if you go bigger.

**granular phase machine.** phases are still lobby/active/paused/ended with round
and tick tracked alongside, not a full BUILD → ROUND_1 → SHOCK → PIVOT → ROUND_2
state machine. works fine, just less self-documenting.

---

# part 7 — layout

```
server/
  server.js              all routes
  db/schema.sql          schema, idempotent, runs on every boot
  services/
    market.js            the economics — elasticity, awareness, capacity,
                         retention, shared pool, debt/insolvency
    docs.js              submissions, snapshots, cooldowns, claiming, decisions
    judging.js           allocation, z-score normalization, halftime cut
    judges.js            judges from env vars
    rng.js               seeded randomness
    eventLog.js          the audit trail
    quality.js           the rubric
    shocks.js            shocks + powers catalogs
client/src/pages/
  Landing.jsx            register / team login only
  Dashboard.jsx          participant panel
  Staff.jsx              judge panel — queue, scoring, leaderboard, powers
  StaffLogin.jsx         the /#/judge and /#/gm doors
  Admin.jsx              game master control room
  Logs.jsx               event log + final standings
scripts/
  e2e-test.mjs           192 checks
  simulate-event.mjs     40-team full event
```
