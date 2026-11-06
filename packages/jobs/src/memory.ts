import { Cron } from 'croner';
import { listJobs } from './registry';
import { runJobWithMonitoring, type RunRecorder } from './runner';
import type { JobResult, SchedulerDriver } from './types';

/** In-process cron scheduler (default). Cron loops only; execution stays idempotent. */
export class MemoryScheduler implements SchedulerDriver {
  private crons: Cron[] = [];
  private started = false;

  constructor(private readonly recorder?: RunRecorder) {}

  async start(): Promise<() => Promise<void>> {
    if (this.started) throw new Error('Scheduler already started');
    this.started = true;
    for (const job of listJobs()) {
      this.crons.push(
        new Cron(
          job.cron,
          { timezone: 'UTC' },
          () => {
            void runJobWithMonitoring(job.name, 'scheduled', this.recorder);
          },
        ),
      );
    }
    console.log(`[scheduler] started ${this.crons.length} cron job(s) (memory driver)`);
    return async () => this.close();
  }

  async trigger(name: string): Promise<JobResult> {
    return runJobWithMonitoring(name, 'manual', this.recorder);
  }

  async close(): Promise<void> {
    for (const cron of this.crons) cron.stop();
    this.crons = [];
    this.started = false;
  }
}
