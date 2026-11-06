import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChainAdapter } from './adapter';
import { UnknownChainError, clearAdapters, getAdapter, registerAdapter, supportedChains } from './registry';

function fakeAdapter(chain: 'solana'): ChainAdapter {
  return {
    chain,
    nativeSymbol: 'X',
    nativeMint: null,
    stableMints: [],
    symbols: {},
    supportedProtocols: [],
    assertAddress: () => {},
    getNativeBalance: async () => ({ amount: 0, decimals: 9, amountRaw: '0' }),
    getTokenBalances: async () => [],
    getUsdPrices: async () => new Map(),
    getMintInfo: async () => null,
    getTop10Pct: async () => null,
    getPositions: async () => [],
    quoteSwap: async () => [],
    getExternalRisk: async () => null,
  };
}

describe('adapter registry', () => {
  it('registers, resolves, and rejects unknown chains', () => {
    clearAdapters();
    assert.deepEqual(supportedChains(), []);
    assert.throws(() => getAdapter('solana'), UnknownChainError);
    registerAdapter(fakeAdapter('solana'));
    assert.deepEqual(supportedChains(), ['solana']);
    assert.equal(getAdapter('solana').nativeSymbol, 'X');
    assert.throws(() => getAdapter('ethereum'), /Supported: solana/);
    clearAdapters();
  });
});
