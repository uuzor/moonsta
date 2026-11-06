import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { DriftClient, Wallet } from '@drift-labs/sdk';
import { SolanaEnv } from './connection';

export interface DriftPerpView {
  marketIndex: number;
  baseAmount: string;
  quoteAmount: string;
}

export interface DriftSpotView {
  marketIndex: number;
  scaledBalance: string;
  balanceType: string;
}

export interface DriftPositions {
  perp: DriftPerpView[];
  spot: DriftSpotView[];
}

/**
 * Read-only Drift positions for an authority: queries the on-chain User
 * accounts (authority is the first field after the 8-byte discriminator).
 * Never subscribes or signs — the wallet is an empty dummy keypair.
 */
export async function getDriftPositions(
  connection: Connection,
  authority: PublicKey,
  env: SolanaEnv,
): Promise<DriftPositions> {
  const wallet = new Wallet(Keypair.generate());
  const client = new DriftClient({ connection, wallet, env });
  const accounts = await client.program.account.user.all([
    { memcmp: { offset: 8, bytes: authority.toBase58() } },
  ]);
  const perp: DriftPerpView[] = [];
  const spot: DriftSpotView[] = [];
  for (const { account } of accounts) {
    // The SDK types decoded accounts loosely; view them structurally.
    const view = account as unknown as {
      perpPositions?: Array<{
        marketIndex: number;
        baseAssetAmount?: { isZero(): boolean; toString(): string };
        quoteAssetAmount?: { toString(): string };
      }>;
      spotPositions?: Array<{
        marketIndex: number;
        scaledBalance?: { isZero(): boolean; toString(): string };
        balanceType?: unknown;
      }>;
    };
    for (const p of view.perpPositions ?? []) {
      if (!p.baseAssetAmount || p.baseAssetAmount.isZero()) continue;
      perp.push({
        marketIndex: p.marketIndex,
        baseAmount: p.baseAssetAmount.toString(),
        quoteAmount: p.quoteAssetAmount?.toString() ?? '0',
      });
    }
    for (const s of view.spotPositions ?? []) {
      if (!s.scaledBalance || s.scaledBalance.isZero()) continue;
      const t = s.balanceType;
      spot.push({
        marketIndex: s.marketIndex,
        scaledBalance: s.scaledBalance.toString(),
        balanceType: t && typeof t === 'object' ? Object.keys(t)[0] ?? 'unknown' : String(t),
      });
    }
  }
  return { perp, spot };
}
