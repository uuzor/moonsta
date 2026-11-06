import { getPool } from './pool';

export type ReactionKind = 'rule_fired' | 'proposal_expired' | 'proposal_created' | 'scheduled_fired';
export type NotifyPolicy = 'notify_first' | 'act_then_notify';
export type ReactionStatus = 'pending' | 'sending' | 'sent' | 'failed';

export interface ReactionEvent {
  id: string;
  user_id: string;
  wallet_id: string | null;
  kind: ReactionKind;
  notify_policy: NotifyPolicy;
  payload: unknown;
  status: ReactionStatus;
  attempts: number;
  created_at: string;
  sent_at: string | null;
}

export interface EnqueueReactionInput {
  userId: string;
  walletId?: string;
  kind: ReactionKind;
  notifyPolicy: NotifyPolicy;
  payload: unknown;
}

export async function enqueueReaction(input: EnqueueReactionInput): Promise<ReactionEvent> {
  const { rows } = await getPool().query<ReactionEvent>(
    `INSERT INTO reaction_events (user_id, wallet_id, kind, notify_policy, payload)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, user_id, wallet_id, kind, notify_policy, payload,
               status, attempts, created_at, sent_at`,
    [input.userId, input.walletId ?? null, input.kind, input.notifyPolicy, JSON.stringify(input.payload)],
  );
  return rows[0];
}

/**
 * Claim up to `limit` events for delivery: fresh pending ones plus failed
 * ones below the retry cap (retried no sooner than 5 minutes after creation,
 * so a persistently failing event cannot spam the model every drain).
 */
export async function claimReactions(limit: number): Promise<ReactionEvent[]> {
  const { rows } = await getPool().query<ReactionEvent>(
    `UPDATE reaction_events e SET status = 'sending'
     FROM (
       SELECT id FROM reaction_events
       WHERE status = 'pending'
          OR (status = 'failed' AND attempts < 3 AND created_at < now() - interval '5 minutes')
       ORDER BY created_at LIMIT $1
       FOR UPDATE SKIP LOCKED
     ) c
     WHERE e.id = c.id
     RETURNING e.id, e.user_id, e.wallet_id, e.kind, e.notify_policy, e.payload,
               e.status, e.attempts, e.created_at, e.sent_at`,
    [limit],
  );
  return rows;
}

/** Terminal delivery outcome. `requeue` puts a busy/locked event back to pending. */
export async function finishReaction(
  id: string,
  outcome: 'sent' | 'failed' | 'requeue',
  error?: string,
): Promise<void> {
  if (outcome === 'requeue') {
    await getPool().query(`UPDATE reaction_events SET status = 'pending' WHERE id = $1`, [id]);
    return;
  }
  await getPool().query(
    `UPDATE reaction_events
     SET status = $2, attempts = attempts + 1, sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END
     WHERE id = $1`,
    // attempts counts delivery tries; errors are recorded on the payload for inspection
    [id, outcome],
  );
  if (error) {
    await getPool().query(
      `UPDATE reaction_events SET payload = payload || jsonb_build_object('last_error', $2::text) WHERE id = $1`,
      [id, error],
    );
  }
}

/** Route an event to chat. Null telegram id = user never linked Telegram. */
export async function getUserTelegramId(userId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ telegram_id: string | null }>(
    `SELECT telegram_id FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0]?.telegram_id ?? null;
}
