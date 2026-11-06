import { Connection, PublicKey } from '@solana/web3.js';
import {
  ChainAdapter,
  ChainMintInfo,
  ChainPosition,
  ExternalRisk,
  NativeBalance,
  ProtocolQuote,
  QuoteRequest,
  TokenBalance,
  TokenPrice,
  UnknownProtocolError,
} from '@sentinel/chain';
import { optional } from '@sentinel/config';
import { getSolBalance, getSplBalances } from './balances';
import { createConnection, resolveSolanaEnv } from './connection';
import { getDriftPositions } from './drift';
import { getUsdPrices } from './jupiterPrices';
import { getSwapQuote } from './jupiterSwap';
import { SOL_MINT, USDC_MINT, USDT_MINT } from './mints';

export class SolanaAdapter implements ChainAdapter {
  readonly chain = 'solana' as const;
  readonly nativeSymbol = 'SOL';
  readonly nativeMint: string | null = SOL_MINT;
  readonly stableMints: readonly string[] = [USDC_MINT, USDT_MINT];
  readonly symbols: Readonly<Record<string, string>> = {
    SOL: SOL_MINT,
    USDC: USDC_MINT,
    USDT: USDT_MINT,
  };
  readonly supportedProtocols: readonly string[] = ['jupiter'];

  constructor(private readonly rpcUrl?: string) {}

  private conn(): Connection {
    return createConnection(this.rpcUrl);
  }

  assertAddress(address: string): void {
    new PublicKey(address);
  }

  async getNativeBalance(owner: string): Promise<NativeBalance> {
    const b = await getSolBalance(this.conn(), new PublicKey(owner));
    return { amount: b.sol, decimals: 9, amountRaw: String(b.lamports) };
  }

  async getTokenBalances(owner: string): Promise<TokenBalance[]> {
    return getSplBalances(this.conn(), new PublicKey(owner));
  }

  async getUsdPrices(mints: string[]): Promise<Map<string, TokenPrice>> {
    const prices = await getUsdPrices(mints);
    const out = new Map<string, TokenPrice>();
    for (const [mint, p] of prices) {
      out.set(mint, {
        usdPrice: p.usdPrice,
        change24h: p.change24h,
        liquidityUsd: p.liquidityUsd,
        indexedAt: p.indexedAt,
      });
    }
    return out;
  }

  async getMintInfo(mint: string): Promise<ChainMintInfo | null> {
    const info = await this.conn().getParsedAccountInfo(new PublicKey(mint));
    const data = info.value?.data;
    if (!data || !('parsed' in data) || data.parsed.type !== 'mint') return null;
    const m = data.parsed.info;
    return {
      mintAuthority: m.mintAuthority ?? null,
      freezeAuthority: m.freezeAuthority ?? null,
      supplyRaw: String(m.supply),
      decimals: Number(m.decimals),
    };
  }

  async getTop10Pct(mint: string): Promise<number | null> {
    const info = await this.getMintInfo(mint);
    if (!info) return null;
    const supplyUi = Number(info.supplyRaw) / 10 ** info.decimals;
    if (!(supplyUi > 0)) return null;
    const largest = await this.conn().getTokenLargestAccounts(new PublicKey(mint));
    let sum = 0;
    for (const entry of largest.value.slice(0, 10)) {
      const v =
        typeof entry.uiAmount === 'number'
          ? entry.uiAmount
          : Number((entry as { uiAmountString?: string }).uiAmountString);
      if (!Number.isFinite(v)) return null;
      sum += v;
    }
    return Math.min(100, (sum / supplyUi) * 100);
  }

  async quoteSwap(req: QuoteRequest): Promise<ProtocolQuote[]> {
    if (req.protocol && !this.supportedProtocols.includes(req.protocol)) {
      throw new UnknownProtocolError(this.chain, req.protocol, this.supportedProtocols);
    }
    const quote = await getSwapQuote({
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      amountRaw: req.amountRaw,
      slippageBps: req.slippageBps,
    });
    return [
      {
        protocol: 'jupiter',
        inAmount: quote.inAmount,
        outAmount: quote.outAmount,
        detail: quote.raw,
      },
    ];
  }

  async getExternalRisk(mint: string): Promise<ExternalRisk | null> {
    try {
      const base = optional('RUGCHECK_API_BASE', 'https://api.rugcheck.xyz/v1');
      const res = await fetch(`${base}/tokens/${mint}/report/summary`);
      if (!res.ok) return null;
      const body = (await res.json()) as {
        score_normalised?: unknown;
        lpLockedPct?: unknown;
        risks?: Array<{ name?: unknown; level?: unknown }>;
      };
      const dangers = (body.risks ?? [])
        .filter((r) => r.level === 'danger' && typeof r.name === 'string')
        .map((r) => r.name as string);
      return {
        score01: typeof body.score_normalised === 'number' ? body.score_normalised : null,
        dangers,
        lpLockedPct: typeof body.lpLockedPct === 'number' ? body.lpLockedPct : null,
      };
    } catch {
      return null;
    }
  }

  async getPositions(owner: string): Promise<ChainPosition[]> {
    const d = await getDriftPositions(this.conn(), new PublicKey(owner), resolveSolanaEnv());
    return [
      ...d.perp.map((p) => ({
        protocol: 'drift',
        market: `perp-${p.marketIndex}`,
        kind: 'perp' as const,
        detail: `base ${p.baseAmount}, quote ${p.quoteAmount}`,
        meta: p,
      })),
      ...d.spot.map((s) => ({
        protocol: 'drift',
        market: `spot-${s.marketIndex}`,
        kind: 'spot' as const,
        detail: `${s.balanceType} ${s.scaledBalance} (scaled)`,
        meta: s,
      })),
    ];
  }
}

export const solanaAdapter = new SolanaAdapter();
