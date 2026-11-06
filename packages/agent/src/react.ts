import { optional } from '@sentinel/config';
import {
  appendMessage,
  dailyTokensUsed,
  getBudget,
  recordUsage,
  recentMessages,
  type NotifyPolicy,
  type ReactionEvent,
} from '@sentinel/db';
import type { Lock, TurnOutcome } from '@sentinel/queue';
import type { TurnSender, TurnRunner } from './pipeline';
import { TurnMessage, TurnResult, runTurn } from './run';

export interface ReactionDeps {
  lock: Lock;
  runTurnFn?: TurnRunner;
  historyLimit?: number;
  lockTtlMs?: number;
}

const REACTION_SYSTEM: Record<NotifyPolicy, string> = {
  notify_first: `You are Moonsta, a crypto guardian living in chat. An automated guard just triggered and took NO action on its own. Tell the user what happened in 2-4 short sentences with the key numbers, then propose the concrete next step. If acting needs their approval, say what you will prepare once they confirm (your swap tool only creates proposals, never sends). Never claim you moved funds. Keep it chat-short, no tool calls unless you need a live fact for the message.`,
  act_then_notify: `You are Moonsta, a crypto guardian living in chat. A guard just fired and the system already acted within the user's pre-authorized limits. Report what triggered and exactly what was done (amounts, prices, transaction id). Then suggest sensible follow-ups, e.g. re-arming the guard. Keep it chat-short, no tool calls unless you need a live fact for the message.`,
};

interface RuleFiredPayload {
  ruleId?: string;
  kind?: string;
  asset?: string;
  price?: number;
  actionTaken?: string;
  amountRaw?: string;
  outAmount?: string;
  signature?: string | null;
  reason?: string;
}

/** Deterministic event context fed to the model (ephemeral: never persisted as chat). */
export function describeEvent(event: ReactionEvent): string {
  if (event.kind === 'scheduled_fired') {
    const p = (event.payload ?? {}) as { actionKind?: string; message?: string; result?: string | null };
    const lines = [
      `SYSTEM EVENT (scheduled_fired, policy ${event.notify_policy}):`,
      `- the user's scheduled ${p.actionKind ?? 'action'} "${p.message ?? ''}" just fired.`,
    ];
    if (p.actionKind === 'research') {
      lines.push('- use your tools to research this NOW (prices, portfolio, risk, quotes) and deliver the brief. Never invent data: only report what tools return.');
    } else if (p.result) {
      lines.push(`- measured result: ${p.result}`);
    }
    lines.push('- tell the user the outcome plainly with numbers; propose a sensible next step if one exists.');
    return lines.join('\n');
  }
  if (event.kind === 'proposal_created') {
    const p = (event.payload ?? {}) as { proposalId?: string; proposalKind?: string; proposal?: unknown };
    return [
      `SYSTEM EVENT (proposal_created, policy ${event.notify_policy}):`,
      `- proposal ${p.proposalId ?? '?'} (${p.proposalKind ?? '?'}) was created and is awaiting the user's approval.`,
      `- proposal detail: ${JSON.stringify(p.proposal ?? null)}`,
      `- the user approves with the Approve button attached to your message, or rejects. Do not claim it executed.`,
    ].join('\n');
  }
  if (event.kind === 'proposal_expired') {
    const p = (event.payload ?? {}) as { proposalId?: string; proposalKind?: string; proposal?: unknown };
    return [
      `SYSTEM EVENT (proposal_expired, policy ${event.notify_policy}):`,
      `- proposal ${p.proposalId ?? '?'} (${p.proposalKind ?? '?'}) expired before approval; nothing was executed.`,
      `- proposal detail: ${JSON.stringify(p.proposal ?? null)}`,
    ].join('\n');
  }
  const p = (event.payload ?? {}) as RuleFiredPayload;
  const lines = [
    `SYSTEM EVENT (rule_fired, policy ${event.notify_policy}):`,
    `- rule ${p.ruleId ?? '?'} (${p.kind ?? '?'} on ${p.asset ?? '?'}) fired at price ${p.price ?? '?'}.`,
  ];
  switch (p.actionTaken) {
    case 'swap':
      lines.push(
        `- action taken: pre-authorized swap executed, amountRaw ${p.amountRaw}, outAmount ${p.outAmount}, signature ${p.signature ?? 'dry-run/none'}.`,
      );
      break;
    case 'alert':
      lines.push('- action taken: none (alert-only rule).');
      break;
    case 'downgraded':
      lines.push(`- action taken: none, downgraded to alert. Reason: ${p.reason ?? 'unknown'}.`);
      break;
    case 'denied':
      lines.push(`- action taken: BLOCKED by policy, nothing moved. Reason: ${p.reason ?? 'unknown'}.`);
      break;
    case 'skipped_empty':
      lines.push(`- action taken: none, agent wallet holds none of the asset.`);
      break;
    default:
      lines.push(`- action taken: ${p.actionTaken ?? 'unknown'}.`);
  }
  return lines.join('\n');
}

/**
 * One reaction turn: budget -> per-user lock (shared with chat turns, so a
 * reaction never interleaves with the user's own conversation) -> model ->
 * persist assistant message + usage -> send. The event context is ephemeral;
 * only the assistant's notification lands in history.
 */
export async function runReactionTurn(
  deps: ReactionDeps,
  event: ReactionEvent,
  telegramId: string,
  send: TurnSender,
): Promise<TurnOutcome> {
  const budget = await getBudget(event.user_id);
  const used = await dailyTokensUsed(event.user_id);
  if (used >= budget.daily_token_cap) {
    await send('You have reached your daily usage limit, so I could not prepare this alert. It resets within 24 hours.');
    return { ok: true };
  }

  const ttl = deps.lockTtlMs ?? Number(optional('TURN_LOCK_TTL_MS', '300000'));
  const release = await deps.lock.acquire(`turn:${event.user_id}`, ttl);
  if (!release) return { ok: false, error: 'busy' };
  try {
    const limit = deps.historyLimit ?? Number(optional('TURN_HISTORY_LIMIT', '40'));
    const history = await recentMessages(event.user_id, limit);
    const messages: TurnMessage[] = [
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: 'user' as const, content: describeEvent(event) },
    ];
    // Test stubs take (ctx, msgs); the real path binds the reaction system prompt.
    const result: TurnResult =
      deps.runTurnFn != null
        ? await deps.runTurnFn({ telegramId }, messages)
        : await runTurn({ telegramId }, messages, REACTION_SYSTEM[event.notify_policy]);
    await appendMessage({
      userId: event.user_id,
      role: 'assistant',
      content: result.text,
      toolNames: result.toolNames,
      tokensIn: result.inputTokens,
      tokensOut: result.outputTokens,
    });
    await recordUsage({
      userId: event.user_id,
      model: result.modelId,
      tokensIn: result.inputTokens,
      tokensOut: result.outputTokens,
    });
    await send(result.text);
    return { ok: true };
  } catch (e) {
    // Silent failure: the drain job retries with backoff; the user is never spammed.
    return { ok: false, error: (e as Error).message };
  } finally {
    await release();
  }
}
