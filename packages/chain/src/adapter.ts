import {
  ChainId,
  ChainMintInfo,
  ChainPosition,
  ExternalRisk,
  NativeBalance,
  ProtocolQuote,
  QuoteRequest,
  TokenBalance,
  TokenPrice,
} from './types';

/**
 * Read surface every chain implements. Execution (swaps, transfers) stays in
 * the chain packages behind the worker/policy paths — the agent only reads
 * and proposes through tools.
 */
export interface ChainAdapter {
  readonly chain: ChainId;
  readonly nativeSymbol: string;
  /** Wrapped/native mint used for pricing the native asset, if any. */
  readonly nativeMint: string | null;
  /** Mints treated as stable (alert-only guards, nothing safer to rotate to). */
  readonly stableMints: readonly string[];
  /** Uppercase symbol -> mint for common tokens (agent shorthand). */
  readonly symbols: Readonly<Record<string, string>>;
  /** Swap venues available for quoting on this chain. */
  readonly supportedProtocols: readonly string[];
  /** Throws when the address is malformed for this chain. */
  assertAddress(address: string): void;
  getNativeBalance(owner: string): Promise<NativeBalance>;
  getTokenBalances(owner: string): Promise<TokenBalance[]>;
  getUsdPrices(mints: string[]): Promise<Map<string, TokenPrice>>;
  /** Null when the mint cannot be read. */
  getMintInfo(mint: string): Promise<ChainMintInfo | null>;
  /** 0-100 supply share in top 10 holders; null when unknown/inapplicable. */
  getTop10Pct(mint: string): Promise<number | null>;
  /** On-chain protocol positions (perps, lending). Empty when none. */
  getPositions(owner: string): Promise<ChainPosition[]>;
  /**
   * Swap quotes across one or all supported venues. Read-only: no policy,
   * no writes. Throws UnknownProtocolError for unsupported venues.
   */
  quoteSwap(req: QuoteRequest): Promise<ProtocolQuote[]>;
  /** Third-party risk verdict for a token; null when unavailable. */
  getExternalRisk(mint: string): Promise<ExternalRisk | null>;
}
