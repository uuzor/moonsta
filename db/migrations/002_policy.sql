-- 002: policy engine tables (caps, pause, withdrawal allowlist, proposals, spend).
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
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | active | revoked
  active_at TIMESTAMPTZ NOT NULL,           -- usable once status=active AND now >= active_at
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wallet_id, address)
);

CREATE TABLE IF NOT EXISTS proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,          -- swap | withdrawal
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | executed | failed | expired
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS proposals_wallet_status_idx ON proposals (wallet_id, status);

CREATE TABLE IF NOT EXISTS spend_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  usd_amount NUMERIC NOT NULL,
  kind TEXT NOT NULL,           -- swap | withdrawal | perp
  ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS spend_wallet_time_idx ON spend_ledger (wallet_id, created_at DESC);
