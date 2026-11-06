import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { clearAdapters, registerAdapter, type ChainAdapter } from '@sentinel/chain';
import { SOL_MINT } from '@sentinel/chain-solana';
import { loadEnv } from '@sentinel/config';
import {
  claimReactions,
  closePool,
  ensureUserByTelegram,
  ensureWallet,
  finishReaction,
  scheduleAction,
} from '@sentinel/db';
import { diffBalances, drainDueActions } from './jobs/due';

loadEnv(process.cwd());

const live = process.env.DATABASE_URL ? it : it.skip;

function fakeAdapter(): ChainAdapter {
  return {
    chain: 'solana',
    nativeSymbol: 'SOL',
    nativeMint: SOL_MINT,
    stableMints: [],
    symbols: {},
    supportedProtocols: [],
    assertAddress: () => {},
    getNativeBalance: async () => ({ amount: 10, decimals: 9, amountRaw: '10000000000' }),
    getTokenBalances: async () => [],
    getUsdPrices: async () => new Map(),
    getMintInfo: async () => null,
    getTop10Pct: async () => null,
    getPositions: async () => [],
    getExternalRisk: async () => null,
    quoteSwap: async () => {
      throw new Error('not implemented');
    },
  };
}

describe('diffBalances', () => {
  it('reports deposits, withdrawals, and silence explicitly', () => {
    const base = {
      chain: 'solana',
      address: 'A',
      baseline: { native: { amountRaw: '10000000000', decimals: 9 }, tokens: {} },
    };
    assert.equal(
      diffBalances(base, { nativeRaw: '10000000000', nativeDecimals: 9, tokens: {} }),
      'no balance change since the baseline snapshot',
    );
    assert.match(
      diffBalances(base, { nativeRaw: '10500000000', nativeDecimals: 9, tokens: {} }),
      /native \+0\.5 \(10 → 10\.5\)/,
    );
    assert.match(
      diffBalances(base, {
        nativeRaw: '10000000000',
        nativeDecimals: 9,
        tokens: { [SOL_MINT]: { amountRaw: '2000000', decimals: 6 } },
      }),
      /SOL \+2 \(0 → 2\)/,
    );
  });
});

describe('drainDueActions', () => {
  live('fires reminders and no-change checks into reactions', async () => {
    clearAdapters();
    registerAdapter(fakeAdapter());
    try {
      const user = await ensureUserByTelegram(`due-${Date.now()}`);
      const wallet = await ensureWallet(user.id, 'solana', Keypair.generate().publicKey.toBase58());
      const past = new Date(Date.now() - 1000);
      const rem = await scheduleAction({ userId: user.id, kind: 'reminder', message: 'hello future', runAt: past });
      const chk = await scheduleAction({
        userId: user.id,
        walletId: wallet.id,
        kind: 'balance_check',
        message: 'deposit?',
        params: {
          chain: 'solana',
          address: wallet.address,
          baseline: { native: { amountRaw: '10000000000', decimals: 9 }, tokens: {} },
        },
        runAt: past,
      });
      const out = await drainDueActions(10);
      assert.ok(out.done >= 2, JSON.stringify(out));
      const reactions = await claimReactions(50);
      const ours = reactions.filter((r) =>
        [(r.payload as { actionId?: string }).actionId].some((id) => id === rem.id || id === chk.id),
      );
      assert.equal(ours.length, 2);
      assert.ok(ours.every((r) => r.kind === 'scheduled_fired' && r.notify_policy === 'notify_first'));
      const checkPayload = ours.find((r) => (r.payload as { actionId?: string }).actionId === chk.id)!
        .payload as { result?: string };
      assert.match(checkPayload.result ?? '', /no balance change/);
      for (const r of ours) await finishReaction(r.id, 'sent');
    } finally {
      clearAdapters();
      await closePool();
    }
  });
});
