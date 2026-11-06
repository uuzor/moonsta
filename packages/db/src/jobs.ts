import { getPool } from './pool';

export interface JobRunRow {
  id: string;
  job_name: string;
  status: string;
  summary: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export async function startRun(jobName: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO job_runs (job_name, status) VALUES ($1, 'running') RETURNING id`,
    [jobName],
  );
  return rows[0].id;
}

export async function finishRun(
  id: string,
  status: 'ok' | 'failed',
  summary?: string,
  error?: string,
): Promise<void> {
  await getPool().query(
    `UPDATE job_runs SET status = $2, summary = $3, finished_at = now(), error = $4 WHERE id = $1`,
    [id, status, summary ?? null, error ?? null],
  );
}

export async function recentRuns(jobName: string | undefined, limit: number): Promise<JobRunRow[]> {
  const { rows } = await getPool().query<JobRunRow>(
    `SELECT id, job_name, status, summary, error, started_at, finished_at
     FROM job_runs WHERE ($1::text IS NULL OR job_name = $1)
     ORDER BY started_at DESC LIMIT $2`,
    [jobName ?? null, limit],
  );
  return rows;
}
