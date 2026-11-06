import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '@sentinel/config';
import {
  cancelScheduledAction,
  claimDueActions,
  closePool,
  ensureUserByTelegram,
  ensureWallet,
  finishAction,
  listScheduledActions,
  scheduleAction,
} from './index';

loadEnv(process.cwd());

const live = process.env.DATABASE_URL ? it : it.skip;

describe('scheduled actions', () => {
  live('schedule -> claim -> done, with ownership and retry cap', async () => {
    const user = await ensureUserByTelegram(`sched-${Date.now()}`);
    const stranger = await ensureUserByTelegram(`sched-str-${Date.now()}`);
    const wallet = await ensureWallet(user.id, 'solana', `SchedAddr${Date.now()}`);

    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 3600_000);
    const due = await scheduleAction({ userId: user.id, walletId: wallet.id, kind: 'reminder', message: 'ping', runAt: past });
    await scheduleAction({ userId: user.id, kind: 'reminder', message: 'later', runAt: future });
    assert.equal((await listScheduledActions(user.id)).length, 2);

    // Only the due one is claimed.
    const claimed = await claimDueActions(10);
    assert.ok(claimed.some((c) => c.id === due.id));
    assert.equal(claimed.filter((c) => c.user_id === user.id).length, 1);
    await finishAction(due.id, 'done');

    // Cancel enforces ownership and pending-only.
    assert.equal(await cancelScheduledAction(due.id, user.id), null);
    const pending = (await listScheduledActions(user.id)).find((r) => r.message === 'later')!;
    assert.equal(await cancelScheduledAction(pending.id, stranger.id), null);
    const cancelled = await cancelScheduledAction(pending.id, user.id);
    assert.equal(cancelled?.status, 'cancelled');

    // Failed actions retry until the cap.
    const flaky = await scheduleAction({ userId: user.id, kind: 'research', message: 'q', runAt: past });
    await claimDueActions(10);
    await finishAction(flaky.id, 'failed', 'boom');
    assert.ok((await claimDueActions(10)).some((c) => c.id === flaky.id));
    await finishAction(flaky.id, 'failed', 'boom');
    assert.ok(!(await claimDueActions(10)).some((c) => c.id === flaky.id));
    await closePool();
  });
});
