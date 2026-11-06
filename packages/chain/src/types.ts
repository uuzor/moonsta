// Chain-agnostic value types. Every @sentinel/chain-<id> package speaks these;
// chain quirks stay inside the adapters.

export const CHAINS = ['solana'] as const;
export type ChainId = (typeof CHAINS)[number];

export interface NativeBalance {
  amount: number;
  decimals: number;
  amountRaw: string;
}

export interface TokenBalance {
  mint: string;
  amountRaw: string;
  decimals: number;
  uiAmount: number;
}

export interface TokenPrice {
  usdPrice: number;
  change24h: number | null;
  liquidityUsd: number | null;
  indexedAt: string | null;
}

export interface ChainMintInfo {
  /** Null = authority revoked, or concept inapplicable on this chain. */
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supplyRaw: string;
  decimals: number;
}

export interface ChainPosition {
  protocol: string;
  market: string;
  kind: 'perp' | 'spot' | 'lend' | 'other';
  detail: string;
  meta?: unknown;
}

export interface ProtocolQuote {
  protocol: string;
  inAmount: string;
  outAmount: string;
  detail?: unknown;
}

export interface QuoteRequest {
  inputMint: string;
  outputMint: string;
  amountRaw: string;
  slippageBps: number;
  /** One venue, or all supported when omitted. */
  protocol?: string;
}

/** Third-party risk verdict, normalized across providers. Null when unavailable. */
export interface ExternalRisk {
  /** 0 (clean) to 100 (riskiest), null when unscored. */
  score01: number | null;
  /** Short danger-level finding names, most severe first. */
  dangers: string[];
  /** Share of LP locked, null when unknown. */
  lpLockedPct: number | null;
}
