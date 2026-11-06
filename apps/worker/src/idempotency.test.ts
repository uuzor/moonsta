import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '@sentinel/config';
import {
  closePool,
  ensureUserByTelegram,
  ensureWallet,
  releaseTrigger,
  tryInsertTrigger,
} from '@sentinel/db';
import { createRule } from '@sentinel/rules';

loadEnv(process.cwd());

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Live integration test: runs only when DATABASE_URL is set.
const live = process.env.DATABASE_URL ? it : it.skip;

describe('trigger idempotency', () => {
  live('second claim on the same key loses; release reopens it', async () => {
    const user = await ensureUserByTelegram(`idem-test-${Date.now()}`);
    const wallet = await ensureWallet(user.id, 'solana', `IdemAddr${Date.now()}`);
    const rule = await createRule({
      walletId: wallet.id,
      kind: 'trailing_stop',
      asset: MINT,
      params: { width_pct: 10 },
      action: { type: 'alert' },
    });
    const key = `fire:${rule.id}`;
    assert.equal(await tryInsertTrigger(rule.id, key, 'fired', {}), true);
    assert.equal(await tryInsertTrigger(rule.id, key, 'fired', {}), false);
    await releaseTrigger(key);
    assert.equal(await tryInsertTrigger(rule.id, key, 'fired', {}), true);
    await releaseTrigger(key);
    await closePool();
  });
});
