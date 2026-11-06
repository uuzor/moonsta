-- 007: user-scheduled actions (reminders, one-shot balance checks, research briefs).
CREATE TABLE IF NOT EXISTS scheduled_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  wallet_id UUID REFERENCES wallets(id),
  kind TEXT NOT NULL,            -- reminder | balance_check | research
  message TEXT NOT NULL,         -- user words: reminder text, check label, research question
  params JSONB NOT NULL DEFAULT '{}', -- balance_check baseline, etc.
  run_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | claimed | done | failed | cancelled
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS scheduled_actions_due_idx ON scheduled_actions (status, run_at);
CREATE INDEX IF NOT EXISTS scheduled_actions_user_idx ON scheduled_actions (user_id, created_at DESC);
