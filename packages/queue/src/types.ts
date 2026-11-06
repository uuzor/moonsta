export interface TurnJob {
  telegramId: string;
  text: string;
  enqueuedAt: string;
}

export interface TurnOutcome {
  ok: boolean;
  error?: string;
}

export type TurnHandler = (job: TurnJob) => Promise<TurnOutcome>;

/** FIFO turn queue. Replies travel via the handler's sender, not the queue. */
export interface TurnQueue {
  enqueue(job: TurnJob): Promise<string>;
  /** Start consuming; resolves to a stopper. */
  process(handler: TurnHandler): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

/** Distributed-ish mutex. Null when already held. */
export interface Lock {
  acquire(key: string, ttlMs: number): Promise<(() => Promise<void>) | null>;
  close(): Promise<void>;
}

/** Fixed-window counter for rate limits. */
export interface Counter {
  inc(key: string, windowMs: number): Promise<number>;
  close(): Promise<void>;
}
