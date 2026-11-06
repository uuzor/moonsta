-- 005: reaction events. Deterministic triggers (worker, scheduler jobs) enqueue;
-- the agent drains them into notify_first / act_then_notify chat turns.
CREATE TABLE IF NOT EXISTS reaction_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  wallet_id UUID REFERENCES wallets(id),
  kind TEXT NOT NULL,            -- rule_fired | proposal_expired
  notify_policy TEXT NOT NULL,   -- notify_first | act_then_notify
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sending | sent | failed
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS reaction_events_claim_idx ON reaction_events (status, created_at);
