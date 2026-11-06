import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunk, getUsdPrices } from './jupiterPrices';

describe('chunk', () => {
  it('splits into groups of size', () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [
      [1, 2],
      [3, 4],
      [5],
    ]);
    assert.deepEqual(chunk([], 50), []);
  });
});

describe('getUsdPrices', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('batches ids and maps entries', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      const ids = new URL(url).searchParams.get('ids')!.split(',');
      return {
        ok: true,
        json: async () =>
          Object.fromEntries(
            ids.map((id, i) => [
              id,
              {
                usdPrice: 1 + i,
                priceChange24h: 0.5,
                decimals: 9,
                liquidity: 1000,
                createdAt: '2024-01-01T00:00:00.000Z',
              },
            ]),
          ),
      };
    }) as unknown as typeof fetch;
    const mints = Array.from({ length: 120 }, (_, i) => `Mint${i}`);
    const prices = await getUsdPrices(mints, 'https://price.test/v3');
    assert.equal(calls.length, 3);
    assert.equal(prices.size, 120);
    assert.deepEqual(prices.get('Mint0'), {
      usdPrice: 1,
      change24h: 0.5,
      decimals: 9,
      liquidityUsd: 1000,
      indexedAt: '2024-01-01T00:00:00.000Z',
    });
  });

  it('tolerates failed chunks as unpriced', async () => {
    globalThis.fetch = (async () => ({ ok: false })) as unknown as typeof fetch;
    assert.equal((await getUsdPrices(['A'], 'https://x')).size, 0);
    globalThis.fetch = (async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    assert.equal((await getUsdPrices(['A'], 'https://x')).size, 0);
  });
});
