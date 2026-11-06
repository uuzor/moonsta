import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '@sentinel/config';
import {
  closePool,
  dailyTokensUsed,
  ensureUserByTelegram,
  recentMessages,
  setBudget,
} from '@sentinel/db';
import { MemoryCounter, MemoryLock, TurnJob } from '@sentinel/queue';
import { TurnRunner, processTurn } from './pipeline';
import { TurnMessage } from './run';

loadEnv(process.cwd());

function stubTurn(seen: TurnMessage[][], text = 'stub reply'): TurnRunner {
  return async (_ctx, messages) => {
    seen.push(messages);
    return { text, modelId: 'stub', failedOver: false, inputTokens: 10, outputTokens: 5, toolNames: [] };
  };
}

// Live integration tests: run only when DATABASE_URL is set.
const live = process.env.DATABASE_URL ? it : it.skip;

describe('turn pipeline', () => {
  live('happy path records history and usage, then replies', async () => {
    const tag = `pipe-${Date.now()}`;
    const seen: TurnMessage[][] = [];
    const sent: string[] = [];
    const out = await processTurn(
      { lock: new MemoryLock(), counter: new MemoryCounter(), runTurnFn: stubTurn(seen) },
      { telegramId: tag, text: 'hello', enqueuedAt: new Date().toISOString() },
      async (t) => {
        sent.push(t);
      },
    );
    assert.deepEqual(out, { ok: true });
    assert.deepEqual(sent, ['stub reply']);
    const user = await ensureUserByTelegram(tag);
    const history = await recentMessages(user.id, 10);
    assert.deepEqual(
      history.map((h) => [h.role, h.content]),
      [
        ['user', 'hello'],
        ['assistant', 'stub reply'],
      ],
    );
    assert.equal(await dailyTokensUsed(user.id), 15);
    await closePool();
  });

  live('second turn sees first-turn history', async () => {
    const tag = `pipe-${Date.now()}`;
    const seen: TurnMessage[][] = [];
    const deps = { lock: new MemoryLock(), counter: new MemoryCounter(), runTurnFn: stubTurn(seen) };
    const noop = async () => {};
    await processTurn(deps, { telegramId: tag, text: 'one', enqueuedAt: '' }, noop);
    await processTurn(deps, { telegramId: tag, text: 'two', enqueuedAt: '' }, noop);
    assert.equal(seen.length, 2);
    assert.deepEqual(
      seen[1].map((m) => m.content),
      ['one', 'stub reply', 'two'],
    );
    await closePool();
  });

  live('busy lock replies without running the turn', async () => {
    const tag = `pipe-${Date.now()}`;
    const lock = new MemoryLock();
    const user = await ensureUserByTelegram(tag);
    const held = await lock.acquire(`turn:${user.id}`, 60_000);
    assert.ok(held);
    let ran = false;
    const sent: string[] = [];
    const out = await processTurn(
      {
        lock,
        counter: new MemoryCounter(),
        runTurnFn: (async () => {
          ran = true;
          throw new Error('must not run');
        }) as never,
      },
      { telegramId: tag, text: 'hello', enqueuedAt: '' } as TurnJob,
      async (t) => {
        sent.push(t);
      },
    );
    assert.deepEqual(out, { ok: false, error: 'busy' });
    assert.equal(ran, false);
    assert.match(sent[0], /still working/);
    await held!();
    await closePool();
  });

  live('exhausted budget and rate limit deny politely', async () => {
    const tag = `pipe-${Date.now()}`;
    const user = await ensureUserByTelegram(tag);
    await setBudget(user.id, { dailyTokenCap: 0 });
    const sent: string[] = [];
    const out = await processTurn(
      { lock: new MemoryLock(), counter: new MemoryCounter(), runTurnFn: stubTurn([]) },
      { telegramId: tag, text: 'hello', enqueuedAt: '' },
      async (t) => {
        sent.push(t);
      },
    );
    assert.deepEqual(out, { ok: false, error: 'budget_exhausted' });
    assert.match(sent[0], /daily usage limit/);

    const tag2 = `pipe-${Date.now()}-rl`;
    const user2 = await ensureUserByTelegram(tag2);
    await setBudget(user2.id, { turnsPerMinute: 1 });
    const deps = { lock: new MemoryLock(), counter: new MemoryCounter(), runTurnFn: stubTurn([]) };
    const noop = async () => {};
    assert.deepEqual(
      await processTurn(deps, { telegramId: tag2, text: 'a', enqueuedAt: '' }, noop),
      { ok: true },
    );
    const limited = await processTurn(
      deps,
      { telegramId: tag2, text: 'b', enqueuedAt: '' },
      async (t) => {
        sent.push(t);
      },
    );
    assert.deepEqual(limited, { ok: false, error: 'rate_limited' });
    await closePool();
  });
});
