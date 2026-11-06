import { loadEnv } from '@sentinel/config';
import { startWebServer } from '@sentinel/web';

loadEnv();

async function main(): Promise<void> {
  const stop = await startWebServer();
  const shutdown = async () => {
    console.log('[web] shutting down');
    await stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
