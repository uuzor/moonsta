import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '@sentinel/config';
import {
  appendMessage,
  closePool,
  dailyTokensUsed,
  ensureUserByTelegram,
  getBudget,
  recentMessages,
  recordUsage,
} from './index';

loadEnv(process.cwd());

// Live integration tests: run only when DATABASE_URL is set.
const live = process.env.DATABASE_URL ? it : it.skip;

describe('conversation store', () => {
  live('messages append and read back chronological with limit', async () => {
    const user = await ensureUserByTelegram(`conv-${Date.now()}`);
    await appendMessage({ userId: user.id, role: 'user', content: 'a' });
    await appendMessage({ userId: user.id, role: 'assistant', content: 'b', toolNames: ['t'] });
    await appendMessage({ userId: user.id, role: 'user', content: 'c' });
    const all = await recentMessages(user.id, 10);
    assert.deepEqual(
      all.map((m) => [m.role, m.content]),
      [
        ['user', 'a'],
        ['assistant', 'b'],
        ['user', 'c'],
      ],
    );
    assert.deepEqual(all[1].tool_names, ['t']);
    const last2 = await recentMessages(user.id, 2);
    assert.deepEqual(
      last2.map((m) => m.content),
      ['b', 'c'],
    );
    await closePool();
  });

  live('budgets default and usage sums rolling 24h', async () => {
    const user = await ensureUserByTelegram(`conv-${Date.now()}`);
    const budget = await getBudget(user.id);
    assert.equal(budget.daily_token_cap, 1000000);
    assert.equal(await dailyTokensUsed(user.id), 0);
    await recordUsage({ userId: user.id, model: 'm', tokensIn: 30, tokensOut: 12 });
    assert.equal(await dailyTokensUsed(user.id), 42);
    await closePool();
  });
});
