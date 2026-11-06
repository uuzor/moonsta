import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import {
  ChainAdapter,
  UnknownProtocolError,
  clearAdapters,
  registerAdapter,
} from '@sentinel/chain';
import { SOL_MINT, USDC_MINT } from '@sentinel/chain-solana';
import { loadEnv } from '@sentinel/config';
import { closePool } from '@sentinel/db';
import { addAddress } from '@sentinel/policy';
import { MoonstaTools, buildTools } from './tools';

loadEnv(process.cwd());

function fakeAdapter(): ChainAdapter {
  return {
    chain: 'solana',
    nativeSymbol: 'SOL',
    nativeMint: SOL_MINT,
    stableMints: [USDC_MINT],
    symbols: { SOL: SOL_MINT, USDC: USDC_MINT },
    supportedProtocols: ['fake-dex'],
    assertAddress: (a: string) => {
      if (a.length < 32) throw new Error('bad address');
    },
    getNativeBalance: async () => ({ amount: 10, decimals: 9, amountRaw: '10000000000' }),
    getTokenBalances: async () => [
      { mint: USDC_MINT, amountRaw: '5000000', decimals: 6, uiAmount: 5 },
    ],
    getUsdPrices: async (mints: string[]) =>
      new Map(
        mints.map((m) => [
          m,
          {
            usdPrice: m === SOL_MINT ? 100 : 1,
            change24h: 0,
            liquidityUsd: 1e9,
            indexedAt: '2024-01-01T00:00:00.000Z',
          },
        ]),
      ),
    getMintInfo: async () => ({
      mintAuthority: null,
      freezeAuthority: null,
      supplyRaw: '1000000',
      decimals: 9,
    }),
    getTop10Pct: async () => 10,
    getPositions: async () => [],
    getExternalRisk: async () => null,
    quoteSwap: async (req) => {
      if (req.protocol && req.protocol !== 'fake-dex') {
        throw new UnknownProtocolError('solana', req.protocol, ['fake-dex']);
      }
      return [{ protocol: 'fake-dex', inAmount: req.amountRaw, outAmount: '90' }];
    },
  };
}

async function call<T>(tools: MoonstaTools, name: keyof MoonstaTools, args: unknown): Promise<T> {
  const t = tools[name] as unknown as {
    execute: (a: unknown, o: unknown) => Promise<unknown>;
  };
  return (await t.execute(args, { toolCallId: 'test', messages: [] })) as T;
}

// Live integration tests: run only when DATABASE_URL is set.
const live = process.env.DATABASE_URL ? it : it.skip;

