import {
  claimReactions,
  finishReaction,
  getProposal,
  getUserTelegramId,
  insertAuditEvent,
} from '@sentinel/db';
import { registerJob } from '@sentinel/jobs';
import { createLock } from '@sentinel/queue';
import { runReactionTurn, type ReactionDeps } from '@sentinel/agent';
import { defaultSender } from '@sentinel/bot';

export interface DrainDeps {
  lock?: ReactionDeps['lock'];
  runTurnFn?: ReactionDeps['runTurnFn'];
  /** Defaults to console; the Telegram bot step swaps in real delivery. */
  send?: (telegramId: string, text: string) => Promise<void>;
  batch?: number;
}

let sharedLock: ReactionDeps['lock'] | null = null;

export async function drainReactions(deps: DrainDeps = {}): Promise<{
  claimed: number;
  sent: number;
  requeued: number;
  failed: number;
}> {
  const lock = deps.lock ?? (sharedLock ?? (sharedLock = createLock()));
  const sender = defaultSender();
  const send = deps.send ?? ((tag: string, text: string) => sender.sendText(tag, text));
  const out = { claimed: 0, sent: 0, requeued: 0, failed: 0 };
  const events = await claimReactions(deps.batch ?? 10);
  out.claimed = events.length;
  for (const event of events) {
    const telegramId = await getUserTelegramId(event.user_id);
    if (telegramId == null) {
      await finishReaction(event.id, 'failed', 'user has no linked telegram id');
      out.failed += 1;
      continue;
    }
    // Proposals go out as ONE message: the AI explanation with Approve/Reject
    // buttons attached. The turn text is captured instead of sent directly.
    if (event.kind === 'proposal_created' && deps.send == null) {
      const created = (event.payload ?? {}) as { proposalId?: string };
      const proposal = created.proposalId ? await getProposal(created.proposalId) : null;
      if (!proposal || proposal.status !== 'pending') {
        await finishReaction(event.id, 'sent');
        await insertAuditEvent({
          walletId: event.wallet_id,
          actor: 'agent',
          action: 'reaction_skipped_stale',
          detail: { eventId: event.id, proposalId: created.proposalId ?? null },
        });
        out.sent += 1;
        continue;
      }
      let captured = '';
      const res = await runReactionTurn({ lock, runTurnFn: deps.runTurnFn }, event, telegramId, async (t) => {
        captured = t;
      });
      const payload = (event.payload ?? {}) as { proposalId?: string; proposalKind?: string };
      if (res.ok && payload.proposalId) {
        await sender.sendProposal(telegramId, {
          id: payload.proposalId,
          kind: payload.proposalKind ?? '?',
          text: captured,
        });
        await finishReaction(event.id, 'sent');
        await insertAuditEvent({
          walletId: event.wallet_id,
          actor: 'agent',
          action: 'reaction_sent',
          detail: { eventId: event.id, kind: event.kind, policy: event.notify_policy },
        });
        out.sent += 1;
      } else if (!res.ok && res.error === 'busy') {
        await finishReaction(event.id, 'requeue');
        out.requeued += 1;
      } else {
        await finishReaction(event.id, 'failed', res.error ?? 'missing proposal id');
        out.failed += 1;
      }
      continue;
    }
    const res = await runReactionTurn(
      { lock, runTurnFn: deps.runTurnFn },
      event,
      telegramId,
      (text) => send(telegramId, text),
    );
    if (res.ok) {
      await finishReaction(event.id, 'sent');
      await insertAuditEvent({
        walletId: event.wallet_id,
        actor: 'agent',
        action: 'reaction_sent',
        detail: { eventId: event.id, kind: event.kind, policy: event.notify_policy },
      });
      out.sent += 1;
    } else if (res.error === 'busy') {
      await finishReaction(event.id, 'requeue');
      out.requeued += 1;
    } else {
      await finishReaction(event.id, 'failed', res.error);
      out.failed += 1;
    }
  }
  return out;
}

export function registerDrainJob(): void {
  registerJob({
    name: 'drain-reactions',
    description: 'Deliver queued reaction events as AI chat turns (notify_first / act_then_notify).',
    cron: '* * * * *',
    run: async () => {
      const out = await drainReactions();
      return {
        ok: true,
        summary: `claimed ${out.claimed}, sent ${out.sent}, requeued ${out.requeued}, failed ${out.failed}`,
      };
    },
  });
}
