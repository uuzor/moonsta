import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RiskInput, scoreToken, suggestWidth } from './score';

function input(over: Partial<RiskInput> = {}): RiskInput {
  return {
    mint: 'MINT',
    mintKnown: true,
    mintAuthority: null,
    freezeAuthority: null,
    top10Pct: 10,
    liquidityUsd: 5_000_000,
    indexedDays: 400,
    change24hAbs: 2,
    ...over,
  };
}

describe('scoreToken', () => {
  it('scores a safe blue-chip as low with a wide auto guard', () => {
    const r = scoreToken(input());
    assert.equal(r.grade, 'low');
    assert.ok(r.score < 25);
    assert.equal(r.suggestion.auto, true);
    assert.equal(r.suggestion.max_size_pct, 50);
    assert.equal(r.suggestion.width_pct, 8); // 1.5*2=3 clamped to 8
  });

  it('scores a risky memecoin as extreme and alert-only', () => {
    const r = scoreToken(
      input({
        mintAuthority: 'Auth1111111111111111111111111111111111111',
        freezeAuthority: 'Auth1111111111111111111111111111111111111',
        top10Pct: 85,
        liquidityUsd: 5000,
        indexedDays: 3,
        change24hAbs: 60,
      }),
    );
    assert.equal(r.grade, 'extreme');
    assert.equal(r.suggestion.auto, false);
    assert.equal(r.suggestion.max_size_pct, 0);
    assert.equal(r.suggestion.width_pct, 35); // 1.5*60=90 clamped to 35
  });

  it('shrinks auto size as grade worsens', () => {
    const medium = scoreToken(input({ top10Pct: 45, liquidityUsd: 500_000 }));
    assert.equal(medium.grade, 'medium');
    assert.equal(medium.suggestion.max_size_pct, 30);
    const high = scoreToken(
      input({
        mintAuthority: 'A',
        top10Pct: 55,
        liquidityUsd: 50_000,
        indexedDays: 10,
        external: { score01: 5, dangers: [] },
      }),
    );
    assert.equal(high.grade, 'high');
    assert.equal(high.suggestion.max_size_pct, 15);
  });

  it('penalizes unknowns without maxing out', () => {
    const r = scoreToken(
      input({ mintKnown: false, top10Pct: null, liquidityUsd: null, indexedDays: null, change24hAbs: null }),
    );
    // 20 + 15 + 25 + 10 + 10 + 10 = 90 -> extreme, alert-only
    assert.equal(r.score, 90);
    assert.equal(r.grade, 'extreme');
    assert.equal(r.suggestion.auto, false);
  });

  it('weighs the external verdict below our own signals', () => {
    const clean = scoreToken(input({ external: { score01: 1, dangers: [] } }));
    assert.ok(clean.factors.some((f) => f.name === 'external audit' && f.points === 0));
    const risky = scoreToken(
      input({ external: { score01: 76, dangers: ['Mint Authority still enabled', 'Low Liquidity'] } }),
    );
    const factor = risky.factors.find((f) => f.name === 'external audit');
    assert.equal(factor?.points, 20);
    assert.ok(factor?.detail.includes('Mint Authority still enabled'));
    const mid = scoreToken(input({ external: { score01: 50, dangers: [] } }));
    assert.ok(mid.factors.some((f) => f.name === 'external audit' && f.points === 15));
  });

  it('skips concentration for native assets', () => {
    const r = scoreToken(input({ top10Pct: null, concentrationNA: true }));
    assert.ok(!r.factors.some((f) => f.detail === 'top holders unknown'));
    assert.ok(r.score < 25);
  });

  it('suggests width from volatility with default 15', () => {
    assert.equal(suggestWidth(null), 15);
    assert.equal(suggestWidth(10), 15);
    assert.equal(suggestWidth(20), 30);
  });
});
