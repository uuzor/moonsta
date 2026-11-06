import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateRule } from './schema';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('validateRule', () => {
  it('accepts a well-formed trailing stop with swap action', () => {
    const r = validateRule({
      kind: 'trailing_stop',
      asset: MINT,
      params: { width_pct: 12 },
      action: { type: 'swap', max_size_pct: 30, to_mint: MINT },
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.rule.params, { width_pct: 12 });
  });

  it('accepts price_drop with fixed reference and alert action', () => {
    const r = validateRule({
      kind: 'price_drop',
      asset: MINT,
      params: { threshold_pct: 12, reference: 'fixed', reference_price: 100 },
      action: { type: 'alert' },
    });
    assert.equal(r.ok, true);
  });

  it('defaults price_drop reference to current', () => {
    const r = validateRule({
      kind: 'price_drop',
      asset: MINT,
      params: { threshold_pct: 12 },
      action: { type: 'alert' },
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal((r.rule.params as { reference: string }).reference, 'current');
  });

  it('accepts liq_distance on drift markets only', () => {
    const good = validateRule({
      kind: 'liq_distance',
      asset: 'drift:SOL-PERP',
      params: { distance_pct: 8 },
      action: { type: 'alert' },
    });
    assert.equal(good.ok, true);
    const bad = validateRule({
      kind: 'liq_distance',
      asset: MINT,
      params: { distance_pct: 8 },
      action: { type: 'alert' },
    });
    assert.equal(bad.ok, false);
  });

  it('rejects bad kinds, assets, ranges, and actions', () => {
    const cases: unknown[] = [
      null,
      { kind: 'moon_shot', asset: MINT, params: {}, action: { type: 'alert' } },
      { kind: 'trailing_stop', asset: 'not-a-mint', params: { width_pct: 5 }, action: { type: 'alert' } },
      { kind: 'trailing_stop', asset: MINT, params: { width_pct: 0.2 }, action: { type: 'alert' } },
      { kind: 'trailing_stop', asset: MINT, params: { width_pct: 99 }, action: { type: 'alert' } },
      { kind: 'trailing_stop', asset: MINT, params: {}, action: { type: 'alert' } },
      { kind: 'price_drop', asset: MINT, params: { threshold_pct: 200 }, action: { type: 'alert' } },
      {
        kind: 'price_drop',
        asset: MINT,
        params: { threshold_pct: 5, reference: 'fixed' },
        action: { type: 'alert' },
      },
      { kind: 'trailing_stop', asset: MINT, params: { width_pct: 5 }, action: { type: 'withdraw' } },
      {
        kind: 'trailing_stop',
        asset: MINT,
        params: { width_pct: 5 },
        action: { type: 'swap', max_size_pct: 0, to_mint: MINT },
      },
      {
        kind: 'trailing_stop',
        asset: MINT,
        params: { width_pct: 5 },
        action: { type: 'swap', max_size_pct: 10, to_mint: 'xyz' },
      },
    ];
    for (const c of cases) {
      const r = validateRule(c);
      assert.equal(r.ok, false, `expected rejection: ${JSON.stringify(c)}`);
      if (!r.ok) assert.ok(r.errors.length > 0);
    }
  });

  it('rejects non-numeric and out-of-shape params', () => {
    const r = validateRule({
      kind: 'trailing_stop',
      asset: MINT,
      params: { width_pct: 'wide' },
      action: { type: 'alert' },
    });
    assert.equal(r.ok, false);
  });
});
