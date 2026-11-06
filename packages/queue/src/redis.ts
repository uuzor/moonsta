import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { Counter, Lock, TurnHandler, TurnJob, TurnOutcome, TurnQueue } from './types';

/** Production drivers over Redis. Untested in this sandbox (no daemon); exercised via Compose. */
export class BullMqTurnQueue implements TurnQueue {
  private queue: Queue<TurnJob, TurnOutcome>;

  constructor(
    private url: string,
    private queueName = 'agent-turns',
  ) {
    this.queue = new Queue<TurnJob, TurnOutcome>(queueName, { connection: { url } });
  }

  async enqueue(job: TurnJob): Promise<string> {
    const j = await this.queue.add('turn', job, {
      attempts: 1,
      removeOnComplete: 200,
      removeOnFail: 200,
    });
    return j.id ?? '';
  }

  async process(handler: TurnHandler): Promise<() => Promise<void>> {
    const worker = new Worker<TurnJob, TurnOutcome>(this.queueName, (job) => handler(job.data), {
      connection: { url: this.url },
      concurrency: 4,
    });
    worker.on('error', (e) => console.error('turn worker error:', e.message));
    return async () => {
      await worker.close();
    };
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

const RELEASE_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export class RedisLock implements Lock {
  private redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 3 });
  }

  async acquire(key: string, ttlMs: number): Promise<(() => Promise<void>) | null> {
    const token = `${Date.now()}-${Math.random()}`;
    const ok = await this.redis.set(`lock:${key}`, token, 'PX', ttlMs, 'NX');
    if (ok !== 'OK') return null;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await this.redis.eval(RELEASE_LUA, 1, `lock:${key}`, token);
    };
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}

export class RedisCounter implements Counter {
  private redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 3 });
  }

  async inc(key: string, windowMs: number): Promise<number> {
    const k = `ctr:${key}`;
    const n = await this.redis.incr(k);
    if (n === 1) await this.redis.pexpire(k, windowMs);
    return n;
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}
