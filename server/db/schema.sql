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
