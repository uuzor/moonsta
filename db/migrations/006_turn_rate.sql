-- 006: raise default turn rate for deeper agent conversations.
ALTER TABLE llm_budgets ALTER COLUMN turns_per_minute SET DEFAULT 20;
