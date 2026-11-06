import { Queue, Worker, type Job } from 'bullmq';
import { optional } from '@sentinel/config';
import { listJobs } from './registry';
import { runJobWithMonitoring, type RunRecorder } from './runner';
import type { JobResult, SchedulerDriver } from './types';

function connection() {
  return { connection: { url: optional('REDIS_URL', 'redis://localhost:6379'), maxRetriesPerRequest: null } };
}

/**
 * Redis/BullMQ scheduler (opt-in via QUEUE_DRIVER=redis). Durable repeatable
 * jobs plus a worker in the same process; scale by running N scheduler
 * processes (BullMQ dedupes repeatable fires per job name).
 */
export class BullMqScheduler implements SchedulerDriver {
  private queue?: Queue;
  private worker?: Worker;
  private started = false;

  constructor(private readonly recorder?: RunRecorder) {}

  async start(): Promise<() => Promise<void>> {
    if (this.started) throw new Error('Scheduler already started');
    this.started = true;
    const opts = connection();
    this.queue = new Queue('scheduled-jobs', opts);
    this.worker = new Worker(
      'scheduled-jobs',
      async (job: Job<{ name: string; invocation: 'scheduled' | 'manual' }>) => {
        await runJobWithMonitoring(job.data.name, job.data.invocation, this.recorder);
      },
      { ...opts, concurrency: 2 },
    );
    for (const job of listJobs()) {
      await this.queue.add(
        job.name,
        { name: job.name, invocation: 'scheduled' },
        { repeat: { pattern: job.cron }, jobId: `repeat:${job.name}`, removeOnComplete: 50, removeOnFail: 50 },
      );
    }
    console.log(`[scheduler] started ${listJobs().length} repeatable job(s) (bullmq driver)`);
    return async () => this.close();
  }

  async trigger(name: string): Promise<JobResult> {
    if (!this.queue) throw new Error('Scheduler not started');
    // Manual fires return after enqueue; completion is tracked in job_runs.
    await this.queue.add(`manual:${name}:${Date.now()}`, { name, invocation: 'manual' as const });
    return { ok: true, summary: `enqueued manual fire of ${name}` };
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    this.worker = undefined;
    this.queue = undefined;
    this.started = false;
  }
}
