import { registerAdapter } from '@sentinel/chain';
import { solanaAdapter } from '@sentinel/chain-solana';
import { createScheduler } from '@sentinel/jobs';
import { registerDigestJob } from './jobs/digest';
import { registerDrainJob } from './jobs/drain';
import { registerDueJob } from './jobs/due';
import { registerSnapshotJob } from './jobs/snapshot';
import { registerSweepJob } from './jobs/sweep';

export function registerAllJobs(): void {
  registerAdapter(solanaAdapter);
  registerSweepJob();
  registerSnapshotJob();
  registerDrainJob();
  registerDueJob();
  registerDigestJob();
}

async function main(): Promise<void> {
  registerAllJobs();
  const scheduler = createScheduler();
  const stop = await scheduler.start();
  const shutdown = async () => {
    console.log('[scheduler] shutting down');
    await stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  console.log('[scheduler] running (Ctrl+C to stop)');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
