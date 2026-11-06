import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideOnPrice } from './evaluator';

describe('decideOnPrice', () => {
  it('trailing stop tracks the high and fires on width breach', () => {
    const params = { width_pct: 10 };
    let d = decideOnPrice('trailing_stop', params, {}, 100);
    assert.equal(d.fire, false);
    assert.equal(d.state.high, 100);

    d = decideOnPrice('trailing_stop', params, d.state, 120);
    assert.equal(d.fire, false);
    assert.equal(d.state.high, 120);

    d = decideOnPrice('trailing_stop', params, d.state, 112);
    assert.equal(d.fire, false); // 6.7% off high
    assert.equal(d.state.high, 120);

    d = decideOnPrice('trailing_stop', params, d.state, 107);
    assert.equal(d.fire, true); // 10.8% off high
  });

  it('price_drop with fixed reference fires at threshold', () => {
    const params = { threshold_pct: 12, reference: 'fixed', reference_price: 100 };
    assert.equal(decideOnPrice('price_drop', params, {}, 90).fire, false);
    assert.equal(decideOnPrice('price_drop', params, {}, 88).fire, true);
  });

  it('price_drop with current reference baselines on first sight', () => {
    const params = { threshold_pct: 10 };
    const first = decideOnPrice('price_drop', params, {}, 100);
    assert.equal(first.fire, false);
    assert.equal(first.state.baseline, 100);
    assert.equal(decideOnPrice('price_drop', params, first.state, 95).fire, false);
    assert.equal(decideOnPrice('price_drop', params, first.state, 89).fire, true);
  });

  it('never fires on bad prices and rejects malformed rules loudly', () => {
    assert.equal(decideOnPrice('trailing_stop', { width_pct: 10 }, {}, 0).fire, false);
    assert.equal(decideOnPrice('trailing_stop', { width_pct: 10 }, {}, NaN).fire, false);
    assert.throws(() => decideOnPrice('trailing_stop', {}, {}, 100), /width_pct/);
    assert.throws(
      () => decideOnPrice('price_drop', { threshold_pct: 5, reference: 'fixed' }, {}, 100),
      /baseline/,
    );
    assert.throws(() => decideOnPrice('moon_shot', {}, {}, 100), /unsupported/);
  });
});
