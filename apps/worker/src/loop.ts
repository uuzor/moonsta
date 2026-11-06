import { optional } from '@sentinel/config';
import { closePool, ensureUserByTelegram, ensureWallet } from '@sentinel/db';
import { createConnection, loadAgentKeypair } from '@sentinel/chain-solana';
import { EvalSummary, evaluateOnce } from './evaluator';

export interface WorkerOptions {
  intervalMs: number;
  dryRun: boolean;
  once: boolean;
}

function formatSummary(s: EvalSummary): string {
  const parts = [`checked=${s.checked}`, `fired=${s.fired}`, `executed=${s.executed}`];
  if (s.skipped.length > 0) parts.push(`skipped=[${s.skipped.join(',')}]`);
  if (s.errors.length > 0) parts.push(`errors=[${s.errors.join(';')}]`);
  return parts.join(' ');
}

export async function runWorker(opts: WorkerOptions): Promise<void> {
  const connection = createConnection();
  const agent = loadAgentKeypair();
  // The agent wallet row (under the operator user) marks which watched
  // address the worker may actually move funds from. Anything else is
  // alert-only by construction.
  const user = await ensureUserByTelegram(optional('REPORT_USER', 'local-cli'));
  await ensureWallet(user.id, 'solana', agent.publicKey.toBase58(), 'agent', {
    isAgentWallet: true,
  });
  console.log(
    `worker up: agent=${agent.publicKey.toBase58()} mode=${opts.dryRun ? 'DRY-RUN' : 'LIVE'}`,
  );

  const tick = async () => {
    try {
      const summary = await evaluateOnce({ connection, agent, dryRun: opts.dryRun });
      console.log(`tick ${new Date().toISOString()} ${formatSummary(summary)}`);
    } catch (err) {
      console.error(`tick failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  if (opts.once) {
    await tick();
    await closePool();
    return;
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());

  await tick();
  const timer = setInterval(() => {
    if (!stopped) void tick();
  }, opts.intervalMs);
}
