import { initData } from './tg';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { Authorization: `tma ${initData()}`, 'Content-Type': 'application/json' },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export interface WalletRef {
  chain: string;
  address: string;
  label: string | null;
}

export interface Holding {
  mint: string;
  symbol: string;
  amount: number;
  usdValue: number | null;
  allocationPct: number | null;
  change24h: number | null;
}

export interface Report {
  wallet: string;
  totalUsd: number;
  change24h: number | null;
  holdings: Holding[];
  activeRules: Array<{ id: string; kind: string; asset: string; status: string }>;
  unprotected: string[];
}

export interface PortfolioWallet extends WalletRef {
  report?: Report;
  error?: string;
}

export interface TrackedPosition {
  id: string;
  venue: string;
  market: string;
  side: string | null;
  size: string | null;
  entry_price: string | null;
  opened_at: string;
}

export interface RuleItem {
  id: string;
  kind: string;
  asset: string;
  params: Record<string, unknown>;
  action: unknown;
  status: string;
  updatedAt: string;
}

export interface ProposalItem {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: string;
  expiresAt: string;
  createdAt: string;
}

export interface ScheduledItem {
  id: string;
  kind: string;
  message: string;
  runAt: string;
  status: string;
}

export const api = {
  me: () => req<{ telegramId: string; wallets: WalletRef[] }>('/api/me'),
  scheduled: () => req<{ actions: ScheduledItem[] }>('/api/scheduled'),
  cancelScheduled: (id: string) => req<{ id: string; status: string }>(`/api/scheduled/${id}/cancel`, { method: 'POST' }),
  portfolio: () => req<{ totalUsd: number; wallets: PortfolioWallet[] }>('/api/portfolio'),
  history: (days = 30) => req<{ days: number; points: Array<{ day: string; totalUsd: number }> }>(`/api/history?days=${days}`),
  positions: () =>
    req<{
      wallets: Array<{
        chain: string;
        address: string;
        tracked: TrackedPosition[];
        onchain: Array<{ protocol: string; market: string; kind: string; detail: string }> | { error: string };
      }>;
    }>('/api/positions'),
  rules: () =>
    req<{ wallets: Array<WalletRef & { rules: RuleItem[] }> }>('/api/rules'),
  pauseRule: (id: string) => req<{ id: string; status: string }>(`/api/rules/${id}/pause`, { method: 'POST' }),
  resumeRule: (id: string) => req<{ id: string; status: string }>(`/api/rules/${id}/resume`, { method: 'POST' }),
  proposals: () => req<{ proposals: ProposalItem[] }>('/api/proposals'),
  approve: (id: string) => req<{ text: string; alert: boolean }>(`/api/proposals/${id}/approve`, { method: 'POST' }),
  reject: (id: string) => req<{ text: string; alert: boolean }>(`/api/proposals/${id}/reject`, { method: 'POST' }),
  activity: () =>
    req<{ events: Array<{ actor: string; action: string; detail: unknown; at: string }> }>('/api/activity'),
  pauseAll: () => req<{ message: string }>('/api/pause-all', { method: 'POST' }),
  resumeAll: () => req<{ message: string }>('/api/resume-all', { method: 'POST' }),
};

export function shortAddr(addr: string): string {
  return addr.length <= 12 ? addr : `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: n < 1 ? 4 : 2 })}`;
}
