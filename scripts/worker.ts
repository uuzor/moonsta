import { loadEnv } from '@sentinel/config';
import { runWorker } from '@sentinel/worker';

loadEnv();

function usage(): never {
  console.error(
    'Usage: npm run worker -- [--once] [--live] [--interval-ms N]\n' +
      '  Default is DRY-RUN (quote + build + simulate, never send). Pass --live to send.',
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) usage();
  const i = args.indexOf('--interval-ms');
  const intervalMs = i >= 0 ? Number(args[i + 1]) : 15000;
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    console.error('--interval-ms must be >= 1000');
    process.exit(2);
  }
  await runWorker({
    intervalMs,
    dryRun: !args.includes('--live'),
    once: args.includes('--once'),
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
