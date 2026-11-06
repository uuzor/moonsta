import { ChainPosition } from '@sentinel/chain';

const KNOWN_SYMBOLS: Record<string, string> = {
  So11111111111111111111111111111111111111112: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
};

export function shortMint(mint: string): string {
  return mint.length <= 12 ? mint : `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

export function symbolFor(mint: string): string {
  return KNOWN_SYMBOLS[mint] ?? shortMint(mint);
}

export interface HoldingInput {
  mint: string;
  amount: number;
  usdPrice?: number | null;
  change24h?: number | null;
}

export interface RuleSummary {
  id: string;
  kind: string;
  asset: string;
  status: string;
}

export interface ReportInput {
  wallet: string;
  holdings: HoldingInput[];
  /** On-chain protocol positions; null when the read failed. */
  positions: ChainPosition[] | null;
  rules: RuleSummary[];
}

/** Holdings at/above this USD value without a rule are flagged unprotected. */
export const MIN_GUARD_USD = 10;

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
  positions: ChainPosition[] | null;
  activeRules: RuleSummary[];
  unprotected: string[];
  pricedCount: number;
  unpricedCount: number;
  generatedAt: string;
}

export function buildReport(input: ReportInput): Report {
  const holdings: Holding[] = input.holdings.map((h) => ({
    mint: h.mint,
    symbol: symbolFor(h.mint),
    amount: h.amount,
    usdValue: h.usdPrice == null ? null : h.amount * h.usdPrice,
    allocationPct: null,
    change24h: h.change24h ?? null,
  }));

  const totalUsd = holdings.reduce((s, h) => s + (h.usdValue ?? 0), 0);
  for (const h of holdings) {
    h.allocationPct = h.usdValue == null || totalUsd <= 0 ? null : (h.usdValue / totalUsd) * 100;
  }
  holdings.sort((a, b) => (b.usdValue ?? -1) - (a.usdValue ?? -1));

  // Value-weighted 24h change over priced holdings that report a change.
  let weightSum = 0;
  let changeSum = 0;
  for (const h of holdings) {
    if (h.usdValue != null && h.change24h != null) {
      weightSum += h.usdValue;
      changeSum += h.usdValue * h.change24h;
    }
  }
  const change24h = weightSum > 0 ? changeSum / weightSum : null;

  const covered = new Set(input.rules.map((r) => r.asset));
  const unprotected = holdings
    .filter((h) => (h.usdValue ?? 0) >= MIN_GUARD_USD && !covered.has(h.mint))
    .map((h) => h.symbol);

  return {
    wallet: input.wallet,
    totalUsd,
    change24h,
    holdings,
    positions: input.positions,
    activeRules: input.rules,
    unprotected,
    pricedCount: holdings.filter((h) => h.usdValue != null).length,
    unpricedCount: holdings.filter((h) => h.usdValue == null).length,
    generatedAt: new Date().toISOString(),
  };
}
