import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '@sentinel/config';
import {
  claimReactions,
  closePool,
  createProposal,
  enqueueReaction,
  ensureUserByTelegram,
  ensureWallet,
  finishReaction,
  getPool,
  getUserTelegramId,
} from './index';

loadEnv(process.cwd());

const live = process.env.DATABASE_URL ? it : it.skip;

describe('reaction events', () => {
  live('enqueue -> claim -> sent, with gated retries', async () => {
    const user = await ensureUserByTelegram(`react-${Date.now()}`);
    assert.equal(await getUserTelegramId(user.id), user.telegram_id);

    const e1 = await enqueueReaction({
      userId: user.id,
      kind: 'rule_fired',
      notifyPolicy: 'notify_first',
      payload: { ruleId: 'r1', actionTaken: 'alert' },
    });
    assert.equal(e1.status, 'pending');

    const claimed = await claimReactions(10);
    assert.ok(claimed.some((c) => c.id === e1.id));
    await finishReaction(e1.id, 'sent');
    assert.ok(!(await claimReactions(10)).some((c) => c.id === e1.id));

    // Failed events are not retried immediately...
    const e2 = await enqueueReaction({
      userId: user.id,
      kind: 'proposal_expired',
      notifyPolicy: 'notify_first',
      payload: { proposalId: 'p1' },
    });
    await claimReactions(10);
    await finishReaction(e2.id, 'failed', 'boom');
    assert.ok(!(await claimReactions(10)).some((c) => c.id === e2.id));

    // ...but become claimable after the backoff window, until the retry cap.
    await getPool().query(`UPDATE reaction_events SET created_at = now() - interval '6 minutes' WHERE id = $1`, [
      e2.id,
    ]);
    assert.ok((await claimReactions(10)).some((c) => c.id === e2.id));
    await finishReaction(e2.id, 'failed', 'boom');
    await finishReaction(e2.id, 'failed', 'boom');
    assert.ok(!(await claimReactions(10)).some((c) => c.id === e2.id));

    // Busy events go back to pending without burning attempts.
    const e3 = await enqueueReaction({
      userId: user.id,
      kind: 'rule_fired',
      notifyPolicy: 'act_then_notify',
      payload: { ruleId: 'r3', actionTaken: 'swap' },
    });
    await claimReactions(10);
    await finishReaction(e3.id, 'requeue');
    const again = await claimReactions(10);
    const back = again.find((c) => c.id === e3.id);
    assert.ok(back);
    assert.equal(back.attempts, 0);
    await finishReaction(e3.id, 'sent');
    await closePool();
  });

  live('creating a proposal enqueues a proposal_created event', async () => {
    const user = await ensureUserByTelegram(`react-prop-${Date.now()}`);
    const wallet = await ensureWallet(user.id, 'solana', `PropAddr${Date.now()}`);
    const proposal = await createProposal(wallet.id, 'swap', { x: 1 }, new Date(Date.now() + 600_000));
    const claimed = await claimReactions(50);
    const found = claimed.find((c) => (c.payload as { proposalId?: string }).proposalId === proposal.id);
    assert.ok(found);
    assert.equal(found.kind, 'proposal_created');
    assert.equal(found.notify_policy, 'notify_first');
    await finishReaction(found.id, 'sent');
    await closePool();
  });
});
