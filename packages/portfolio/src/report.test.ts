import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_GUARD_USD, ReportInput, buildReport, symbolFor } from './report';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function input(over: Partial<ReportInput> = {}): ReportInput {
  return {
    wallet: 'WALLET',
    holdings: [
      { mint: SOL_MINT, amount: 2, usdPrice: 100, change24h: 10 },
      { mint: USDC, amount: 100, usdPrice: 1, change24h: 0 },
    ],
    positions: null,
    rules: [],
    ...over,
  };
}

describe('buildReport', () => {
  it('totals, allocates, and weights 24h change', () => {
    const r = buildReport(input());
    assert.equal(r.totalUsd, 300);
    assert.deepEqual(
      r.holdings.map((h) => h.symbol),
      ['SOL', 'USDC'],
    );
    assert.ok(Math.abs((r.holdings[0].allocationPct ?? 0) - 66.67) < 0.05);
    // (200*10 + 100*0) / 300
    assert.ok(Math.abs((r.change24h ?? 0) - 6.67) < 0.05);
    assert.equal(r.pricedCount, 2);
    assert.equal(r.unpricedCount, 0);
  });

  it('treats missing prices as unpriced, never zero-valued', () => {
    const r = buildReport(input({ holdings: [{ mint: 'UnknownMint', amount: 5 }] }));
    assert.equal(r.totalUsd, 0);
    assert.equal(r.holdings[0].usdValue, null);
    assert.equal(r.holdings[0].allocationPct, null);
    assert.equal(r.change24h, null);
    assert.equal(r.unpricedCount, 1);
  });

  it('flags holdings above the guard threshold without rules', () => {
    assert.equal(MIN_GUARD_USD, 10);
    const r = buildReport(input());
    assert.deepEqual(r.unprotected, ['SOL', 'USDC']);
    const covered = buildReport(
      input({ rules: [{ id: 'r1', kind: 'trailing_stop', asset: SOL_MINT, status: 'active' }] }),
    );
    assert.deepEqual(covered.unprotected, ['USDC']);
  });

  it('resolves known symbols and shortens the rest', () => {
    assert.equal(symbolFor(USDC), 'USDC');
    assert.equal(symbolFor('1234567890abcdef'), '1234…cdef');
  });
});