describe('agent tools', () => {
  live('register -> portfolio -> guards -> swap -> withdrawal', async () => {
    clearAdapters();
    registerAdapter(fakeAdapter());
    const tag = `agent-${Date.now()}`;
    const ctx = { telegramId: tag };
    const tools = buildTools(ctx);
    const address = Keypair.generate().publicKey.toBase58();
    const address2 = Keypair.generate().publicKey.toBase58();

    const reg = await call<{ address: string }>(tools, 'register_wallet', {
      chain: 'solana',
      address,
      label: 'test',
    });
    assert.equal(reg.address, address);
    await call(tools, 'register_wallet', { chain: 'solana', address: address2 });

    const single = await call<{ totalUsd: number; wallets: Array<{ report: { totalUsd: number } }> }>(
      tools,
      'get_portfolio',
      { chain: 'solana', address },
    );
    assert.equal(single.wallets.length, 1);
    assert.equal(single.wallets[0].report.totalUsd, 1005);

    const all = await call<{ totalUsd: number; wallets: unknown[] }>(tools, 'get_portfolio', {});
    assert.equal(all.wallets.length, 2);
    assert.equal(all.totalUsd, 2010);

    const score = await call<{ grade: string }>(tools, 'score_token', {
      chain: 'solana',
      mint: 'SOL',
    });
    assert.equal(score.grade, 'low');

    const applied = await call<{ ruleId: string; auto: boolean }>(tools, 'manage_guards', {
      chain: 'solana',
      address,
      action: 'apply',
      mint: SOL_MINT,
    });
    assert.equal(applied.auto, true);

    const quote = await call<{ best: string; quotes: Array<{ protocol: string }> }>(tools, 'swap', {
      chain: 'solana',
      type: 'quote',
      baseToken: 'SOL',
      outToken: 'USDC',
      amountRaw: '1000',
    });
    assert.deepEqual(quote.quotes, [{ protocol: 'fake-dex', outAmount: '90' }]);
    assert.equal(quote.best, 'fake-dex');

    const swap = await call<{ proposalId: string }>(tools, 'swap', {
      chain: 'solana',
      type: 'execute',
      address,
      baseToken: SOL_MINT,
      outToken: USDC_MINT,
      amountRaw: '1000',
      reason: 'test',
    });
    assert.ok(swap.proposalId);

    const perps = await call<{ perps: unknown }>(tools, 'perp', {
      chain: 'solana',
      address,
      action: 'positions',
    });
    assert.deepEqual(perps.perps, []);
    const gated = await call<{ supported: boolean }>(tools, 'perp', {
      chain: 'solana',
      address,
      action: 'open',
      market: 'SOL-PERP',
      side: 'long',
      sizeUi: 1,
    });
    assert.equal(gated.supported, false);

    const proposals = await call<unknown[]>(tools, 'get_proposals', { chain: 'solana', address });
    assert.equal(proposals.length, 1);

    const prev = process.env.WITHDRAWAL_COOLDOWN_MS;
    process.env.WITHDRAWAL_COOLDOWN_MS = '50';
    try {
      const dest = Keypair.generate().publicKey.toBase58();
      const { ensureUserByTelegram, findWallet } = await import('@sentinel/db');
      const user = await ensureUserByTelegram(tag);
      const wallet = await findWallet(user.id, 'solana', address);
      await addAddress(wallet!.id, dest, 'test');
      await new Promise((r) => setTimeout(r, 80));
      const wd = await call<{ proposalId: string }>(tools, 'request_withdrawal', {
        chain: 'solana',
        address,
        mint: SOL_MINT,
        amountUi: 0.001,
        toAddress: dest,
      });
      assert.ok(wd.proposalId);
    } finally {
      if (prev === undefined) delete process.env.WITHDRAWAL_COOLDOWN_MS;
      else process.env.WITHDRAWAL_COOLDOWN_MS = prev;
    }
    await closePool();
  });

  live('rejects unknown wallets, chains, protocols, and bad amounts', async () => {
    clearAdapters();
    registerAdapter(fakeAdapter());
    const tools = buildTools({ telegramId: `agent-${Date.now()}` });
    await assert.rejects(
      () =>
        call(tools, 'get_portfolio', {
          chain: 'solana',
          address: Keypair.generate().publicKey.toBase58(),
        }),
      /not registered/,
    );
    await assert.rejects(
      () => call(tools, 'get_portfolio', { chain: 'ethereum', address: '0xabc' }),
      /Unknown chain/,
    );
    await assert.rejects(
      () =>
        call(tools, 'get_portfolio', { address: Keypair.generate().publicKey.toBase58() }),
      /chain is required/,
    );
    await assert.rejects(
      () =>
        call(tools, 'swap', {
          chain: 'solana',
          type: 'quote',
          baseToken: 'SOL',
          outToken: 'USDC',
          amountRaw: '1000',
          protocol: 'nope-dex',
        }),
      /Unknown protocol/,
    );
    await assert.rejects(
      () =>
        call(tools, 'swap', {
          chain: 'solana',
          type: 'quote',
          baseToken: 'SOL',
          outToken: 'USDC',
          amountRaw: '1000',
          amountUi: 1,
        }),
      /exactly one/,
    );
    await assert.rejects(
      () =>
        call(tools, 'swap', {
          chain: 'solana',
          type: 'execute',
          baseToken: 'SOL',
          outToken: 'USDC',
          amountRaw: '1000',
        }),
      /address is required/,
    );
    await closePool();
  });

  live('guards create + schedule lifecycle', async () => {
    clearAdapters();
    registerAdapter(fakeAdapter());
    const tag = `agent-sched-${Date.now()}`;
    const tools = buildTools({ telegramId: tag });
    const address = Keypair.generate().publicKey.toBase58();
    await call(tools, 'register_wallet', { chain: 'solana', address });

    const created = await call<{ ruleId: string; kind: string; alert: boolean }>(tools, 'manage_guards', {
      chain: 'solana',
      address,
      action: 'create',
      mint: 'SOL',
      kind: 'price_drop',
      thresholdPct: 12,
    });
    assert.equal(created.kind, 'price_drop');
    assert.equal(created.alert, true);
    const listed = await call<Array<{ id: string }>>(tools, 'manage_guards', {
      chain: 'solana',
      address,
      action: 'list',
    });
    assert.ok(listed.some((r) => r.id === created.ruleId));
    await assert.rejects(
      () =>
        call(tools, 'manage_guards', {
          chain: 'solana',
          address,
          action: 'create',
          mint: 'SOL',
          kind: 'price_drop',
          thresholdPct: 0.1,
        }),
      /threshold/,
    );

    const rem = await call<{ actionId: string }>(tools, 'schedule', {
      action: 'create',
      kind: 'reminder',
      inMinutes: 180,
      message: 'check demo',
    });
    assert.ok(rem.actionId);
    const chk = await call<{ actionId: string }>(tools, 'schedule', {
      action: 'create',
      kind: 'balance_check',
      inMinutes: 30,
      message: 'deposit?',
      chain: 'solana',
      address,
    });
    assert.ok(chk.actionId);
    const all = await call<Array<{ id: string }>>(tools, 'schedule', { action: 'list' });
    assert.equal(all.filter((a) => [rem.actionId, chk.actionId].includes(a.id)).length, 2);
    const cancelled = await call<{ id: string; status: string }>(tools, 'schedule', {
      action: 'cancel',
      actionId: rem.actionId,
    });
    assert.equal(cancelled.status, 'cancelled');
    await assert.rejects(
      () => call(tools, 'schedule', { action: 'create', kind: 'reminder', inMinutes: 0, message: 'x' }),
      /inMinutes/,
    );
    await closePool();
  });
});
