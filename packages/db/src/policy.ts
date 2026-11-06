import { getPool } from './pool';
import { enqueueReaction } from './reactions';
import {
  PolicyRow,
  ProposalKind,
  ProposalRow,
  ProposalStatus,
  WithdrawalAddressRow,
} from './types';

export async function getPolicy(walletId: string): Promise<PolicyRow> {
  await getPool().query(`INSERT INTO policies (wallet_id) VALUES ($1) ON CONFLICT DO NOTHING`, [
    walletId,
  ]);
  const { rows } = await getPool().query<PolicyRow>(
    `SELECT wallet_id, daily_cap_usd, per_tx_cap_usd, paused, created_at, updated_at
     FROM policies WHERE wallet_id = $1`,
    [walletId],
  );
  return rows[0];
}

export async function setPolicyCaps(
  walletId: string,
  caps: { dailyCapUsd?: number; perTxCapUsd?: number },
): Promise<PolicyRow> {
  await getPolicy(walletId);
  const { rows } = await getPool().query<PolicyRow>(
    `UPDATE policies SET
       daily_cap_usd = COALESCE($2, daily_cap_usd),
       per_tx_cap_usd = COALESCE($3, per_tx_cap_usd),
       updated_at = now()
     WHERE wallet_id = $1
     RETURNING wallet_id, daily_cap_usd, per_tx_cap_usd, paused, created_at, updated_at`,
    [walletId, caps.dailyCapUsd ?? null, caps.perTxCapUsd ?? null],
  );
  return rows[0];
}

export async function setPaused(walletId: string, paused: boolean): Promise<void> {
  await getPolicy(walletId);
  await getPool().query(`UPDATE policies SET paused = $2, updated_at = now() WHERE wallet_id = $1`, [
    walletId,
    paused,
  ]);
}

/** Rolling 24h spend in USD across swaps, withdrawals, and perps. */
export async function dailySpendUsd(walletId: string): Promise<number> {
  const { rows } = await getPool().query<{ sum: string | null }>(
    `SELECT COALESCE(SUM(usd_amount), 0) AS sum FROM spend_ledger
     WHERE wallet_id = $1 AND created_at > now() - interval '24 hours'`,
    [walletId],
  );
  return Number(rows[0].sum ?? 0);
}

