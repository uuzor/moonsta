import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCounter, MemoryLock, MemoryTurnQueue } from './memory';

describe('MemoryTurnQueue', () => {
  it('delivers enqueued jobs to the handler in order', async () => {
    const q = new MemoryTurnQueue(1);
    const seen: string[] = [];
    const stop = await q.process(async (job) => {
      seen.push(job.text);
      return { ok: true };
    });
    await q.enqueue({ telegramId: 'u', text: 'one', enqueuedAt: new Date().toISOString() });
    await q.enqueue({ telegramId: 'u', text: 'two', enqueuedAt: new Date().toISOString() });
    for (let i = 0; i < 100 && seen.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(seen, ['one', 'two']);
    await stop();
    await q.close();
  });

  it('keeps polling after a handler throws', async () => {
    const q = new MemoryTurnQueue(1);
    let calls = 0;
    const stop = await q.process(async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return { ok: true };
    });
    await q.enqueue({ telegramId: 'u', text: 'a', enqueuedAt: '' });
    await q.enqueue({ telegramId: 'u', text: 'b', enqueuedAt: '' });
    for (let i = 0; i < 100 && calls < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(calls, 2);
    await stop();
    await q.close();
  });
});

describe('MemoryLock', () => {
  it('serializes holders and frees on release', async () => {
    const lock = new MemoryLock();
    const first = await lock.acquire('k', 1000);
    assert.ok(first);
    assert.equal(await lock.acquire('k', 1000), null);
    await first!();
    const second = await lock.acquire('k', 1000);
    assert.ok(second);
    await second!();
    await lock.close();
  });

  it('expires stale holders', async () => {
    const lock = new MemoryLock();
    assert.ok(await lock.acquire('k', 30));
    await new Promise((r) => setTimeout(r, 50));
    const again = await lock.acquire('k', 1000);
    assert.ok(again);
    await again!();
    await lock.close();
  });
});

describe('MemoryCounter', () => {
  it('counts within a window and resets after', async () => {
    const c = new MemoryCounter();
    assert.equal(await c.inc('k', 40), 1);
    assert.equal(await c.inc('k', 40), 2);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(await c.inc('k', 40), 1);
    await c.close();
  });
});
