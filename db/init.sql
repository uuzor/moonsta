-- Moonsta schema v1: users, wallets, rules, positions, triggers, audit, snapshots.
-- Rules reference assets by mint (spot) or market id (perp); params/action are
-- validated against the JSON schema in packages/rules before insert.

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain TEXT NOT NULL DEFAULT 'solana',
  address TEXT NOT NULL,
  label TEXT,
  is_agent_wallet BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, chain, address)
);

CREATE TABLE IF NOT EXISTS rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,          -- price_drop | trailing_stop | liq_distance
  asset TEXT NOT NULL,         -- mint address or market id, e.g. drift:SOL-PERP
  params JSONB NOT NULL,       -- {threshold_pct, ...} per kind
  action JSONB NOT NULL,       -- {type: alert|swap, max_size_pct, ...}
  state JSONB NOT NULL DEFAULT '{}',  -- evaluator: {baseline, high, ...}
  status TEXT NOT NULL DEFAULT 'active',  -- active | paused | expired
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rules_wallet_status_idx ON rules (wallet_id, status);

CREATE TABLE IF NOT EXISTS positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  venue TEXT NOT NULL,         -- jupiter | drift | ...
  market TEXT NOT NULL,
  side TEXT,
  size NUMERIC,
  entry_price NUMERIC,
  meta JSONB,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS positions_wallet_open_idx ON positions (wallet_id) WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'fired',  -- fired | executed | failed | skipped
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID REFERENCES wallets(id) ON DELETE SET NULL,
  actor TEXT NOT NULL,         -- user | agent | system
  action TEXT NOT NULL,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_wallet_time_idx ON audit_log (wallet_id, created_at DESC);

CREATE TABLE IF NOT EXISTS snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  total_usd NUMERIC,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS snapshots_wallet_time_idx ON snapshots (wallet_id, created_at DESC);

CREATE TABLE IF NOT EXISTS policies (
  wallet_id UUID PRIMARY KEY REFERENCES wallets(id) ON DELETE CASCADE,
  daily_cap_usd NUMERIC NOT NULL DEFAULT 500,
  per_tx_cap_usd NUMERIC NOT NULL DEFAULT 100,
  paused BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS withdrawal_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  active_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wallet_id, address)
);

CREATE TABLE IF NOT EXISTS proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS proposals_wallet_status_idx ON proposals (wallet_id, status);

CREATE TABLE IF NOT EXISTS spend_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  usd_amount NUMERIC NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS spend_wallet_time_idx ON spend_ledger (wallet_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_names TEXT[] NOT NULL DEFAULT '{}',
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_user_time_idx ON chat_messages (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS llm_budgets (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  daily_token_cap INTEGER NOT NULL DEFAULT 1000000,
  turns_per_minute INTEGER NOT NULL DEFAULT 20, -- keep in sync with migrations/006
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS llm_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_user_time_idx ON llm_usage (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS job_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS job_runs_name_time_idx ON job_runs (job_name, started_at DESC);

CREATE TABLE IF NOT EXISTS reaction_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  wallet_id UUID REFERENCES wallets(id),
  kind TEXT NOT NULL,
  notify_policy TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS reaction_events_claim_idx ON reaction_events (status, created_at);

CREATE TABLE IF NOT EXISTS scheduled_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  wallet_id UUID REFERENCES wallets(id),
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  params JSONB NOT NULL DEFAULT '{}',
  run_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS scheduled_actions_due_idx ON scheduled_actions (status, run_at);
CREATE INDEX IF NOT EXISTS scheduled_actions_user_idx ON scheduled_actions (user_id, created_at DESC);