export async function recordSpend(
  walletId: string,
  usdAmount: number,
  kind: string,
  ref?: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO spend_ledger (wallet_id, usd_amount, kind, ref) VALUES ($1, $2, $3, $4)`,
    [walletId, usdAmount, kind, ref ?? null],
  );
}

export async function addWithdrawalAddress(
  walletId: string,
  address: string,
  label: string | undefined,
  cooldownMs: number,
): Promise<WithdrawalAddressRow> {
  const activeAt = new Date(Date.now() + cooldownMs).toISOString();
  const { rows } = await getPool().query<WithdrawalAddressRow>(
    `INSERT INTO withdrawal_addresses (wallet_id, address, label, status, active_at)
     VALUES ($1, $2, $3, 'pending', $4)
     ON CONFLICT (wallet_id, address) DO UPDATE SET
       label = COALESCE(EXCLUDED.label, withdrawal_addresses.label),
       status = 'pending', active_at = EXCLUDED.active_at
     RETURNING id, wallet_id, address, label, status, active_at, created_at`,
    [walletId, address, label ?? null, activeAt],
  );
  return rows[0];
}

export async function listWithdrawalAddresses(walletId: string): Promise<WithdrawalAddressRow[]> {
  const { rows } = await getPool().query<WithdrawalAddressRow>(
    `SELECT id, wallet_id, address, label, status, active_at, created_at
     FROM withdrawal_addresses WHERE wallet_id = $1 ORDER BY created_at`,
    [walletId],
  );
  return rows;
}

export async function getWithdrawalAddress(
  walletId: string,
  address: string,
): Promise<WithdrawalAddressRow | null> {
  const { rows } = await getPool().query<WithdrawalAddressRow>(
    `SELECT id, wallet_id, address, label, status, active_at, created_at
     FROM withdrawal_addresses WHERE wallet_id = $1 AND address = $2`,
    [walletId, address],
  );
  return rows[0] ?? null;
}

export async function setWithdrawalAddressStatus(
  id: string,
  status: 'active' | 'revoked',
): Promise<void> {
  await getPool().query(`UPDATE withdrawal_addresses SET status = $2 WHERE id = $1`, [id, status]);
}

/** Promote cooled-down pending addresses; returns the promoted rows. */
export async function promoteCooledAddresses(walletId: string): Promise<WithdrawalAddressRow[]> {
  const { rows } = await getPool().query<WithdrawalAddressRow>(
    `UPDATE withdrawal_addresses SET status = 'active'
     WHERE wallet_id = $1 AND status = 'pending' AND active_at <= now()
     RETURNING id, wallet_id, address, label, status, active_at, created_at`,
    [walletId],
  );
  return rows;
}

export async function createProposal(
  walletId: string,
  kind: ProposalKind,
  payload: unknown,
  expiresAt: Date,
): Promise<ProposalRow> {
  const { rows } = await getPool().query<ProposalRow>(
    `INSERT INTO proposals (wallet_id, kind, payload, expires_at) VALUES ($1, $2, $3, $4)
     RETURNING id, wallet_id, kind, payload, status, expires_at, created_at, resolved_at`,
    [walletId, kind, JSON.stringify(payload), expiresAt.toISOString()],
  );
  const row = rows[0];
  const { rows: owners } = await getPool().query<{ user_id: string }>(
    `SELECT user_id FROM wallets WHERE id = $1`,
    [walletId],
  );
  if (owners[0]) {
    await enqueueReaction({
      userId: owners[0].user_id,
      walletId,
      kind: 'proposal_created',
      notifyPolicy: 'notify_first',
      payload: { proposalId: row.id, proposalKind: kind, proposal: payload },
    });
  }
  return row;
}

export async function getProposal(id: string): Promise<ProposalRow | null> {
  const { rows } = await getPool().query<ProposalRow>(
    `SELECT id, wallet_id, kind, payload, status, expires_at, created_at, resolved_at
     FROM proposals WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listPendingProposals(walletId: string): Promise<ProposalRow[]> {
  const { rows } = await getPool().query<ProposalRow>(
    `SELECT id, wallet_id, kind, payload, status, expires_at, created_at, resolved_at
     FROM proposals WHERE wallet_id = $1 AND status = 'pending' ORDER BY created_at`,
    [walletId],
  );
  return rows;
}

/**
 * Transition a proposal out of pending exactly once. Returns the updated row,
 * or null when another caller already resolved it (no double-approve race).
 */
export async function listRecentProposals(walletIds: string[], limit: number): Promise<ProposalRow[]> {
  if (walletIds.length === 0) return [];
  const { rows } = await getPool().query<ProposalRow>(
    `SELECT id, wallet_id, kind, payload, status, expires_at, created_at, resolved_at
     FROM proposals WHERE wallet_id = ANY($1) ORDER BY created_at DESC LIMIT $2`,
    [walletIds, limit],
  );
  return rows;
}

export async function resolveProposal(
  id: string,
  status: Exclude<ProposalStatus, 'pending'>,
): Promise<ProposalRow | null> {
  const { rows } = await getPool().query<ProposalRow>(
    `UPDATE proposals SET status = $2, resolved_at = now()
     WHERE id = $1 AND status = 'pending'
     RETURNING id, wallet_id, kind, payload, status, expires_at, created_at, resolved_at`,
    [id, status],
  );
  return rows[0] ?? null;
}

/** Final outcome after an atomic claim; call only after resolveProposal won. */
export async function setProposalOutcome(
  id: string,
  status: Exclude<ProposalStatus, 'pending'>,
): Promise<void> {
  await getPool().query(
    `UPDATE proposals SET status = $2, resolved_at = now() WHERE id = $1`,
    [id, status],
  );
}

export interface ExpiredProposal extends ProposalRow {
  user_id: string;
}

/** Expire stale pending proposals, returning each row with its owner for notification. */
export async function expirePendingProposals(): Promise<ExpiredProposal[]> {
  const { rows } = await getPool().query<ExpiredProposal>(
    `UPDATE proposals p SET status = 'expired', resolved_at = now()
     FROM wallets w
     WHERE p.wallet_id = w.id AND p.status = 'pending' AND p.expires_at <= now()
     RETURNING p.id, p.wallet_id, p.kind, p.payload, p.status, p.expires_at,
               p.created_at, p.resolved_at, w.user_id`,
  );
  return rows;
}

export async function markProposalsExpired(): Promise<number> {
  return (await expirePendingProposals()).length;
}
