import { getPool } from './pool';
import { AuditEvent, EvalRule, RuleRow, SnapshotRow, UserRow, WalletRow } from './types';

export async function ensureUserByTelegram(telegramId: string): Promise<UserRow> {
  const { rows } = await getPool().query<UserRow>(
    `INSERT INTO users (telegram_id) VALUES ($1)
     ON CONFLICT (telegram_id) DO UPDATE SET telegram_id = EXCLUDED.telegram_id
     RETURNING id, telegram_id, created_at`,
    [telegramId],
  );
  return rows[0];
}

export async function ensureWallet(
  userId: string,
  chain: string,
  address: string,
  label?: string,
  opts?: { isAgentWallet?: boolean },
): Promise<WalletRow> {
  const { rows } = await getPool().query<WalletRow>(
    `INSERT INTO wallets (user_id, chain, address, label, is_agent_wallet) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, chain, address) DO UPDATE SET
       label = COALESCE(EXCLUDED.label, wallets.label),
       is_agent_wallet = wallets.is_agent_wallet OR EXCLUDED.is_agent_wallet
     RETURNING id, user_id, chain, address, label, is_agent_wallet, created_at`,
    [userId, chain, address, label ?? null, opts?.isAgentWallet ?? false],
  );
  return rows[0];
}

export async function listWallets(userId: string, chain?: string): Promise<WalletRow[]> {
  const { rows } = await getPool().query<WalletRow>(
    `SELECT id, user_id, chain, address, label, is_agent_wallet, created_at
     FROM wallets WHERE user_id = $1 AND ($2::text IS NULL OR chain = $2) ORDER BY created_at`,
    [userId, chain ?? null],
  );
  return rows;
}

export async function listAllWallets(): Promise<WalletRow[]> {
  const { rows } = await getPool().query<WalletRow>(
    `SELECT id, user_id, chain, address, label, is_agent_wallet, created_at
     FROM wallets ORDER BY created_at`,
  );
  return rows;
}

export async function findWallet(
  userId: string,
  chain: string,
  address: string,
): Promise<WalletRow | null> {
  const { rows } = await getPool().query<WalletRow>(
    `SELECT id, user_id, chain, address, label, is_agent_wallet, created_at
     FROM wallets WHERE user_id = $1 AND chain = $2 AND address = $3`,
    [userId, chain, address],
  );
  return rows[0] ?? null;
}

export async function listActiveRules(walletId: string): Promise<RuleRow[]> {
  const { rows } = await getPool().query<RuleRow>(
    `SELECT id, wallet_id, kind, asset, params, action, state, status, created_at, updated_at
     FROM rules WHERE wallet_id = $1 AND status = 'active' ORDER BY created_at`,
    [walletId],
  );
  return rows;
}

export async function listActiveRulesForEval(): Promise<EvalRule[]> {
  const { rows } = await getPool().query<EvalRule>(
    `SELECT r.id, r.wallet_id, r.kind, r.asset, r.params, r.action, r.state,
            r.status, r.created_at, r.updated_at,
            w.address AS wallet_address, w.is_agent_wallet, w.user_id
     FROM rules r JOIN wallets w ON w.id = r.wallet_id
     WHERE r.status = 'active' ORDER BY r.created_at`,
  );
  return rows;
}

export async function updateRuleState(ruleId: string, state: unknown): Promise<void> {
  await getPool().query(`UPDATE rules SET state = $2, updated_at = now() WHERE id = $1`, [
    ruleId,
    JSON.stringify(state),
  ]);
}

