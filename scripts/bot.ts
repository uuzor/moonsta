import { loadEnv } from '@sentinel/config';
import { startBotApp } from '@sentinel/bot';

loadEnv();

async function main(): Promise<void> {
  const stop = await startBotApp();
  console.log('[bot] running (Ctrl+C to stop)');
  const shutdown = async () => {
    console.log('[bot] shutting down');
    await stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
