import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SwapQuote } from '@sentinel/chain-solana';
import { verifyQuoteMatches } from './quote';

const REQ = { inputMint: 'IN', outputMint: 'OUT', amountRaw: '1000', slippageBps: 50 };

function quote(raw: unknown, inAmount = '1000'): SwapQuote {
  return { inAmount, outAmount: '90', raw };
}

describe('verifyQuoteMatches', () => {
  it('accepts an echoing quote', () => {
    const r = verifyQuoteMatches(
      REQ,
      quote({ inputMint: 'IN', outputMint: 'OUT', inAmount: '1000', slippageBps: 50 }),
    );
    assert.deepEqual(r, { ok: true });
  });

  it('rejects any mismatch fail-closed', () => {
    const bad: Array<[unknown, RegExp]> = [
      [null, /no body/],
      [{}, /mismatch/],
      [{ inputMint: 'EVIL', outputMint: 'OUT', inAmount: '1000', slippageBps: 50 }, /inputMint/],
      [{ inputMint: 'IN', outputMint: 'EVIL', inAmount: '1000', slippageBps: 50 }, /outputMint/],
      [{ inputMint: 'IN', outputMint: 'OUT', inAmount: '999', slippageBps: 50 }, /amount/],
      [{ inputMint: 'IN', outputMint: 'OUT', inAmount: '1000', slippageBps: 51 }, /slippage/],
      [{ inputMint: 'IN', outputMint: 'OUT', inAmount: '1000' }, /slippage/],
    ];
    for (const [raw, re] of bad) {
      const r = verifyQuoteMatches(REQ, quote(raw));
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.reason, re);
    }
  });
});
