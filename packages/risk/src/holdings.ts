import { ChainAdapter } from '@sentinel/chain';
import { RiskScore, scoreToken } from './score';

function indexedDays(indexedAt: string | null | undefined): number | null {
  if (!indexedAt) return null;
  const ms = Date.now() - new Date(indexedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms / 86_400_000 : null;
}

/**
 * Score one holding through a chain adapter. Every signal degrades to
 * unknown on failure — the scorer penalizes unknowns instead of crashing.
 */
export async function scoreHolding(adapter: ChainAdapter, mint: string): Promise<RiskScore> {
  const [info, prices, external] = await Promise.all([
    adapter.getMintInfo(mint).catch(() => null),
    adapter.getUsdPrices([mint]).catch(() => new Map()),
    adapter.getExternalRisk(mint).catch(() => null),
  ]);
  const price = prices.get(mint);
  const top10 = info ? await adapter.getTop10Pct(mint).catch(() => null) : null;
  return scoreToken({
    mint,
    mintKnown: info !== null,
    mintAuthority: info?.mintAuthority ?? null,
    freezeAuthority: info?.freezeAuthority ?? null,
    top10Pct: top10,
    concentrationNA: adapter.nativeMint !== null && mint === adapter.nativeMint,
    liquidityUsd: price?.liquidityUsd ?? null,
    indexedDays: indexedDays(price?.indexedAt),
    change24hAbs: price?.change24h == null ? null : Math.abs(price.change24h),
    external:
      external?.score01 == null ? null : { score01: external.score01, dangers: external.dangers },
  });
}
