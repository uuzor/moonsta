import { Counter, Lock, TurnHandler, TurnJob, TurnQueue } from './types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Single-process drivers for sandbox, tests, and demos. Jobs do not survive restart. */
export class MemoryTurnQueue implements TurnQueue {
  private jobs: TurnJob[] = [];
  private stopped = true;
  private pollers: Promise<void>[] = [];
  private seq = 0;

  constructor(
    private concurrency = 2,
    private pollMs = 25,
  ) {}

  async enqueue(job: TurnJob): Promise<string> {
    this.jobs.push(job);
    return `mem-${++this.seq}`;
  }

  async process(handler: TurnHandler): Promise<() => Promise<void>> {
    this.stopped = false;
    for (let i = 0; i < this.concurrency; i++) {
      this.pollers.push(this.poll(handler));
    }
    return async () => {
      this.stopped = true;
      await Promise.all(this.pollers);
      this.pollers = [];
    };
  }

  private async poll(handler: TurnHandler): Promise<void> {
    while (!this.stopped) {
      const next = this.jobs.shift();
      if (!next) {
        await sleep(this.pollMs);
        continue;
      }
      try {
        await handler(next);
      } catch (e) {
        console.error('turn handler failed:', e instanceof Error ? e.message : e);
      }
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    await Promise.all(this.pollers);
    this.pollers = [];
  }
}

export class MemoryLock implements Lock {
  private held = new Map<string, { exp: number; token: string }>();

  async acquire(key: string, ttlMs: number): Promise<(() => Promise<void>) | null> {
    const now = Date.now();
    const cur = this.held.get(key);
    if (cur && cur.exp > now) return null;
    const token = `${now}-${Math.random()}`;
    this.held.set(key, { exp: now + ttlMs, token });
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      if (this.held.get(key)?.token === token) this.held.delete(key);
    };
  }

  async close(): Promise<void> {}
}

export class MemoryCounter implements Counter {
  private counts = new Map<string, { n: number; resetAt: number }>();

  async inc(key: string, windowMs: number): Promise<number> {
    const now = Date.now();
    const cur = this.counts.get(key);
    if (!cur || cur.resetAt <= now) {
      this.counts.set(key, { n: 1, resetAt: now + windowMs });
      return 1;
    }
    cur.n += 1;
    return cur.n;
  }

  async close(): Promise<void> {}
}
