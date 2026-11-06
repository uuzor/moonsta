import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SolanaAdapter } from './adapter';

describe('getExternalRisk', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('maps the rugcheck summary to dangers + score', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        score_normalised: 72,
        lpLockedPct: 0,
        risks: [
          { name: 'Mint Authority still enabled', level: 'danger' },
          { name: 'Note', level: 'info' },
        ],
      }),
    })) as unknown as typeof fetch;
    const r = await new SolanaAdapter().getExternalRisk('MINT');
    assert.deepEqual(r, {
      score01: 72,
      dangers: ['Mint Authority still enabled'],
      lpLockedPct: 0,
    });
  });

  it('returns null when the verdict is unavailable', async () => {
    globalThis.fetch = (async () => ({ ok: false })) as unknown as typeof fetch;
    assert.equal(await new SolanaAdapter().getExternalRisk('MINT'), null);
    globalThis.fetch = (async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    assert.equal(await new SolanaAdapter().getExternalRisk('MINT'), null);
  });
});
