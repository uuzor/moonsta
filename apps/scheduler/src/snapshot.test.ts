import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { clearAdapters, registerAdapter, type ChainAdapter } from '@sentinel/chain';
import { loadEnv } from '@sentinel/config';
import { closePool, ensureUserByTelegram, ensureWallet, recentSnapshots } from '@sentinel/db';
import { snapshotAllWallets } from './jobs/snapshot';

loadEnv(process.cwd());

function fakeAdapter(): ChainAdapter {
  return {
    chain: 'solana',
    nativeSymbol: 'SOL',
    nativeMint: 'NATIVE',
    stableMints: ['STABLE'],
    symbols: { SOL: 'NATIVE' },
    supportedProtocols: [],
    assertAddress: () => {},
    getNativeBalance: async () => ({ amount: 2, decimals: 9, amountRaw: '2000000000' }),
    getTokenBalances: async () => [],
    getUsdPrices: async (mints: string[]) =>
      new Map(
        mints.map((m) => [
          m,
          { usdPrice: 100, change24h: null, liquidityUsd: null, indexedAt: null },
        ]),
      ),
    getMintInfo: async () => null,
    getTop10Pct: async () => null,
    getPositions: async () => [],
    getExternalRisk: async () => null,
    quoteSwap: async () => {
      throw new Error('not implemented');
    },
  };
}

// Live integration test: runs only when DATABASE_URL is set.
const live = process.env.DATABASE_URL ? it : it.skip;

describe('snapshot job', () => {
  live('snapshots tracked wallets end to end (fake adapter)', async () => {
    clearAdapters();
    registerAdapter(fakeAdapter());
    try {
      const user = await ensureUserByTelegram(`snap-${Date.now()}`);
      const wallet = await ensureWallet(user.id, 'solana', Keypair.generate().publicKey.toBase58());
      const out = await snapshotAllWallets();
      assert.ok(out.snapshots >= 1, JSON.stringify(out));
      assert.deepEqual(out.failed, []);
      const snaps = await recentSnapshots(wallet.id, 1);
      assert.equal(snaps.length, 1);
      const report = snaps[0].data as { wallet: string; totalUsd: number; holdings: unknown[] };
      assert.equal(report.wallet, wallet.address);
      assert.equal(report.totalUsd, 200);
      assert.equal(report.holdings.length, 1);
    } finally {
      clearAdapters();
      await closePool();
    }
  });
});