/** Claim a trigger idempotently: true when this caller won the race. */
export async function tryInsertTrigger(
  ruleId: string,
  key: string,
  status: string,
  detail: unknown,
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `INSERT INTO triggers (rule_id, idempotency_key, status, detail) VALUES ($1, $2, $3, $4)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [ruleId, key, status, JSON.stringify(detail ?? null)],
  );
  return (rowCount ?? 0) > 0;
}

export async function releaseTrigger(key: string): Promise<void> {
  await getPool().query(`DELETE FROM triggers WHERE idempotency_key = $1`, [key]);
}

export interface PositionRow {
  id: string;
  wallet_id: string;
  venue: string;
  market: string;
  side: string | null;
  size: string | null;
  entry_price: string | null;
  meta: unknown;
  opened_at: string;
  closed_at: string | null;
}

export async function listOpenPositions(walletId: string): Promise<PositionRow[]> {
  const { rows } = await getPool().query<PositionRow>(
    `SELECT id, wallet_id, venue, market, side, size, entry_price, meta, opened_at, closed_at
     FROM positions WHERE wallet_id = $1 AND closed_at IS NULL ORDER BY opened_at`,
    [walletId],
  );
  return rows;
}

export interface PositionInput {
  walletId: string;
  venue: string;
  market: string;
  side?: string;
  size?: number;
  entryPrice?: number;
  meta?: unknown;
}

export async function registerPosition(p: PositionInput): Promise<void> {
  await getPool().query(
    `INSERT INTO positions (wallet_id, venue, market, side, size, entry_price, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [p.walletId, p.venue, p.market, p.side ?? null, p.size ?? null, p.entryPrice ?? null, JSON.stringify(p.meta ?? null)],
  );
}

export async function insertAuditEvent(event: AuditEvent): Promise<void> {
  await getPool().query(
    `INSERT INTO audit_log (wallet_id, actor, action, detail) VALUES ($1, $2, $3, $4)`,
    [event.walletId, event.actor, event.action, JSON.stringify(event.detail ?? null)],
  );
}

export interface AuditRow {
  id: string;
  wallet_id: string | null;
  actor: string;
  action: string;
  detail: unknown;
  created_at: string;
}

export async function getRuleById(ruleId: string): Promise<RuleRow | null> {
  const { rows } = await getPool().query<RuleRow>(
    `SELECT id, wallet_id, kind, asset, params, action, state, status, created_at, updated_at
     FROM rules WHERE id = $1`,
    [ruleId],
  );
  return rows[0] ?? null;
}

export async function listWalletRules(walletId: string): Promise<RuleRow[]> {
  const { rows } = await getPool().query<RuleRow>(
    `SELECT id, wallet_id, kind, asset, params, action, state, status, created_at, updated_at
     FROM rules WHERE wallet_id = $1 ORDER BY updated_at DESC`,
    [walletId],
  );
  return rows;
}

/** Daily total_USD per day across all of a user's wallets (oldest first). */
export async function portfolioHistory(
  userId: string,
  days: number,
): Promise<Array<{ day: string; totalUsd: number }>> {
  const { rows } = await getPool().query<{ day: string; total_usd: string }>(
    `SELECT to_char(date_trunc('day', s.created_at), 'YYYY-MM-DD') AS day,
            SUM(s.total_usd) AS total_usd
     FROM snapshots s JOIN wallets w ON w.id = s.wallet_id
     WHERE w.user_id = $1 AND s.created_at > now() - ($2 || ' days')::interval
     GROUP BY 1 ORDER BY 1`,
    [userId, String(days)],
  );
  return rows.map((r) => ({ day: r.day, totalUsd: Number(r.total_usd) }));
}

export async function recentAuditEvents(walletIds: string[], limit: number): Promise<AuditRow[]> {
  if (walletIds.length === 0) return [];
  const { rows } = await getPool().query<AuditRow>(
    `SELECT id, wallet_id, actor, action, detail, created_at
     FROM audit_log WHERE wallet_id = ANY($1) ORDER BY created_at DESC LIMIT $2`,
    [walletIds, limit],
  );
  return rows;
}

export async function insertSnapshot(
  walletId: string,
  totalUsd: number | null,
  data: unknown,
): Promise<void> {
  await getPool().query(
    `INSERT INTO snapshots (wallet_id, total_usd, data) VALUES ($1, $2, $3)`,
    [walletId, totalUsd, JSON.stringify(data)],
  );
}

export async function recentSnapshots(walletId: string, limit: number): Promise<SnapshotRow[]> {
  const { rows } = await getPool().query<SnapshotRow>(
    `SELECT id, wallet_id, total_usd, data, created_at
     FROM snapshots WHERE wallet_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [walletId, limit],
  );
  return rows;
}
