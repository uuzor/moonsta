import { getPool } from './pool';

export type ScheduledKind = 'reminder' | 'balance_check' | 'research';
export type ScheduledStatus = 'pending' | 'claimed' | 'done' | 'failed' | 'cancelled';

export interface ScheduledAction {
  id: string;
  user_id: string;
  wallet_id: string | null;
  kind: ScheduledKind;
  message: string;
  params: unknown;
  run_at: string;
  status: ScheduledStatus;
  attempts: number;
  created_at: string;
  finished_at: string | null;
}

export async function scheduleAction(input: {
  userId: string;
  walletId?: string;
  kind: ScheduledKind;
  message: string;
  params?: unknown;
  runAt: Date;
}): Promise<ScheduledAction> {
  const { rows } = await getPool().query<ScheduledAction>(
    `INSERT INTO scheduled_actions (user_id, wallet_id, kind, message, params, run_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, wallet_id, kind, message, params, run_at,
               status, attempts, created_at, finished_at`,
    [input.userId, input.walletId ?? null, input.kind, input.message, JSON.stringify(input.params ?? {}), input.runAt.toISOString()],
  );
  return rows[0];
}

export async function listScheduledActions(userId: string, limit = 20): Promise<ScheduledAction[]> {
  const { rows } = await getPool().query<ScheduledAction>(
    `SELECT id, user_id, wallet_id, kind, message, params, run_at,
            status, attempts, created_at, finished_at
     FROM scheduled_actions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

/** Cancel a pending action. Returns null when it isn't yours or isn't pending. */
export async function cancelScheduledAction(id: string, userId: string): Promise<ScheduledAction | null> {
  const { rows } = await getPool().query<ScheduledAction>(
    `UPDATE scheduled_actions SET status = 'cancelled', finished_at = now()
     WHERE id = $1 AND user_id = $2 AND status = 'pending'
     RETURNING id, user_id, wallet_id, kind, message, params, run_at,
               status, attempts, created_at, finished_at`,
    [id, userId],
  );
  return rows[0] ?? null;
}

/** Claim due actions: fresh pending ones plus failed ones below the retry cap. */
export async function claimDueActions(limit: number): Promise<ScheduledAction[]> {
  const { rows } = await getPool().query<ScheduledAction>(
    `UPDATE scheduled_actions a SET status = 'claimed'
     FROM (
       SELECT id FROM scheduled_actions
       WHERE run_at <= now() AND (status = 'pending' OR (status = 'failed' AND attempts < 2))
       ORDER BY run_at LIMIT $1
       FOR UPDATE SKIP LOCKED
     ) c
     WHERE a.id = c.id
     RETURNING a.id, a.user_id, a.wallet_id, a.kind, a.message, a.params, a.run_at,
               a.status, a.attempts, a.created_at, a.finished_at`,
    [limit],
  );
  return rows;
}

export async function finishAction(id: string, outcome: 'done' | 'failed', error?: string): Promise<void> {
  await getPool().query(
    `UPDATE scheduled_actions SET status = $2, attempts = attempts + 1, finished_at = now() WHERE id = $1`,
    [id, outcome],
  );
  if (error) {
    await getPool().query(
      `UPDATE scheduled_actions SET params = params || jsonb_build_object('last_error', $2::text) WHERE id = $1`,
      [id, error],
    );
  }
}
