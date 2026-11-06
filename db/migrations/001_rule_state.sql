-- 001: evaluator state on rules (high-water marks, baselines).
ALTER TABLE rules ADD COLUMN IF NOT EXISTS state JSONB NOT NULL DEFAULT '{}';
