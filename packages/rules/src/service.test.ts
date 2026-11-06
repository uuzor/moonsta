import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '@sentinel/config';
import { closePool, ensureUserByTelegram, ensureWallet } from '@sentinel/db';
import { RuleValidationError, createRule, deleteRule, setRuleStatus } from './service';

loadEnv(process.cwd());

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Live integration test: runs only when DATABASE_URL is set.
const live = process.env.DATABASE_URL ? it : it.skip;

describe('rules service', () => {
  live('create -> pause -> delete roundtrip', async () => {
    const user = await ensureUserByTelegram(`rules-test-${Date.now()}`);
    const wallet = await ensureWallet(user.id, 'solana', `RulesAddr${Date.now()}`);
    const rule = await createRule({
      walletId: wallet.id,
      kind: 'trailing_stop',
      asset: MINT,
      params: { width_pct: 12 },
      action: { type: 'swap', max_size_pct: 30, to_mint: MINT },
    });
    assert.equal(rule.status, 'active');
    const paused = await setRuleStatus(rule.id, 'paused');
    assert.equal(paused?.status, 'paused');
    assert.equal(await deleteRule(rule.id), true);
    assert.equal(await deleteRule(rule.id), false);
    await closePool();
  });

  live('rejects invalid rules before touching the db', async () => {
    const user = await ensureUserByTelegram(`rules-test-${Date.now()}`);
    const wallet = await ensureWallet(user.id, 'solana', `RulesAddr${Date.now()}`);
    await assert.rejects(
      () =>
        createRule({
          walletId: wallet.id,
          kind: 'trailing_stop',
          asset: MINT,
          params: { width_pct: 500 },
          action: { type: 'alert' },
        }),
      RuleValidationError,
    );
    await closePool();
  });
});
