import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '@sentinel/config';
import {
  appendMessage,
  closePool,
  dailyTokensUsed,
  ensureUserByTelegram,
  recentMessages,
  setBudget,
  type ReactionEvent,
} from '@sentinel/db';
import { MemoryLock } from '@sentinel/queue';
import { describeEvent, runReactionTurn } from './react';

loadEnv(process.cwd());

const live = process.env.DATABASE_URL ? it : it.skip;

function event(over: Partial<ReactionEvent> & { user_id: string }): ReactionEvent {
  return {
    id: 'evt-test',
    wallet_id: null,
    kind: 'rule_fired',
    notify_policy: 'notify_first',
    payload: {},
    status: 'sending',
    attempts: 1,
    created_at: new Date().toISOString(),
    sent_at: null,
    ...over,
  };
}

const stubTurn = (text = 'stub notification') => async () => ({
  text,
  modelId: 'stub',
  failedOver: false,
  inputTokens: 10,
  outputTokens: 5,
  toolNames: [] as string[],
});

describe('describeEvent', () => {
  it('renders rule_fired variants and proposal_expired deterministically', () => {
    const swap = describeEvent(
      event({
        user_id: 'u',
        notify_policy: 'act_then_notify',
        payload: { ruleId: 'r1', kind: 'trailing_stop', asset: 'MINT', price: 90, actionTaken: 'swap', amountRaw: '100', outAmount: '95', signature: 'sig1' },
      }),
    );
    assert.match(swap, /trailing_stop on MINT/);
    assert.match(swap, /pre-authorized swap executed/);
    assert.match(swap, /sig1/);

    const denied = describeEvent(
      event({ user_id: 'u', payload: { ruleId: 'r2', kind: 'price_drop', asset: 'M2', price: 1, actionTaken: 'denied', reason: 'over cap' } }),
    );
    assert.match(denied, /BLOCKED by policy/);
    assert.match(denied, /over cap/);

    const expired = describeEvent(
      event({ user_id: 'u', kind: 'proposal_expired', payload: { proposalId: 'p9', proposalKind: 'swap', proposal: { a: 1 } } }),
    );
    assert.match(expired, /p9 \(swap\) expired/);

    const created = describeEvent(
      event({ user_id: 'u', kind: 'proposal_created', payload: { proposalId: 'p8', proposalKind: 'withdrawal', proposal: { b: 2 } } }),
    );
    assert.match(created, /p8 \(withdrawal\) was created/);
    assert.match(created, /Approve button/);

    const sched = describeEvent(
      event({ user_id: 'u', kind: 'scheduled_fired', payload: { actionKind: 'balance_check', message: 'deposit?', result: 'native +0.5' } }),
    );
    assert.match(sched, /scheduled balance_check "deposit\?" just fired/);
    assert.match(sched, /measured result: native \+0\.5/);
    const research = describeEvent(
      event({ user_id: 'u', kind: 'scheduled_fired', payload: { actionKind: 'research', message: 'brief me', result: null } }),
    );
    assert.match(research, /research this NOW/);
    assert.match(research, /Never invent data/);
  });
});

describe('runReactionTurn', () => {
  live('sends, persists the assistant message, and records usage', async () => {
    const tag = `rxn-${Date.now()}`;
    const user = await ensureUserByTelegram(tag);
    await appendMessage({ userId: user.id, role: 'user', content: 'hello' });
    const sent: string[] = [];
    const out = await runReactionTurn(
      { lock: new MemoryLock(), runTurnFn: stubTurn('SOL dropped 12% — want me to act?') },
      event({ user_id: user.id, payload: { ruleId: 'r', kind: 'price_drop', asset: 'SOL', price: 90, actionTaken: 'alert' } }),
      tag,
      async (t) => {
        sent.push(t);
      },
    );
    assert.deepEqual(out, { ok: true });
    assert.deepEqual(sent, ['SOL dropped 12% — want me to act?']);
    const history = await recentMessages(user.id, 10);
    // No fake user message persisted for the event; only the notification.
    assert.deepEqual(
      history.map((h) => [h.role, h.content]),
      [
        ['user', 'hello'],
        ['assistant', 'SOL dropped 12% — want me to act?'],
      ],
    );
    assert.equal(await dailyTokensUsed(user.id), 15);
    await closePool();
  });

  live('busy lock and exhausted budget short-circuit without calling the model', async () => {
    const tag = `rxn-busy-${Date.now()}`;
    const user = await ensureUserByTelegram(tag);
    const lock = new MemoryLock();
    const release = await lock.acquire(`turn:${user.id}`, 60_000);
    assert.ok(release);
    let ran = false;
    const busy = await runReactionTurn(
      {
        lock,
        runTurnFn: async () => {
          ran = true;
          return { text: 'x', modelId: 's', failedOver: false, inputTokens: 0, outputTokens: 0, toolNames: [] };
        },
      },
      event({ user_id: user.id }),
      tag,
      async () => {},
    );
    assert.deepEqual(busy, { ok: false, error: 'busy' });
    assert.equal(ran, false);
    await release!();

    await setBudget(user.id, { dailyTokenCap: 0 });
    const sent: string[] = [];
    const capped = await runReactionTurn(
      { lock, runTurnFn: stubTurn() },
      event({ user_id: user.id }),
      tag,
      async (t) => {
        sent.push(t);
      },
    );
    assert.deepEqual(capped, { ok: true });
    assert.match(sent[0], /daily usage limit/);
    await closePool();
  });
});
