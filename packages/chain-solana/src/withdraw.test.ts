import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { SOL_MINT } from './mints';
import { buildWithdrawalTx, verifyWithdrawalTx } from './withdraw';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function fakeConnection(opts: { ataExists: boolean; mintOwner?: PublicKey }): Connection {
  const mint = new PublicKey(USDC);
  return {
    getLatestBlockhash: async () => ({ blockhash: '1'.repeat(32), lastValidBlockHeight: 9 }),
    getAccountInfo: async (addr: PublicKey) => {
      if (addr.equals(mint)) return { owner: opts.mintOwner ?? TOKEN_PROGRAM_ID } as never;
      return opts.ataExists ? ({}) as never : null;
    },
  } as unknown as Connection;
}

describe('buildWithdrawalTx + verifyWithdrawalTx', () => {
  it('builds and verifies a SOL transfer', async () => {
    const from = Keypair.generate();
    const to = Keypair.generate().publicKey.toBase58();
    const tx = await buildWithdrawalTx({
      connection: fakeConnection({ ataExists: false }),
      from,
      mint: SOL_MINT,
      amountRaw: '5000',
      toAddress: to,
    });
    assert.equal(
      await verifyWithdrawalTx(tx, { from: from.publicKey, to, mint: SOL_MINT, amountRaw: '5000' }),
      true,
    );
  });

  it('rejects tampered expectations on SOL transfers', async () => {
    const from = Keypair.generate();
    const to = Keypair.generate().publicKey.toBase58();
    const tx = await buildWithdrawalTx({
      connection: fakeConnection({ ataExists: false }),
      from,
      mint: SOL_MINT,
      amountRaw: '5000',
      toAddress: to,
    });
    const base = { from: from.publicKey, to, mint: SOL_MINT };
    assert.equal(await verifyWithdrawalTx(tx, { ...base, amountRaw: '5001' }), false);
    assert.equal(
      await verifyWithdrawalTx(tx, { ...base, to: Keypair.generate().publicKey.toBase58(), amountRaw: '5000' }),
      false,
    );
    assert.equal(
      await verifyWithdrawalTx(tx, { ...base, from: Keypair.generate().publicKey, amountRaw: '5000' }),
      false,
    );
  });

  it('builds and verifies SPL transfers with and without ATA creation', async () => {
    const from = Keypair.generate();
    const to = Keypair.generate().publicKey.toBase58();
    for (const ataExists of [false, true]) {
      const tx = await buildWithdrawalTx({
        connection: fakeConnection({ ataExists }),
        from,
        mint: USDC,
        amountRaw: '123456',
        toAddress: to,
      });
      assert.equal(
        await verifyWithdrawalTx(tx, { from: from.publicKey, to, mint: USDC, amountRaw: '123456' }),
        true,
      );
    }
  });

  it('rejects SPL amount tampering and unknown mints', async () => {
    const from = Keypair.generate();
    const to = Keypair.generate().publicKey.toBase58();
    const tx = await buildWithdrawalTx({
      connection: fakeConnection({ ataExists: true }),
      from,
      mint: USDC,
      amountRaw: '123456',
      toAddress: to,
    });
    assert.equal(
      await verifyWithdrawalTx(tx, { from: from.publicKey, to, mint: USDC, amountRaw: '123457' }),
      false,
    );
    await assert.rejects(
      () =>
        buildWithdrawalTx({
          connection: {
            getLatestBlockhash: async () => ({ blockhash: '1'.repeat(32), lastValidBlockHeight: 9 }),
            getAccountInfo: async () => null,
          } as unknown as Connection,
          from,
          mint: USDC,
          amountRaw: '1',
          toAddress: to,
        }),
      /mint account not found/,
    );
  });
});
