import { finishRun, startRun } from '@sentinel/db';
import { getJob, listJobs } from './registry';
import type { JobContext, JobResult } from './types';

export interface RunRecorder {
  start(jobName: string): Promise<string>;
  finish(id: string, status: 'ok' | 'failed', summary?: string, error?: string): Promise<void>;
}

const dbRecorder: RunRecorder = {
  start: (jobName) => startRun(jobName),
  finish: (id, status, summary, error) => finishRun(id, status, summary, error),
};

/**
 * Run one job with monitoring: records the run, catches all errors (a failing
 * job must never crash the scheduler loop), and returns a normalized result.
 */
export async function runJobWithMonitoring(
  name: string,
  invocation: JobContext['invocation'],
  recorder: RunRecorder = dbRecorder,
  log: (message: string) => void = console.log,
): Promise<JobResult> {
  const runId = await recorder.start(name);
  try {
    const result = await getJob(name).run({ invocation, log });
    await recorder.finish(runId, result.ok ? 'ok' : 'failed', result.summary);
    if (!result.ok) log(`[jobs] ${name} reported failure: ${result.summary ?? 'no summary'}`);
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await recorder.finish(runId, 'failed', undefined, error);
    log(`[jobs] ${name} threw: ${error}`);
    return { ok: false, summary: `threw: ${error}` };
  }
}

export function jobNames(): string[] {
  return listJobs().map((j) => j.name);
}
