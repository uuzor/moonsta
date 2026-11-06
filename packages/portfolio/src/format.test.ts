import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Report } from './report';
import { formatReportText } from './format';

describe('formatReportText', () => {
  it('renders all sections', () => {
    const report: Report = {
      wallet: 'WALLET',
      totalUsd: 300,
      change24h: 6.7,
      holdings: [
        {
          mint: 'm1',
          symbol: 'SOL',
          amount: 2,
          usdValue: 200,
          allocationPct: 66.7,
          change24h: 10,
        },
      ],
      positions: [{ protocol: 'drift', market: 'perp-0', kind: 'perp', detail: 'base 5' }],
      activeRules: [{ id: 'r1', kind: 'trailing_stop', asset: 'm1', status: 'active' }],
      unprotected: [],
      pricedCount: 1,
      unpricedCount: 0,
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    const text = formatReportText(report);
    assert.ok(text.includes('Portfolio report for WALLET'));
    assert.ok(text.includes('Total: $300'));
    assert.ok(text.includes('• SOL: 2 → $200.00 (66.7%) [24h +10.0%]'));
    assert.ok(text.includes('On-chain positions (1):'));
    assert.ok(text.includes('• drift perp-0 [perp]: base 5'));
    assert.ok(text.includes('Active guard rules: 1'));
    assert.ok(text.includes('Unprotected: none'));
  });

  it('handles empty wallets and missing drift', () => {
    const text = formatReportText({
      wallet: 'W',
      totalUsd: 0,
      change24h: null,
      holdings: [],
      positions: null,
      activeRules: [],
      unprotected: [],
      pricedCount: 0,
      unpricedCount: 0,
      generatedAt: 't',
    });
    assert.ok(text.includes('(empty wallet)'));
    assert.ok(text.includes('On-chain positions: unavailable'));
  });
});
