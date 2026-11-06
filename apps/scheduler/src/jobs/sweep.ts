import { enqueueReaction, expirePendingProposals } from '@sentinel/db';
import { registerJob } from '@sentinel/jobs';

export function registerSweepJob(): void {
  registerJob({
    name: 'sweep-proposals',
    description: 'Expire stale pending proposals so nothing approves by accident later.',
    cron: '* * * * *',
    run: async () => {
      const expired = await expirePendingProposals();
      for (const row of expired) {
        await enqueueReaction({
          userId: row.user_id,
          walletId: row.wallet_id,
          kind: 'proposal_expired',
          notifyPolicy: 'notify_first',
          payload: { proposalId: row.id, proposalKind: row.kind, proposal: row.payload },
        });
      }
      return { ok: true, summary: `expired ${expired.length} proposal(s), ${expired.length} notified` };
    },
  });
}
