import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { SimulationError, executeSwap } from './jupiterSwap';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function stubSwapTx(payer: PublicKey): string {
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: '1'.repeat(32),
    instructions: [],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}

interface FetchCall {
  url: string;
  body: string | null;
}

function stubJupiter(opts: { simErr?: unknown; quoteStatus?: number } = {}): {
  calls: FetchCall[];
  sent: string[];
} {
  const calls: FetchCall[] = [];
  const sent: string[] = [];
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ?? null });
    if (url.includes('/swap/v1/swap')) {
      // The stub tx must be payable by the key executeSwap signs with.
      const payer = new PublicKey(
        (JSON.parse(init?.body ?? '{}') as { userPublicKey: string }).userPublicKey,
      );
      return {
        ok: true,
        json: async () => ({
          swapTransaction: stubSwapTx(payer),
          lastValidBlockHeight: 1,
          simulationError: null,
        }),
      };
    }
    if ((opts.quoteStatus ?? 200) !== 200) return { ok: false, status: opts.quoteStatus };
    return {
      ok: true,
      json: async () => ({ inAmount: '1000', outAmount: '90', routePlan: [] }),
    };
  }) as unknown as typeof fetch;
  void sent;
  return { calls, sent };
}

function fakeConnection(over: Record<string, unknown> = {}): {
  connection: Connection;
  sent: string[];
} {
  const sent: string[] = [];
  const connection = {
    simulateTransaction: async () => ({ value: { err: null as unknown, logs: [] } }),
    sendRawTransaction: async (raw: Uint8Array) => {
      sent.push(Buffer.from(raw).toString('base64'));
      return 'SIG123';
    },
    getLatestBlockhash: async () => ({ blockhash: '2'.repeat(32), lastValidBlockHeight: 9 }),
    confirmTransaction: async () => ({ value: { err: null } }),
    ...over,
  };
  return { connection: connection as unknown as Connection, sent };
}

describe('executeSwap', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('dry-run quotes, builds, simulates, and never sends', async () => {
    const { calls } = stubJupiter();
    const { connection, sent } = fakeConnection();
    const r = await executeSwap({
      connection,
      keypair: Keypair.generate(),
      inputMint: SOL,
      outputMint: USDC,
      amountRaw: '1000',
      slippageBps: 50,
      dryRun: true,
    });
    assert.equal(r.signature, null);
    assert.equal(r.simulated, true);
    assert.equal(r.outAmount, '90');
    assert.equal(sent.length, 0);
    assert.ok(calls[0].url.includes('/swap/v1/quote'));
    assert.ok(calls[0].url.includes('slippageBps=50'));
    const body = JSON.parse(calls[1].body ?? '{}') as Record<string, unknown>;
    assert.equal(typeof body.userPublicKey, 'string');
    assert.deepEqual((body.quoteResponse as { outAmount: string }).outAmount, '90');
  });

  it('live path sends and confirms', async () => {
    stubJupiter();
    const { connection, sent } = fakeConnection();
    const keypair = Keypair.generate();
    const r = await executeSwap({
      connection,
      keypair,
      inputMint: SOL,
      outputMint: USDC,
      amountRaw: '1000',
      slippageBps: 50,
      dryRun: false,
    });
    assert.equal(r.signature, 'SIG123');
    assert.equal(sent.length, 1);
    // The sent bytes carry a valid ed25519 signature from the agent key.
    const wire = VersionedTransaction.deserialize(Buffer.from(sent[0], 'base64'));
    assert.equal(
      nacl.sign.detached.verify(
        wire.message.serialize(),
        wire.signatures[0],
        keypair.publicKey.toBytes(),
      ),
      true,
    );
  });

  it('rejects excessive slippage and bad amounts before any fetch', async () => {
    const { calls } = stubJupiter();
    const { connection } = fakeConnection();
    const base = {
      connection,
      keypair: Keypair.generate(),
      inputMint: SOL,
      outputMint: USDC,
      amountRaw: '1000',
      dryRun: true,
    };
    await assert.rejects(() => executeSwap({ ...base, slippageBps: 301 }), /slippageBps/);
    await assert.rejects(() => executeSwap({ ...base, slippageBps: 50, amountRaw: '0' }), /amountRaw/);
    await assert.rejects(() => executeSwap({ ...base, slippageBps: 50, amountRaw: '1.5' }), /amountRaw/);
    assert.equal(calls.length, 0);
  });

  it('throws SimulationError when simulation fails', async () => {
    stubJupiter();
    const { connection } = fakeConnection({
      simulateTransaction: async () => ({
        value: { err: { InstructionError: [0, 'Custom'] }, logs: ['log1'] },
      }),
    });
    await assert.rejects(
      () =>
        executeSwap({
          connection,
          keypair: Keypair.generate(),
          inputMint: SOL,
          outputMint: USDC,
          amountRaw: '1000',
          slippageBps: 50,
          dryRun: true,
        }),
      SimulationError,
    );
  });

  it('runs beforeBuild after quoting; a throw aborts before building', async () => {
    const { calls } = stubJupiter();
    const { connection } = fakeConnection();
    let seen: string | null = null;
    await assert.rejects(
      () =>
        executeSwap({
          connection,
          keypair: Keypair.generate(),
          inputMint: SOL,
          outputMint: USDC,
          amountRaw: '1000',
          slippageBps: 50,
          dryRun: true,
          beforeBuild: async (quote) => {
            seen = quote.outAmount;
            throw new Error('denied by policy');
          },
        }),
      /denied by policy/,
    );
    assert.equal(seen, '90');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('/swap/v1/quote'));
  });

  it('fails loudly when quoting fails', async () => {
    stubJupiter({ quoteStatus: 500 });
    const { connection } = fakeConnection();
    await assert.rejects(
      () =>
        executeSwap({
          connection,
          keypair: Keypair.generate(),
          inputMint: SOL,
          outputMint: USDC,
          amountRaw: '1000',
          slippageBps: 50,
          dryRun: true,
        }),
      /quote failed/,
    );
  });
});
