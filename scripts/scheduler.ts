import { loadEnv } from '@sentinel/config';
import { closePool, recentRuns } from '@sentinel/db';
import { createScheduler, listJobs, runJobWithMonitoring } from '@sentinel/jobs';
import { registerAllJobs } from '@sentinel/scheduler';

loadEnv();

function limitArg(argv: string[], fallback: number): number {
  const i = argv.indexOf('--limit');
  return i >= 0 ? Number(argv[i + 1] ?? fallback) : fallback;
}

async function main(): Promise<void> {
  registerAllJobs();
  const [cmd, arg] = process.argv.slice(2);

  if (cmd === '--list') {
    for (const job of listJobs()) {
      console.log(`${job.name}  [${job.cron}]\n  ${job.description}`);
    }
    return;
  }

  if (cmd === '--once') {
    if (!arg) throw new Error('Usage: npm run scheduler -- --once <job-name>');
    const result = await runJobWithMonitoring(arg, 'manual');
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  if (cmd === 'runs') {
    const name = arg && arg !== '--limit' ? arg : undefined;
    const rows = await recentRuns(name, limitArg(process.argv.slice(2), 10));
    for (const row of rows) {
      console.log(
        `${row.started_at}  ${row.job_name}  ${row.status}  ${[row.summary, row.error].filter(Boolean).join(' | ')}`,
      );
    }
    return;
  }

  // Daemon (default).
  const scheduler = createScheduler();
  const stop = await scheduler.start();
  console.log('Scheduler running. Jobs:');
  for (const job of listJobs()) console.log(`  ${job.name}  [${job.cron}]`);
  const shutdown = async () => {
    await stop();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  await new Promise(() => {}); // park until signal
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (process.argv[2] !== undefined) void closePool();
  });
