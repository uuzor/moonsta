import { optional } from '@sentinel/config';

export interface TokenPrice {
  usdPrice: number;
  change24h: number | null;
  decimals: number | null;
  /** Approximate USD liquidity depth reported by Jupiter, when available. */
  liquidityUsd: number | null;
  /** When Jupiter first indexed the token (age proxy), when available. */
  indexedAt: string | null;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface PriceV3Entry {
  usdPrice?: number;
  priceChange24h?: number;
  decimals?: number;
  liquidity?: number;
  createdAt?: string;
}

export function resolvePriceUrl(): string {
  return optional('JUPITER_PRICE_URL', 'https://api.jup.ag/price/v3');
}

/**
 * USD prices via the Jupiter Price API (batched). Failed chunks are skipped,
 * so callers must treat a missing mint as unpriced — never as zero.
 */
export async function getUsdPrices(
  mints: string[],
  priceUrl: string = resolvePriceUrl(),
): Promise<Map<string, TokenPrice>> {
  const out = new Map<string, TokenPrice>();
  const unique = [...new Set(mints)];
  for (const group of chunk(unique, 50)) {
    try {
      const res = await fetch(`${priceUrl}?ids=${group.join(',')}`);
      if (!res.ok) continue;
      const json = (await res.json()) as Record<string, PriceV3Entry>;
      for (const [mint, e] of Object.entries(json)) {
        if (!e || typeof e.usdPrice !== 'number') continue;
        out.set(mint, {
          usdPrice: e.usdPrice,
          change24h: typeof e.priceChange24h === 'number' ? e.priceChange24h : null,
          decimals: typeof e.decimals === 'number' ? e.decimals : null,
          liquidityUsd: typeof e.liquidity === 'number' ? e.liquidity : null,
          indexedAt: typeof e.createdAt === 'string' ? e.createdAt : null,
        });
      }
    } catch {
      // Partial results; missing mints stay unpriced.
    }
  }
  return out;
}
