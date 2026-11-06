export interface UserRow {
  id: string;
  telegram_id: string | null;
  created_at: string;
}

export interface WalletRow {
  id: string;
  user_id: string;
  chain: string;
  address: string;
  label: string | null;
  is_agent_wallet: boolean;
  created_at: string;
}

export interface RuleRow {
  id: string;
  wallet_id: string;
  kind: string;
  asset: string;
  params: unknown;
  action: unknown;
  state: unknown;
  status: string;
  created_at: string;
  updated_at: string;
}

/** Active rule joined with its wallet, as the evaluator consumes it. */
export interface EvalRule extends RuleRow {
  wallet_address: string;
  is_agent_wallet: boolean;
  user_id: string;
}

export interface AuditEvent {
  walletId: string | null;
  actor: 'user' | 'agent' | 'system';
  action: string;
  detail?: unknown;
}

export interface PolicyRow {
  wallet_id: string;
  daily_cap_usd: string;
  per_tx_cap_usd: string;
  paused: boolean;
  created_at: string;
  updated_at: string;
}

export type WithdrawalAddressStatus = 'pending' | 'active' | 'revoked';

export interface WithdrawalAddressRow {
  id: string;
  wallet_id: string;
  address: string;
  label: string | null;
  status: WithdrawalAddressStatus;
  active_at: string;
  created_at: string;
}

export type ProposalKind = 'swap' | 'withdrawal';
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed' | 'expired';

export interface SnapshotRow {
  id: string;
  wallet_id: string;
  total_usd: string | null;
  data: unknown;
  created_at: string;
}

export interface ProposalRow {
  id: string;
  wallet_id: string;
  kind: ProposalKind;
  payload: unknown;
  status: ProposalStatus;
  expires_at: string;
  created_at: string;
  resolved_at: string | null;
}
