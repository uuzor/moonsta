import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { optional } from '@sentinel/config';
import { sendAndConfirm } from './send';

export function resolveJupiterBase(): string {
  return optional('JUPITER_API_BASE', 'https://api.jup.ag');
}

function apiHeaders(): Record<string, string> {
  const key = process.env.JUPITER_API_KEY;
  return key ? { 'x-api-key': key } : {};
}

export interface SwapQuoteRequest {
  inputMint: string;
  outputMint: string;
  /** Raw base units as a decimal string. */
  amountRaw: string;
  slippageBps: number;
}

export interface SwapQuote {
  inAmount: string;
  outAmount: string;
  /** Full quote response, passed back to the build call verbatim. */
  raw: unknown;
}

/** GET /swap/v1/quote — fails loudly; never guess a route. */
export async function getSwapQuote(
  req: SwapQuoteRequest,
  apiBase: string = resolveJupiterBase(),
): Promise<SwapQuote> {
  const url =
    `${apiBase}/swap/v1/quote?inputMint=${req.inputMint}` +
    `&outputMint=${req.outputMint}&amount=${req.amountRaw}&slippageBps=${req.slippageBps}`;
  const res = await fetch(url, { headers: apiHeaders() });
  if (!res.ok) throw new Error(`Jupiter quote failed: HTTP ${res.status}`);
  const q = (await res.json()) as { inAmount?: string; outAmount?: string };
  if (typeof q.inAmount !== 'string' || typeof q.outAmount !== 'string') {
    throw new Error('Jupiter quote response missing amounts');
  }
  return { inAmount: q.inAmount, outAmount: q.outAmount, raw: q };
}

export interface BuiltSwap {
  transactionBase64: string;
  lastValidBlockHeight: number;
}

/** POST /swap/v1/swap — returns an unsigned versioned transaction. */
export async function buildSwapTransaction(
  quote: SwapQuote,
  userPublicKey: PublicKey,
  opts: { wrapAndUnwrapSol?: boolean; apiBase?: string } = {},
): Promise<BuiltSwap> {
  const res = await fetch(`${opts.apiBase ?? resolveJupiterBase()}/swap/v1/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiHeaders() },
    body: JSON.stringify({
      quoteResponse: quote.raw,
      userPublicKey: userPublicKey.toBase58(),
      wrapAndUnwrapSol: opts.wrapAndUnwrapSol ?? true,
    }),
  });
  if (!res.ok) throw new Error(`Jupiter swap build failed: HTTP ${res.status}`);
  const b = (await res.json()) as {
    swapTransaction?: string;
    lastValidBlockHeight?: number;
    simulationError?: unknown;
  };
  if (typeof b.swapTransaction !== 'string' || typeof b.lastValidBlockHeight !== 'number') {
    throw new Error('Jupiter swap build response missing transaction');
  }
  if (b.simulationError) {
    throw new Error(`Jupiter pre-simulation failed: ${JSON.stringify(b.simulationError)}`);
  }
  return { transactionBase64: b.swapTransaction, lastValidBlockHeight: b.lastValidBlockHeight };
}

/** Hard ceiling: no swap may promise more slippage than this. */
export const MAX_SLIPPAGE_BPS = 300;

export class SimulationError extends Error {
  readonly logs: string[];
  constructor(message: string, logs: string[]) {
    super(message);
    this.logs = logs;
  }
}

export interface ExecuteSwapInput {
  connection: Connection;
  keypair: Keypair;
  inputMint: string;
  outputMint: string;
  amountRaw: string;
  slippageBps: number;
  /** True = quote + build + simulate, never send. */
  dryRun: boolean;
  /** Policy gate: runs after quoting, before building. Throw to abort. */
  beforeBuild?: (quote: SwapQuote) => Promise<void>;
}

export interface ExecuteSwapResult {
  signature: string | null;
  simulated: boolean;
  outAmount: string;
  dryRun: boolean;
}

/**
 * Capability-limited executor: it can only perform Jupiter swaps, always
 * simulates first, and sends only when dryRun is false. Budgets, allowlists,
 * and withdrawal approvals live in the policy engine (next step).
 */
export async function executeSwap(input: ExecuteSwapInput): Promise<ExecuteSwapResult> {
  const { connection, keypair, dryRun } = input;
  if (
    !Number.isInteger(input.slippageBps) ||
    input.slippageBps < 1 ||
    input.slippageBps > MAX_SLIPPAGE_BPS
  ) {
    throw new Error(`slippageBps must be 1..${MAX_SLIPPAGE_BPS}`);
  }
  if (!/^\d+$/.test(input.amountRaw) || input.amountRaw === '0') {
    throw new Error('amountRaw must be a positive integer string');
  }

  const quote = await getSwapQuote({
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    amountRaw: input.amountRaw,
    slippageBps: input.slippageBps,
  });
  if (input.beforeBuild) await input.beforeBuild(quote);
  const built = await buildSwapTransaction(quote, keypair.publicKey);
  const tx = VersionedTransaction.deserialize(Buffer.from(built.transactionBase64, 'base64'));
  tx.sign([keypair]);

  const sim = await connection.simulateTransaction(tx, { sigVerify: false });
  if (sim.value.err) {
    throw new SimulationError(
      `Simulation failed: ${JSON.stringify(sim.value.err)}`,
      sim.value.logs ?? [],
    );
  }
  if (dryRun) {
    return { signature: null, simulated: true, outAmount: quote.outAmount, dryRun: true };
  }

  const signature = await sendAndConfirm(connection, tx);
  return { signature, simulated: true, outAmount: quote.outAmount, dryRun: false };
}
