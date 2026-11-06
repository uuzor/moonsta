import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '@sentinel/config';
import {
  claimReactions,
  closePool,
  enqueueReaction,
  ensureUserByTelegram,
  getPool,
} from '@sentinel/db';
import { MemoryLock } from '@sentinel/queue';
import { drainReactions } from './jobs/drain';

loadEnv(process.cwd());

const live = process.env.DATABASE_URL ? it : it.skip;

describe('drain-reactions', () => {
  live('delivers pending events and fails unroutable ones', async () => {
    const tag = `drain-${Date.now()}`;
    const user = await ensureUserByTelegram(tag);
    const evt = await enqueueReaction({
      userId: user.id,
      kind: 'rule_fired',
      notifyPolicy: 'notify_first',
      payload: { ruleId: 'r', kind: 'price_drop', asset: 'SOL', price: 90, actionTaken: 'alert' },
    });
    const sent: Array<[string, string]> = [];
    const out = await drainReactions({
      lock: new MemoryLock(),
      runTurnFn: async () => ({
        text: 'stub reaction',
        modelId: 'stub',
        failedOver: false,
        inputTokens: 1,
        outputTokens: 1,
        toolNames: [],
      }),
      send: async (to, text) => {
        sent.push([to, text]);
      },
    });
    assert.ok(out.sent >= 1, JSON.stringify(out));
    assert.ok(sent.some(([to, text]) => to === tag && text === 'stub reaction'));
    assert.ok(!(await claimReactions(50)).some((c) => c.id === evt.id));

    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO users (telegram_id) VALUES (NULL) RETURNING id`,
    );
    const orphan = await enqueueReaction({
      userId: rows[0].id,
      kind: 'proposal_expired',
      notifyPolicy: 'notify_first',
      payload: { proposalId: 'p' },
    });
    const out2 = await drainReactions({ lock: new MemoryLock(), send: async () => {} });
    assert.ok(out2.failed >= 1, JSON.stringify(out2));
    assert.ok(!(await claimReactions(50)).some((c) => c.id === orphan.id));
    await closePool();
  });

  live('skips proposal_created events whose proposal already resolved', async () => {
    const user = await ensureUserByTelegram(`drain-stale-${Date.now()}`);
    const stale = await enqueueReaction({
      userId: user.id,
      kind: 'proposal_created',
      notifyPolicy: 'notify_first',
      payload: { proposalId: '00000000-0000-0000-0000-000000000000', proposalKind: 'swap' },
    });
    let modelCalls = 0;
    const out = await drainReactions({
      lock: new MemoryLock(),
      runTurnFn: async () => {
        modelCalls += 1;
        return { text: 'must not happen', modelId: 'stub', failedOver: false, inputTokens: 0, outputTokens: 0, toolNames: [] };
      },
    });
    assert.equal(modelCalls, 0);
    assert.ok(out.sent >= 1, JSON.stringify(out));
    assert.ok(!(await claimReactions(50)).some((c) => c.id === stale.id));
    const { rows } = await getPool().query<{ action: string }>(
      `SELECT action FROM audit_log WHERE action = 'reaction_skipped_stale' ORDER BY created_at DESC LIMIT 1`,
    );
    assert.equal(rows.length, 1);
    await closePool();
  });
});
