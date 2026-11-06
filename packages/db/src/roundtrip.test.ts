import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '@sentinel/config';
import {
  closePool,
  ensureUserByTelegram,
  ensureWallet,
  insertAuditEvent,
  insertSnapshot,
  listActiveRules,
} from './index';

loadEnv(process.cwd());

// Live integration test: runs only when DATABASE_URL is set.
const live = process.env.DATABASE_URL ? it : it.skip;

describe('db roundtrip', () => {
  live('user -> wallet -> rules/audit/snapshot', async () => {
    const user = await ensureUserByTelegram(`test-${Date.now()}`);
    assert.ok(user.id);
    const wallet = await ensureWallet(user.id, 'solana', `TestAddr${Date.now()}`);
    assert.ok(wallet.address.includes('TestAddr'));
    assert.deepEqual(await listActiveRules(wallet.id), []);
    await insertAuditEvent({ walletId: wallet.id, actor: 'system', action: 'test' });
    await insertSnapshot(wallet.id, 1.5, { hello: 'world' });
    await closePool();
  });
});
