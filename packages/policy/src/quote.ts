import { SwapQuote } from '@sentinel/chain-solana';

export interface QuoteRequest {
  inputMint: string;
  outputMint: string;
  amountRaw: string;
  slippageBps: number;
}

/**
 * The quote must echo the request exactly. A mismatch means the route is not
 * what we asked for (tampered response, bug, or API confusion) — fail closed.
 */
export function verifyQuoteMatches(
  req: QuoteRequest,
  quote: SwapQuote,
): { ok: true } | { ok: false; reason: string } {
  const raw = quote.raw as {
    inputMint?: unknown;
    outputMint?: unknown;
    inAmount?: unknown;
    slippageBps?: unknown;
  } | null;
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'quote has no body' };
  if (raw.inputMint !== req.inputMint) return { ok: false, reason: 'quote inputMint mismatch' };
  if (raw.outputMint !== req.outputMint) return { ok: false, reason: 'quote outputMint mismatch' };
  if (raw.inAmount !== req.amountRaw) return { ok: false, reason: 'quote amount mismatch' };
  if (typeof raw.slippageBps !== 'number' || raw.slippageBps > req.slippageBps) {
    return { ok: false, reason: 'quote slippage exceeds request' };
  }
  if (quote.inAmount !== req.amountRaw) return { ok: false, reason: 'quote inAmount mismatch' };
  return { ok: true };
}
