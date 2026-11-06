import { getPool } from './pool';

export interface ChatMessageRow {
  id: string;
  user_id: string;
  role: 'user' | 'assistant';
  content: string;
  tool_names: string[];
  tokens_in: number;
  tokens_out: number;
  created_at: string;
}

export async function appendMessage(input: {
  userId: string;
  role: 'user' | 'assistant';
  content: string;
  toolNames?: string[];
  tokensIn?: number;
  tokensOut?: number;
}): Promise<ChatMessageRow> {
  const { rows } = await getPool().query<ChatMessageRow>(
    `INSERT INTO chat_messages (user_id, role, content, tool_names, tokens_in, tokens_out)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, role, content, tool_names, tokens_in, tokens_out, created_at`,
    [
      input.userId,
      input.role,
      input.content,
      input.toolNames ?? [],
      input.tokensIn ?? 0,
      input.tokensOut ?? 0,
    ],
  );
  return rows[0];
}

/** Most recent messages, chronological. The worker caps context with limit. */
export async function recentMessages(userId: string, limit: number): Promise<ChatMessageRow[]> {
  const { rows } = await getPool().query<ChatMessageRow>(
    `SELECT id, user_id, role, content, tool_names, tokens_in, tokens_out, created_at
     FROM (SELECT * FROM chat_messages WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2) s
     ORDER BY created_at ASC`,
    [userId, limit],
  );
  return rows;
}

export interface BudgetRow {
  user_id: string;
  daily_token_cap: number;
  turns_per_minute: number;
}

export async function getBudget(userId: string): Promise<BudgetRow> {
  await getPool().query(`INSERT INTO llm_budgets (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [
    userId,
  ]);
  const { rows } = await getPool().query<BudgetRow>(
    `SELECT user_id, daily_token_cap, turns_per_minute FROM llm_budgets WHERE user_id = $1`,
    [userId],
  );
  return rows[0];
}

export async function setBudget(
  userId: string,
  patch: { dailyTokenCap?: number; turnsPerMinute?: number },
): Promise<BudgetRow> {
  await getBudget(userId);
  const { rows } = await getPool().query<BudgetRow>(
    `UPDATE llm_budgets SET
       daily_token_cap = COALESCE($2, daily_token_cap),
       turns_per_minute = COALESCE($3, turns_per_minute),
       updated_at = now()
     WHERE user_id = $1
     RETURNING user_id, daily_token_cap, turns_per_minute`,
    [userId, patch.dailyTokenCap ?? null, patch.turnsPerMinute ?? null],
  );
  return rows[0];
}

export async function recordUsage(input: {
  userId: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO llm_usage (user_id, model, tokens_in, tokens_out) VALUES ($1, $2, $3, $4)`,
    [input.userId, input.model, input.tokensIn, input.tokensOut],
  );
}

/** Rolling 24h token usage (in + out). */
export async function dailyTokensUsed(userId: string): Promise<number> {
  const { rows } = await getPool().query<{ sum: string | null }>(
    `SELECT COALESCE(SUM(tokens_in + tokens_out), 0) AS sum FROM llm_usage
     WHERE user_id = $1 AND created_at > now() - interval '24 hours'`,
    [userId],
  );
  return Number(rows[0].sum ?? 0);
}
