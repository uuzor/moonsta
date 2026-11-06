import { optional } from '@sentinel/config';
import {
  appendMessage,
  dailyTokensUsed,
  ensureUserByTelegram,
  getBudget,
  recordUsage,
  recentMessages,
} from '@sentinel/db';
import { Counter, Lock, TurnJob, TurnOutcome, TurnQueue } from '@sentinel/queue';
import { TurnMessage, TurnResult, runTurn } from './run';
import { ToolContext } from './tools';

export type TurnSender = (text: string) => Promise<void>;
export type TurnRunner = (ctx: ToolContext, messages: TurnMessage[]) => Promise<TurnResult>;

export interface PipelineDeps {
  lock: Lock;
  counter: Counter;
  runTurnFn?: TurnRunner;
  historyLimit?: number;
  lockTtlMs?: number;
}

/**
 * One queued turn: rate limit -> budget -> per-user lock -> history -> model
 * -> persist (messages + usage) -> reply. The lock serializes each user's
 * turns so conversations never interleave and proposals never double-fire.
 */
export async function processTurn(
  deps: PipelineDeps,
  job: TurnJob,
  send: TurnSender,
): Promise<TurnOutcome> {
  const user = await ensureUserByTelegram(job.telegramId);
  const budget = await getBudget(user.id);

  const hits = await deps.counter.inc(`turn:${user.id}`, 60_000);
  if (hits > budget.turns_per_minute) {
    await send("You're sending messages too fast — give me a few seconds and try again.");
    return { ok: false, error: 'rate_limited' };
  }

  const used = await dailyTokensUsed(user.id);
  if (used >= budget.daily_token_cap) {
    await send('You have reached your daily usage limit. It resets within 24 hours.');
    return { ok: false, error: 'budget_exhausted' };
  }

  const ttl = deps.lockTtlMs ?? Number(optional('TURN_LOCK_TTL_MS', '300000'));
  const release = await deps.lock.acquire(`turn:${user.id}`, ttl);
  if (!release) {
    await send("I'm still working on your last message — one moment.");
    return { ok: false, error: 'busy' };
  }
  try {
    const limit = deps.historyLimit ?? Number(optional('TURN_HISTORY_LIMIT', '40'));
    const history = await recentMessages(user.id, limit);
    await appendMessage({ userId: user.id, role: 'user', content: job.text });
    const messages: TurnMessage[] = [
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: 'user' as const, content: job.text },
    ];
    const run = deps.runTurnFn ?? ((ctx, msgs) => runTurn(ctx, msgs));
    const result = await run({ telegramId: job.telegramId }, messages);
    await appendMessage({
      userId: user.id,
      role: 'assistant',
      content: result.text,
      toolNames: result.toolNames,
      tokensIn: result.inputTokens,
      tokensOut: result.outputTokens,
    });
    await recordUsage({
      userId: user.id,
      model: result.modelId,
      tokensIn: result.inputTokens,
      tokensOut: result.outputTokens,
    });
    await send(result.text);
    return { ok: true };
  } catch (e) {
    await send('Something went wrong on my side — please try again.');
    return { ok: false, error: (e as Error).message };
  } finally {
    await release();
  }
}

/** Consume the turn queue with the pipeline (bot workers use this). */
export async function serveTurns(
  deps: PipelineDeps & { queue: TurnQueue },
  senderFor: (telegramId: string) => TurnSender,
): Promise<() => Promise<void>> {
  return deps.queue.process((job) => processTurn(deps, job, senderFor(job.telegramId)));
}
