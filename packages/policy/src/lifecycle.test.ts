import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { loadEnv } from '@sentinel/config';
import {
  closePool,
  dailySpendUsd,
  ensureUserByTelegram,
  ensureWallet,
  getProposal,
  recordSpend,
  resolveProposal,
  setPolicyCaps,
} from '@sentinel/db';
import { SOL_MINT } from '@sentinel/chain-solana';
import { PolicyDeniedError, checkFunds } from './check';
import { rejectProposal } from './proposals';
import { addAddress, requestSwapProposal, requestWithdrawal, revokeAddress } from './withdrawals';

loadEnv(process.cwd());

// Live integration tests: run only when DATABASE_URL is set.
const live = process.env.DATABASE_URL ? it : it.skip;

async function setup(tag: string) {
  const user = await ensureUserByTelegram(`policy-test-${tag}-${Date.now()}`);
  const wallet = await ensureWallet(user.id, 'solana', `PolicyAddr${tag}${Date.now()}`);
  return { user, wallet };
}

describe('policy lifecycle', () => {
  live('caps deny over-limit spend', async () => {
    const { wallet } = await setup('caps');
    await setPolicyCaps(wallet.id, { dailyCapUsd: 100, perTxCapUsd: 40 });
    assert.deepEqual(await checkFunds(wallet.id, 10), { allowed: true });
    const over = await checkFunds(wallet.id, 41);
    assert.equal(over.allowed, false);
    await recordSpend(wallet.id, 90, 'swap', 'ref1');
    assert.equal(await dailySpendUsd(wallet.id), 90);
    const overDaily = await checkFunds(wallet.id, 11);
    assert.equal(overDaily.allowed, false);
    await closePool();
  });

  live('withdrawal allowlist enforces cooldown and revocation', async () => {
    const prev = process.env.WITHDRAWAL_COOLDOWN_MS;
    process.env.WITHDRAWAL_COOLDOWN_MS = '60';
    try {
      const { wallet } = await setup('cool');
      const addr = Keypair.generate().publicKey.toBase58();
      await assert.rejects(
        () =>
          requestWithdrawal({ walletId: wallet.id, mint: SOL_MINT, amountRaw: '100', toAddress: addr, usdValue: 1 }),
        /allowlisted/,
      );
      await addAddress(wallet.id, addr, 'test');
      await assert.rejects(
        () =>
          requestWithdrawal({ walletId: wallet.id, mint: SOL_MINT, amountRaw: '100', toAddress: addr, usdValue: 1 }),
        /cooling down/,
      );
      await new Promise((r) => setTimeout(r, 80));
      const p1 = await requestWithdrawal({
        walletId: wallet.id,
        mint: SOL_MINT,
        amountRaw: '100',
        toAddress: addr,
        usdValue: 1,
      });
      assert.equal(p1.status, 'pending');
      await rejectProposal(p1.id);
      assert.equal((await getProposal(p1.id))?.status, 'rejected');
      await assert.rejects(() => rejectProposal(p1.id), /already/);
      await revokeAddress(wallet.id, addr);
      await assert.rejects(
        () =>
          requestWithdrawal({ walletId: wallet.id, mint: SOL_MINT, amountRaw: '100', toAddress: addr, usdValue: 1 }),
        /cooling down|revoked|allowlisted/,
      );
    } finally {
      if (prev === undefined) delete process.env.WITHDRAWAL_COOLDOWN_MS;
      else process.env.WITHDRAWAL_COOLDOWN_MS = prev;
    }
    await closePool();
  });

  live('swap proposals need caps and resolve exactly once', async () => {
    const { wallet } = await setup('swap');
    await setPolicyCaps(wallet.id, { dailyCapUsd: 100, perTxCapUsd: 40 });
    await assert.rejects(
      () =>
        requestSwapProposal({
          walletId: wallet.id,
          inputMint: SOL_MINT,
          outputMint: SOL_MINT,
          amountRaw: '1',
          usdValue: 1000,
          slippageBps: 50,
        }),
      PolicyDeniedError,
    );
    const p = await requestSwapProposal({
      walletId: wallet.id,
      inputMint: SOL_MINT,
      outputMint: SOL_MINT,
      amountRaw: '1',
      usdValue: 1,
      slippageBps: 50,
    });
    assert.equal(p.status, 'pending');
    assert.ok(await resolveProposal(p.id, 'rejected'));
    assert.equal(await resolveProposal(p.id, 'rejected'), null);
    await closePool();
  });
});
