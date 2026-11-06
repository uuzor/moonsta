export interface JobResult {
  ok: boolean;
  summary?: string;
}

export interface JobContext {
  /** Manual (`trigger`/CLI) or scheduled (cron) fire. */
  invocation: 'scheduled' | 'manual';
  log: (message: string) => void;
}

export interface JobDefinition {
  name: string;
  description: string;
  /** 5-field cron expression (6-field with leading seconds also accepted). */
  cron: string;
  run: (ctx: JobContext) => Promise<JobResult>;
}

export interface SchedulerDriver {
  /** Start cron loops. Resolves to a stop function. */
  start(): Promise<() => Promise<void>>;
  /** Fire one job immediately (manual invocation). */
  trigger(name: string): Promise<JobResult>;
  close(): Promise<void>;
}
