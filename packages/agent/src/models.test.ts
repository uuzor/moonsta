import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LanguageModel } from 'ai';
import { generateWithFailover, isRetryable } from './models';

function fakeModel(id: string): LanguageModel {
  return { modelId: id } as unknown as LanguageModel;
}

function coded(statusCode: number): Error {
  return Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
}

describe('generateWithFailover', () => {
  it('uses primary when healthy', async () => {
    const r = await generateWithFailover(fakeModel('p'), fakeModel('f'), async (m) => `via ${(m as { modelId: string }).modelId}`);
    assert.deepEqual(r, { result: 'via p', modelId: 'p', failedOver: false });
  });

  it('fails over once on retryable errors', async () => {
    const r = await generateWithFailover(
      fakeModel('p'),
      fakeModel('f'),
      async (m) => {
        if ((m as { modelId: string }).modelId === 'p') throw coded(429);
        return 'fallback-ok';
      },
    );
    assert.deepEqual(r, { result: 'fallback-ok', modelId: 'f', failedOver: true });
  });

  it('does not fail over on programmer errors', async () => {
    await assert.rejects(
      () =>
        generateWithFailover(fakeModel('p'), fakeModel('f'), async () => {
          throw coded(400);
        }),
      /HTTP 400/,
    );
  });

  it('surfaces primary errors when no fallback is configured', async () => {
    await assert.rejects(
      () =>
        generateWithFailover(fakeModel('p'), null, async () => {
          throw coded(503);
        }),
      /HTTP 503/,
    );
  });
});

describe('isRetryable', () => {
  it('classifies transport and server failures', () => {
    assert.equal(isRetryable(coded(429)), true);
    assert.equal(isRetryable(coded(500)), true);
    assert.equal(isRetryable(coded(400)), false);
    assert.equal(isRetryable(new Error('fetch failed')), true);
    assert.equal(isRetryable(new Error('socket timeout')), true);
    assert.equal(isRetryable(new Error('invalid tool schema')), false);
  });
});
