import { dailySpendUsd, getPolicy } from '@sentinel/db';
import { MAX_SLIPPAGE_BPS, SwapQuote } from '@sentinel/chain-solana';
import { QuoteRequest, verifyQuoteMatches } from './quote';

export class PolicyDeniedError extends Error {}

export type CheckResult = { allowed: true } | { allowed: false; reason: string };

async function checkCaps(
  walletId: string,
  usdValue: number,
): Promise<CheckResult> {
  const policy = await getPolicy(walletId);
  if (policy.paused) return { allowed: false, reason: 'wallet is paused' };
  const perTx = Number(policy.per_tx_cap_usd);
  if (usdValue > perTx) {
    return { allowed: false, reason: `\$${usdValue.toFixed(2)} exceeds per-tx cap \$${perTx}` };
  }
  const spent = await dailySpendUsd(walletId);
  const daily = Number(policy.daily_cap_usd);
  if (spent + usdValue > daily) {
    return {
      allowed: false,
      reason: `\$${(spent + usdValue).toFixed(2)} would exceed daily cap \$${daily} (spent \$${spent.toFixed(2)})`,
    };
  }
  return { allowed: true };
}

export interface SwapCheckInput extends QuoteRequest {
  walletId: string;
  usdValue: number;
  quote: SwapQuote;
}

/** Full pre-build gate for swaps: pause, quote echo, slippage, caps. */
export async function checkSwap(input: SwapCheckInput): Promise<CheckResult> {
  const match = verifyQuoteMatches(input, input.quote);
  if (!match.ok) return { allowed: false, reason: match.reason };
  if (input.slippageBps > MAX_SLIPPAGE_BPS) {
    return { allowed: false, reason: `slippage ${input.slippageBps}bps exceeds max ${MAX_SLIPPAGE_BPS}` };
  }
  return checkCaps(input.walletId, input.usdValue);
}

/** Gate for withdrawals (caps + pause; address + approval handled separately). */
export async function checkWithdrawalCaps(
  walletId: string,
  usdValue: number,
): Promise<CheckResult> {
  return checkFunds(walletId, usdValue);
}

/** Pause + per-tx + daily caps, without any quote context. */
export async function checkFunds(walletId: string, usdValue: number): Promise<CheckResult> {
  return checkCaps(walletId, usdValue);
}

/** Throwing variant for executor hooks. */
export async function assertSwapAllowed(input: SwapCheckInput): Promise<void> {
  const r = await checkSwap(input);
  if (!r.allowed) throw new PolicyDeniedError(r.reason);
}
