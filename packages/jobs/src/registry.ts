import type { JobDefinition } from './types';

const jobs = new Map<string, JobDefinition>();

export function registerJob(def: JobDefinition): void {
  if (jobs.has(def.name)) throw new Error(`Job already registered: ${def.name}`);
  const fields = def.cron?.trim().split(/\s+/).length ?? 0;
  if (fields !== 5 && fields !== 6) {
    throw new Error(`Job ${def.name}: cron must be a 5-field (or 6-field with seconds) expression`);
  }
  jobs.set(def.name, def);
}

export function getJob(name: string): JobDefinition {
  const job = jobs.get(name);
  if (!job) throw new Error(`Unknown job: ${name}`);
  return job;
}

export function listJobs(): JobDefinition[] {
  return [...jobs.values()];
}

/** Test-only escape hatch. */
export function __clearJobs(): void {
  jobs.clear();
}
