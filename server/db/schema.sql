CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  team_id BIGINT,
  role TEXT NOT NULL CHECK (role IN ('team', 'judge')),
  password_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS teams (
  id BIGSERIAL PRIMARY KEY,
  team_name TEXT NOT NULL UNIQUE,
  startup_name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('FinTech','HealthTech','EdTech','AgriTech','CleanTech','RetailTech')),
  tagline TEXT NOT NULL DEFAULT '',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_team_id_fkey;
ALTER TABLE users ADD CONSTRAINT users_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS team_market_state (
  team_id BIGINT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  tick INTEGER NOT NULL DEFAULT 0,
  budget NUMERIC(14,2) NOT NULL,
  max_budget NUMERIC(14,2) NOT NULL,
  product_price NUMERIC(14,2) NOT NULL,
  marketing_spend NUMERIC(14,2) NOT NULL DEFAULT 0,
  target_segment TEXT NOT NULL DEFAULT 'mass' CHECK (target_segment IN ('mass','premium','niche')),
  demand_index NUMERIC(8,2) NOT NULL,
  base_demand NUMERIC(8,2) NOT NULL,
  conversion_rate NUMERIC(8,2) NOT NULL,
  base_conversion NUMERIC(8,2) NOT NULL,
  units_sold INTEGER NOT NULL DEFAULT 0,
  total_units_sold BIGINT NOT NULL DEFAULT 0,
  total_revenue NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_cost NUMERIC(16,2) NOT NULL DEFAULT 0,
  net_profit NUMERIC(16,2) NOT NULL DEFAULT 0,
  burn_rate NUMERIC(14,2) NOT NULL,
  revenue_history JSONB NOT NULL DEFAULT '[0]'::jsonb,
  units_history JSONB NOT NULL DEFAULT '[0]'::jsonb,
  demand_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  conversion_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_deployed_at TIMESTAMPTZ,
  deploy_count INTEGER NOT NULL DEFAULT 0,
  applied_shocks JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS business_model_canvas (
  team_id BIGINT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  key_partners TEXT NOT NULL DEFAULT '', key_activities TEXT NOT NULL DEFAULT '', key_resources TEXT NOT NULL DEFAULT '',
  value_proposition TEXT NOT NULL DEFAULT '', customer_relationships TEXT NOT NULL DEFAULT '', channels TEXT NOT NULL DEFAULT '',
  customer_segments TEXT NOT NULL DEFAULT '', cost_structure TEXT NOT NULL DEFAULT '', revenue_streams TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_history (
  id BIGSERIAL PRIMARY KEY, team_id BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, tick INTEGER NOT NULL,
  revenue NUMERIC(14,2) NOT NULL, units_sold INTEGER NOT NULL, demand NUMERIC(8,2) NOT NULL, conversion NUMERIC(8,2) NOT NULL,
  budget NUMERIC(14,2) NOT NULL, price NUMERIC(14,2) NOT NULL, marketing_spend NUMERIC(14,2) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(team_id, tick)
);
CREATE INDEX IF NOT EXISTS market_history_team_tick_idx ON market_history(team_id, tick DESC);

CREATE TABLE IF NOT EXISTS game_state (
  id INTEGER PRIMARY KEY CHECK (id = 1), phase TEXT NOT NULL DEFAULT 'lobby' CHECK (phase IN ('lobby','active','paused','ended')),
  global_tick INTEGER NOT NULL DEFAULT 0, game_start_time TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO game_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS shocks (
  id BIGSERIAL PRIMARY KEY, instance_id TEXT NOT NULL UNIQUE, shock_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL, severity TEXT NOT NULL, demand_effect NUMERIC(8,2) NOT NULL DEFAULT 0, budget_effect NUMERIC(8,2) NOT NULL DEFAULT 0,
  conversion_effect NUMERIC(8,2) NOT NULL DEFAULT 0, duration INTEGER NOT NULL, deployed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL, target_team_id BIGINT REFERENCES teams(id) ON DELETE CASCADE, deployed_by BIGINT REFERENCES users(id) ON DELETE SET NULL, emoji TEXT NOT NULL DEFAULT '⚡', resolved BOOLEAN NOT NULL DEFAULT FALSE
);
ALTER TABLE shocks ADD COLUMN IF NOT EXISTS emoji TEXT NOT NULL DEFAULT '⚡';
ALTER TABLE shocks ADD COLUMN IF NOT EXISTS deployed_by BIGINT;
ALTER TABLE shocks DROP CONSTRAINT IF EXISTS shocks_deployed_by_fkey;
ALTER TABLE shocks ADD CONSTRAINT shocks_deployed_by_fkey FOREIGN KEY (deployed_by) REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS shocks_active_idx ON shocks(resolved, expires_at);
CREATE TABLE IF NOT EXISTS shock_history (
  id BIGSERIAL PRIMARY KEY, instance_id TEXT NOT NULL UNIQUE REFERENCES shocks(instance_id) ON DELETE CASCADE, deployed_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ, target_team_id BIGINT REFERENCES teams(id) ON DELETE SET NULL, deployed_by BIGINT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS judge_scores (
  id BIGSERIAL PRIMARY KEY,
  team_id BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  attribute TEXT NOT NULL,
  score SMALLINT NOT NULL CHECK (score BETWEEN 1 AND 10),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(team_id, attribute)
);
CREATE INDEX IF NOT EXISTS judge_scores_team_idx ON judge_scores(team_id);

ALTER TABLE team_market_state ADD COLUMN IF NOT EXISTS quality_score NUMERIC(4,2);
ALTER TABLE team_market_state ADD COLUMN IF NOT EXISTS quality_updated_at TIMESTAMPTZ;
ALTER TABLE market_history ADD COLUMN IF NOT EXISTS quality NUMERIC(4,2);
ALTER TABLE market_history ADD COLUMN IF NOT EXISTS target_segment TEXT;
ALTER TABLE market_history ADD COLUMN IF NOT EXISTS cost NUMERIC(14,2);

/* ============================================================
   PLAN.md / SPEC.md / REDESIGN.md / DOCS_SYSTEM.md migration —
   round engine, judges-from-env, docs & review system, real
   economics (debt/insolvency/awareness/capacity), event log.
   ============================================================ */

-- Judges are defined from env vars (JUDGE_<n>_NAME/JUDGE_<n>_CODE), not an
-- admin "create judge" screen. See server/services/judges.js. `env_slot`
-- ties a row back to its env pair; removing a judge from env deactivates
-- the row rather than deleting it, so history stays attributable.
CREATE TABLE IF NOT EXISTS judges (
  id BIGSERIAL PRIMARY KEY,
  env_slot INT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Slot 0 is reserved for the admin/Game Master, who logs in with a password
-- rather than a code but still needs a real judges row so admin overrides
-- (claiming/deciding a doc) can be attributed like any other reviewer.
-- `syncJudgesFromEnv` never touches slot 0. The code is unusable as a login.
INSERT INTO judges (env_slot, name, code, is_active)
VALUES (0, 'Game Master (admin)', '__ADMIN_RESERVED__', TRUE)
ON CONFLICT (env_slot) DO NOTHING;

-- Append-only audit trail. Every state-changing action writes one row here,
-- in the same transaction as the action (SPEC.md §3). Never updated or
-- deleted; a reset writes a `game.reset` row instead of clearing history.
CREATE TABLE IF NOT EXISTS event_log (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system','admin','judge','team')),
  actor_id TEXT,
  actor_name TEXT,
  team_id BIGINT,
  round INT,
  tick INT,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS event_log_at_idx ON event_log(at DESC);
CREATE INDEX IF NOT EXISTS event_log_team_idx ON event_log(team_id, at DESC);
CREATE INDEX IF NOT EXISTS event_log_kind_idx ON event_log(kind, at DESC);

-- Tracks replace the hardcoded CATEGORIES map (REDESIGN.md §B.2) —
-- admin-editable without a code change. Seeded with the same six sectors
-- the app already ships so nothing breaks on first migration.
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '',
  base_demand NUMERIC(8,2) NOT NULL,
  base_conversion NUMERIC(8,2) NOT NULL,
  base_price NUMERIC(14,2) NOT NULL,
  starting_budget NUMERIC(14,2) NOT NULL,
  cogs_ratio NUMERIC(5,4) NOT NULL DEFAULT 0.35,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);
INSERT INTO tracks (id, label, base_demand, base_conversion, base_price, starting_budget, cogs_ratio) VALUES
  ('FinTech',    'FinTech — Payments, Lending, InsurTech',   70, 8.5, 999,  80000,  0.30),
  ('HealthTech', 'HealthTech — MedTech, Wellness, BioTech',  65, 7.2, 1499, 100000, 0.40),
  ('EdTech',     'EdTech — Learning, Upskilling',            80, 12,  599,  60000,  0.20),
  ('AgriTech',   'AgriTech — Farming, Supply Chain',         55, 6,   799,  70000,  0.45),
  ('CleanTech',  'CleanTech — Renewables, EVs',               60, 5.5, 2499, 120000, 0.55),
  ('RetailTech', 'RetailTech — D2C, Logistics',              75, 10,  449,  55000,  0.35)
ON CONFLICT (id) DO NOTHING;

-- Document types — one engine (this table + doc_submissions + doc_comments)
-- reused for every document in the event, admin-editable (DOCS_SYSTEM.md §4).
-- timeout_behavior decides what happens if nothing is decided by the
-- deadline: pricing docs are safe to fall back on ('carry_over' — repeat the
-- last approved strategy); a one-time pivot has no safe fallback, so it
-- 'auto_approve's instead so judge availability can never stall the round.
CREATE TABLE IF NOT EXISTS doc_types (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  template_url TEXT NOT NULL DEFAULT '',
  cadence TEXT NOT NULL CHECK (cadence IN ('once','per_round','per_tick')),
  gates_tick BOOLEAN NOT NULL DEFAULT FALSE,
  timeout_behavior TEXT NOT NULL DEFAULT 'carry_over' CHECK (timeout_behavior IN ('carry_over','auto_approve')),
  min_citations INT NOT NULL DEFAULT 0,
  round INT,
  due_before_shock BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);
ALTER TABLE doc_types ADD COLUMN IF NOT EXISTS due_before_shock BOOLEAN NOT NULL DEFAULT FALSE;
-- Every link type in the spec (DOCS_SYSTEM.md §2.3), all live in this one
-- table. `due_before_shock` marks the ones that must be in before the
-- halftime shock fires — the pitch deck above all, since judges need it in
-- hand to score the idea before the pivot round changes the story.
ALTER TABLE doc_types ADD COLUMN IF NOT EXISTS is_mandatory BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE doc_types ADD COLUMN IF NOT EXISTS bonus_points NUMERIC(5,2) NOT NULL DEFAULT 0;
-- Opens only once the halftime shock has fired, and only for the pivot
-- window (default 45 min). Before the shock it does not exist; after the
-- window it is closed. The pivot is the centrepiece of the event, so its
-- window is deliberately separate from every other deadline.
ALTER TABLE doc_types ADD COLUMN IF NOT EXISTS opens_after_shock BOOLEAN NOT NULL DEFAULT FALSE;
-- Documents are STAGGERED: one is due before each tick, so judges rate them
-- as they arrive and a team's points build up (and can be adjusted) across
-- the event, instead of everything landing at once at the start.
ALTER TABLE doc_types ADD COLUMN IF NOT EXISTS due_before_global_tick INT;
-- Scored documents earn points (judge awards 0..max_points on review).
-- These do NOT gate a tick — only the pricing justification does that.
ALTER TABLE doc_types ADD COLUMN IF NOT EXISTS max_points NUMERIC(5,2) NOT NULL DEFAULT 0;
-- Only the pricing justification is APPROVED (yes/no) — it gates whether the
-- tick applies a team's new numbers. Every other document is simply RATED
-- for points, which feed the market (see market.js docMultiplier).
ALTER TABLE doc_types ADD COLUMN IF NOT EXISTS requires_approval BOOLEAN NOT NULL DEFAULT FALSE;
-- The structure teams must follow, shown inline in the submit form and
-- mirrored in TEMPLATES.md for copying into Google Docs.
ALTER TABLE doc_types ADD COLUMN IF NOT EXISTS template_outline TEXT NOT NULL DEFAULT '';

-- A deliberately SHORT list. Two mandatory documents, two optional ones that
-- earn bonus points, one per-tick pricing doc, one pivot doc. Everything
-- except pricing/pivot is due before the halftime shock.
INSERT INTO doc_types (id, label, cadence, gates_tick, timeout_behavior, min_citations, round,
                       due_before_shock, is_mandatory, bonus_points, opens_after_shock,
                       due_before_global_tick, max_points, requires_approval, template_outline) VALUES
  -- Before tick 1: the idea itself. Rated, and the rating drives the market.
  ('idea_brief', 'Idea & Problem Statement', 'once', FALSE, 'carry_over', 2, 1, TRUE, TRUE, 0, FALSE, 1, 15, FALSE,
$tpl$1. THE PROBLEM (3-4 sentences)
   Who has it, how often, and what does it cost them today?

2. YOUR SOLUTION (3-4 sentences)
   What you build, and why it beats the current workaround.

3. TARGET CUSTOMER
   Be specific: "small clinics in tier-2 cities", not "everyone in healthcare".

4. WHY NOW
   What changed that makes this possible/urgent this year?

5. CITATIONS (minimum 2)
   - Source 1: <link> — what it proves
   - Source 2: <link> — what it proves$tpl$),

  -- Before tick 2, i.e. immediately before halftime: the pitch deck.
  ('pitch_deck', 'Pitch Deck', 'once', FALSE, 'carry_over', 0, 1, TRUE, TRUE, 0, FALSE, 2, 20, FALSE,
$tpl$Submit a link to your deck (Google Slides or a Doc). Cover, in order:

1. Problem
2. Solution / product
3. Target market and size
4. Business model - how you make money
5. Competition and your edge
6. Traction or validation so far
7. The ask

Keep it under 10 slides. Judges score clarity and evidence, not animation.$tpl$),

  -- Every tick. The ONLY document that is approved/rejected rather than rated.
  ('pricing_justification', 'Pricing Justification', 'per_tick', TRUE, 'carry_over', 2, NULL, FALSE, TRUE, 0, FALSE, NULL, 0, TRUE,
$tpl$1. PROPOSED PRICE: Rs _____   (previous tick: Rs _____)
2. TARGET SEGMENT: Mass / Premium / Niche
3. MARKETING SPEND THIS TICK: Rs _____

4. WHY THIS PRICE? (3-5 sentences)
   Tie it to your cost base and to what your segment will pay.

5. WHAT CHANGED SINCE LAST TICK, AND WHY?

6. CITATIONS (minimum 2 - a comparable product's price, a cost basis,
   a market report, or your own customer conversations)
   - Source 1: <link> — what it shows
   - Source 2: <link> — what it shows

7. ACTIVE SHOCKS THIS TICK AND HOW THIS PRICE RESPONDS TO THEM$tpl$),

  -- The centrepiece. Opens only when the halftime shock fires.
  ('pivot_rationale', 'Pivot Rationale', 'once', FALSE, 'carry_over', 1, 2, FALSE, TRUE, 0, TRUE, NULL, 25, FALSE,
$tpl$1. THE SHOCK — quote it exactly as it was announced.

2. WHAT YOU ARE CHANGING (tick all that apply)
   [ ] Target segment   [ ] Pricing   [ ] Channel
   [ ] Value proposition   [ ] Cost base

3. WHY THIS RESPONDS TO THIS SPECIFIC SHOCK (4-6 sentences)
   Not "we will work harder" - what mechanically changes, and why that
   is the right answer to THIS shock.

4. WHAT YOU ARE DELIBERATELY NOT CHANGING, AND WHY

5. CITATION (minimum 1) supporting the new direction$tpl$),

  -- Round 2 documents.
  ('financial_model', 'Financial Model', 'once', FALSE, 'carry_over', 1, 2, FALSE, FALSE, 0, FALSE, 3, 10, FALSE,
$tpl$UNIT PRICE:        Rs _____
COGS PER UNIT:     Rs _____
GROSS MARGIN:      ____%
FIXED COSTS/TICK:  Rs _____
BREAK-EVEN UNITS:  _____

ASSUMPTIONS - state each one plainly.
CITATION (minimum 1) for your cost basis.$tpl$),

  ('gtm_plan', 'Go-to-Market Plan', 'once', FALSE, 'carry_over', 1, 2, FALSE, FALSE, 0, FALSE, 4, 10, FALSE,
$tpl$1. PRIMARY CHANNEL, and why that one first.
2. HOW YOU ACQUIRE THE FIRST 100 CUSTOMERS.
3. EXPECTED CAC, and how you estimated it (show the arithmetic).
4. CITATION (minimum 1) - a comparable channel's CAC/CPM, or your own
   outreach data.$tpl$)
ON CONFLICT (id) DO UPDATE SET
  label = EXCLUDED.label, cadence = EXCLUDED.cadence, gates_tick = EXCLUDED.gates_tick,
  timeout_behavior = EXCLUDED.timeout_behavior, min_citations = EXCLUDED.min_citations,
  round = EXCLUDED.round, due_before_shock = EXCLUDED.due_before_shock,
  is_mandatory = EXCLUDED.is_mandatory, bonus_points = EXCLUDED.bonus_points,
  opens_after_shock = EXCLUDED.opens_after_shock,
  due_before_global_tick = EXCLUDED.due_before_global_tick,
  max_points = EXCLUDED.max_points, requires_approval = EXCLUDED.requires_approval,
  template_outline = EXCLUDED.template_outline, is_active = TRUE;

-- Trimmed from an earlier, longer list — deactivated rather than deleted so
-- any submission already made against them stays readable.
UPDATE doc_types SET is_active = FALSE
 WHERE id IN ('demo_link', 'compliance_note', 'post_pivot_deck', 'retro');

-- Every submitted document, of any type. Submissions are Google Docs links;
-- `snapshot` is the frozen PDF export fetched server-side on submit — that,
-- not the live link, is the actual reviewed/audited record (DOCS_SYSTEM.md
-- §2.1), so an edit to the live doc after approval cannot change what was
-- judged. `price`/`marketing_spend`/`target_segment` are only populated for
-- pricing_justification submissions — the structured numbers the engine
-- actually applies once the doc is approved (the doc itself is the
-- citation-backed justification for those numbers, not parsed for them).
CREATE TABLE IF NOT EXISTS doc_submissions (
  id BIGSERIAL PRIMARY KEY,
  team_id BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL REFERENCES doc_types(id),
  round INT,
  tick INT,
  version INT NOT NULL DEFAULT 1,
  doc_url TEXT NOT NULL,
  snapshot BYTEA,
  content_hash TEXT,
  price NUMERIC(14,2),
  marketing_spend NUMERIC(14,2),
  target_segment TEXT CHECK (target_segment IN ('mass','premium','niche')),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN
    ('submitted','under_review','approved','rejected','carried_over','auto_approved')),
  claimed_by BIGINT REFERENCES judges(id) ON DELETE SET NULL,
  claimed_at TIMESTAMPTZ,
  reviewed_by BIGINT REFERENCES judges(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  decision_reason TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cooldown_until TIMESTAMPTZ NOT NULL,
  UNIQUE(team_id, doc_type, tick)
);
CREATE INDEX IF NOT EXISTS doc_submissions_queue_idx ON doc_submissions(status, doc_type, submitted_at);
CREATE INDEX IF NOT EXISTS doc_submissions_team_idx ON doc_submissions(team_id, doc_type, tick DESC);

CREATE TABLE IF NOT EXISTS doc_comments (
  id BIGSERIAL PRIMARY KEY,
  submission_id BIGINT NOT NULL REFERENCES doc_submissions(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL CHECK (author_type IN ('judge','team','admin')),
  author_id TEXT,
  author_name TEXT,
  section TEXT,
  tag TEXT CHECK (tag IN ('concern','praise','question','flag') OR tag IS NULL),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS doc_comments_submission_idx ON doc_comments(submission_id, created_at);

-- Round/tick engine state (REDESIGN.md §B.1, DOCS_SYSTEM.md §1). One row,
-- same shape as game_state. tick_minutes/ticks_per_round are admin-editable
-- (Config tab) rather than hardcoded, so the 45-min/2-tick schedule for an
-- 11:00-17:00 day can be retuned for a different event length.
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS round INT NOT NULL DEFAULT 1;
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS tick_in_round INT NOT NULL DEFAULT 0;
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS ticks_per_round INT NOT NULL DEFAULT 2;
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS tick_minutes INT NOT NULL DEFAULT 45;
-- Three deadlines per tick window, not one. Teams submit early, judges get a
-- protected window to review, and the tick fires last:
--   T0 ──submit open──► submission_deadline ──review──► review_deadline ──► tick_deadline
-- Defaults are 60% / 90% / 100% of tick_minutes (for 45 min: 27 / 40 / 45).
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS tick_deadline TIMESTAMPTZ;
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS submission_deadline TIMESTAMPTZ;
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS review_deadline TIMESTAMPTZ;
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS last_tick_at TIMESTAMPTZ;
-- Set when the admin fires the halftime shock. Deck/idea links whose doc
-- type is marked due_before_shock lock at this moment — teams cannot
-- retro-fit their pitch to a shock they have already seen.
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS halftime_shock_at TIMESTAMPTZ;
-- The pivot window: opens the instant the halftime shock fires, runs for
-- pivot_window_minutes, then closes. This is the centrepiece of the event.
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS pivot_window_minutes INT NOT NULL DEFAULT 45;
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS pivot_deadline TIMESTAMPTZ;
-- Judges may fire ONE universal opportunity/problem per tick. Recording the
-- tick it was fired on is what enforces "once per tick", and forcing it to
-- hit every team is what keeps it fair — a judge can never target one team.
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS last_judge_event_tick INT;

-- An approved Pricing Justification unlocks exactly ONE deploy for that
-- team; consuming it here stops a team re-clicking the same approval to
-- run the tick twice.
ALTER TABLE doc_submissions ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;

-- Pricing submissions are NEVER hard-blocked by the clock — a team that
-- misses the window can still submit, but it is flagged late and the judge
-- decides the consequence: approve as normal, approve with a penalty, or
-- disqualify that tick. Missing the deadline is a judgement call, not an
-- automatic zero.
ALTER TABLE doc_submissions ADD COLUMN IF NOT EXISTS is_late BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE doc_submissions ADD COLUMN IF NOT EXISTS penalty_pct NUMERIC(5,2) NOT NULL DEFAULT 0;
-- Points a judge awarded this document on review (0..doc_types.max_points).
ALTER TABLE doc_submissions ADD COLUMN IF NOT EXISTS points NUMERIC(5,2);
ALTER TABLE doc_submissions DROP CONSTRAINT IF EXISTS doc_submissions_status_check;
ALTER TABLE doc_submissions ADD CONSTRAINT doc_submissions_status_check CHECK (status IN
  ('submitted','under_review','approved','rejected','carried_over','auto_approved','disqualified','rated'));

-- The Business Model Canvas is removed from the event entirely — teams
-- submit real documents (Idea Brief, GTM Plan, Financial Model, deck)
-- instead of filling nine text boxes in-app.
DROP TABLE IF EXISTS business_model_canvas;

-- Real economics (SPEC.md §2): awareness is the decaying marketing stock,
-- capacity caps units before overflow becomes churn, debt/is_insolvent
-- replace the old "clamp at zero" floor with a real, compounding loss.
ALTER TABLE team_market_state ADD COLUMN IF NOT EXISTS awareness NUMERIC(10,4) NOT NULL DEFAULT 0;
ALTER TABLE team_market_state ADD COLUMN IF NOT EXISTS capacity NUMERIC(10,2) NOT NULL DEFAULT 500;
ALTER TABLE team_market_state ADD COLUMN IF NOT EXISTS active_customers NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE team_market_state ADD COLUMN IF NOT EXISTS debt NUMERIC(16,2) NOT NULL DEFAULT 0;
ALTER TABLE team_market_state ADD COLUMN IF NOT EXISTS is_insolvent BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE team_market_state ADD COLUMN IF NOT EXISTS reputation_scar NUMERIC(6,4) NOT NULL DEFAULT 0;
ALTER TABLE team_market_state ADD COLUMN IF NOT EXISTS track_id TEXT;
UPDATE team_market_state SET track_id = category WHERE track_id IS NULL;


/* ============================================================
   Multi-judge scoring, judge assignment, buffer window, and
   late-submission-for-a-previous-tick.
   ============================================================ */

-- BUGFIX: judge_scores had UNIQUE(team_id, attribute) and no judge_id, so a
-- second judge scoring the same team silently OVERWROTE the first. That makes
-- "every judge scores everything and we average" impossible. Scores are now
-- per judge; the team's composite is the mean across judges.
ALTER TABLE judge_scores ADD COLUMN IF NOT EXISTS judge_id BIGINT REFERENCES judges(id) ON DELETE CASCADE;
UPDATE judge_scores SET judge_id = (SELECT id FROM judges WHERE env_slot = 0) WHERE judge_id IS NULL;
ALTER TABLE judge_scores DROP CONSTRAINT IF EXISTS judge_scores_team_id_attribute_key;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'judge_scores_judge_team_attr_key') THEN
    ALTER TABLE judge_scores ADD CONSTRAINT judge_scores_judge_team_attr_key UNIQUE (judge_id, team_id, attribute);
  END IF;
END $$;

-- BUGFIX: doc_submissions.points is a single column, so a second judge rating
-- the same document overwrote the first. Ratings now live per judge here, and
-- doc_submissions.points holds the aggregate (mean of judges).
CREATE TABLE IF NOT EXISTS doc_ratings (
  id BIGSERIAL PRIMARY KEY,
  submission_id BIGINT NOT NULL REFERENCES doc_submissions(id) ON DELETE CASCADE,
  judge_id BIGINT NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
  points NUMERIC(5,2) NOT NULL,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(submission_id, judge_id)
);
CREATE INDEX IF NOT EXISTS doc_ratings_submission_idx ON doc_ratings(submission_id);

-- Which judge is responsible for which team. With fewer than
-- JUDGE_PARTITION_THRESHOLD teams every judge sees every team (rows here are
-- ignored); at or above it, teams are split evenly and deterministically so a
-- panel of 3 judges each get an equal, reproducible slice.
CREATE TABLE IF NOT EXISTS judge_assignments (
  judge_id BIGINT NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
  team_id BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (judge_id, team_id)
);
CREATE INDEX IF NOT EXISTS judge_assignments_team_idx ON judge_assignments(team_id);
-- Locked at first tick so the mode can never flip mid-event (19 -> 21 teams).
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS judging_mode TEXT
  CHECK (judging_mode IN ('all','partitioned'));

-- A fix-it gap between submissions closing and the tick firing. Submissions
-- freeze; judges keep reviewing.
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS buffer_minutes INT NOT NULL DEFAULT 10;

-- Late submissions for a tick that has ALREADY run. These are never replayed
-- through the shared pool (that would change every other team's published
-- result); they are credited to the submitting team's cumulative totals only,
-- with a judge-set penalty.
ALTER TABLE doc_submissions ADD COLUMN IF NOT EXISTS for_past_tick BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE doc_submissions ADD COLUMN IF NOT EXISTS backfilled_at TIMESTAMPTZ;
-- Default penalty applied to a late-for-a-previous-tick backfill.
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS late_backfill_penalty_pct NUMERIC(5,2) NOT NULL DEFAULT 25;

/* ============================================================
   Halftime cut: teams below a points threshold are disqualified
   when the halftime shock fires.
   ============================================================ */
ALTER TABLE teams ADD COLUMN IF NOT EXISTS is_disqualified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS disqualified_at TIMESTAMPTZ;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS disqualified_reason TEXT;
-- Minimum document points required to survive halftime. NOTE: only the
-- pre-halftime documents count toward this (Idea Brief + Pitch Deck), so the
-- ceiling is the sum of their max_points — set this relative to that, not to
-- the whole event's total.
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS halftime_min_points NUMERIC(6,2) NOT NULL DEFAULT 30;

-- The halftime cut is primarily a PARTICIPATION gate: a team must have
-- submitted at least this many pre-halftime documents to survive. The points
-- threshold is a separate, optional quality bar (0 = disabled), because only
-- ~35 points exist before halftime and a high bar there would wipe the field.
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS halftime_min_docs INT NOT NULL DEFAULT 1;
ALTER TABLE game_state ALTER COLUMN halftime_min_points SET DEFAULT 0;
UPDATE game_state SET halftime_min_points = 0 WHERE halftime_min_points = 30;

-- A remade pitch deck at the end of the event, reflecting the pivot. Due
-- before the final tick, rated like the others.
INSERT INTO doc_types (id, label, cadence, gates_tick, timeout_behavior, min_citations, round,
                       due_before_shock, is_mandatory, bonus_points, opens_after_shock,
                       due_before_global_tick, max_points, requires_approval, template_outline) VALUES
  ('final_deck', 'Final Pitch Deck (post-pivot)', 'once', FALSE, 'carry_over', 0, 2, FALSE, TRUE, 0, FALSE, 4, 20, FALSE,
$tpl$Remake your deck to reflect where you actually ended up. Cover:

1. The original idea - one slide, honestly stated.
2. THE SHOCK, and what it did to you.
3. YOUR PIVOT - what changed, and the reasoning.
4. What the numbers did across the four ticks (revenue, margin, customers).
5. What you would do with another month.

Judges score how well the story matches what actually happened. A deck that
pretends the shock never hit scores badly.$tpl$)
ON CONFLICT (id) DO UPDATE SET
  label = EXCLUDED.label, due_before_global_tick = EXCLUDED.due_before_global_tick,
  max_points = EXCLUDED.max_points, is_mandatory = EXCLUDED.is_mandatory,
  template_outline = EXCLUDED.template_outline, is_active = TRUE;

-- Go-to-Market moves off tick 4 to make room for the final deck.
UPDATE doc_types SET due_before_global_tick = 3 WHERE id = 'gtm_plan';
UPDATE doc_types SET due_before_global_tick = 3 WHERE id = 'financial_model';

-- Normalised per-tick score (0-100). With only four ticks, raw rupees let a
-- single lucky tick dominate the whole event; scoring each tick relative to
-- the field and averaging makes all four count equally.
ALTER TABLE market_history ADD COLUMN IF NOT EXISTS tick_score NUMERIC(6,2);

-- Final-score weights, admin-tunable and frozen before results are revealed.
-- Market score and document points are each already on a 0-100 scale, so the
-- weights are a straight split.
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS weight_market NUMERIC(5,2) NOT NULL DEFAULT 50;
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS weight_docs   NUMERIC(5,2) NOT NULL DEFAULT 50;
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS results_frozen_at TIMESTAMPTZ;

-- BUGFIX (found in the 40-team rehearsal): doc_submissions was unique on
-- (team_id, doc_type, tick) only. Round 2 restarts tick_in_round at 1, so a
-- round-2 pricing doc collided with the round-1 row for the same tick number
-- and was silently blocked by that row's cooldown — every round-2 strategy
-- submission failed. The round must be part of the identity.
ALTER TABLE doc_submissions DROP CONSTRAINT IF EXISTS doc_submissions_team_id_doc_type_tick_key;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'doc_submissions_team_doctype_round_tick_key') THEN
    ALTER TABLE doc_submissions
      ADD CONSTRAINT doc_submissions_team_doctype_round_tick_key
      UNIQUE (team_id, doc_type, round, tick);
  END IF;
END $$;

-- Grading window: the last N minutes of each tick belong to the judges, and
-- the tick will not fire until everything pending is graded. 25 min sits
-- INSIDE the 45-minute tick (20 submit -> 25 grade -> fire) rather than on top
-- of it; stacking it on top would push a 4-tick event past 6 hours.
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS grading_minutes INT NOT NULL DEFAULT 25;
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS grading_deadline TIMESTAMPTZ;
-- Highest tick whose results teams are allowed to see. Bumped only when the
-- tick has run AND grading was complete.
ALTER TABLE game_state ADD COLUMN IF NOT EXISTS published_through_tick INT NOT NULL DEFAULT 0;
