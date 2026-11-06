import path from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { loadEnv, optional } from '@sentinel/config';
import { closePool } from '@sentinel/db';
import { registerAdapter } from '@sentinel/chain';
import { solanaAdapter } from '@sentinel/chain-solana';
import { createApi } from './routes';

export * from './auth';
export * from './routes';

const DIST = path.resolve(__dirname, '../dist');

export function createApp() {
  registerAdapter(solanaAdapter);
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.route('/api', createApi());
  app.use('/*', serveStatic({ root: DIST }));
  app.get('*', serveStatic({ root: DIST, path: 'index.html' }));
  return app;
}

export async function startWebServer(port: number = Number(optional('PORT', '3000'))): Promise<() => Promise<void>> {
  const app = createApp();
  console.log(`[web] serving ${DIST} + /api on :${port}`);
  const server = serve({ fetch: app.fetch, port });
  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    server.close();
    await closePool();
  };
}

async function main(): Promise<void> {
  loadEnv();
  const stop = await startWebServer();
  console.log('[web] running (Ctrl+C to stop)');
  const shutdown = async () => {
    console.log('[web] shutting down');
    await stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  await new Promise(() => {});
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
