import { getAdapter } from '@sentinel/chain';
import { insertSnapshot, listActiveRules, listAllWallets } from '@sentinel/db';
import { registerJob } from '@sentinel/jobs';
import { buildReport, type HoldingInput } from '@sentinel/portfolio';

/**
 * Snapshot every tracked wallet (same assemble flow as `npm run report`).
 * Per-wallet failures degrade (recorded in the summary) so one bad RPC
 * response never blocks the rest. Snapshots feed PnL baselines and the
 * research digest.
 */
export async function snapshotAllWallets(): Promise<{
  wallets: number;
  snapshots: number;
  failed: string[];
}> {
  const wallets = await listAllWallets();
  let snapshots = 0;
  const failed: string[] = [];
  for (const wallet of wallets) {
    try {
      const adapter = getAdapter(wallet.chain);
      const [native, spl] = await Promise.all([
        adapter.getNativeBalance(wallet.address),
        adapter.getTokenBalances(wallet.address),
      ]);
      const nativeMint = adapter.nativeMint ?? '';
      const prices = await adapter.getUsdPrices([nativeMint, ...spl.map((s) => s.mint)]);
      const holdings: HoldingInput[] = [
        {
          mint: nativeMint,
          amount: native.amount,
          usdPrice: prices.get(nativeMint)?.usdPrice,
          change24h: prices.get(nativeMint)?.change24h,
        },
        ...spl.map((s) => ({
          mint: s.mint,
          amount: s.uiAmount,
          usdPrice: prices.get(s.mint)?.usdPrice,
          change24h: prices.get(s.mint)?.change24h,
        })),
      ];
      let positions = null;
      try {
        positions = await adapter.getPositions(wallet.address);
      } catch {
        positions = null;
      }
      const rules = (await listActiveRules(wallet.id)).map((r) => ({
        id: r.id,
        kind: r.kind,
        asset: r.asset,
        status: r.status,
      }));
      const report = buildReport({ wallet: wallet.address, holdings, positions, rules });
      await insertSnapshot(wallet.id, report.totalUsd, report);
      snapshots += 1;
    } catch (err) {
      failed.push(`${wallet.chain}:${wallet.address}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { wallets: wallets.length, snapshots, failed };
}

export function registerSnapshotJob(): void {
  registerJob({
    name: 'snapshot-wallets',
    description: 'Periodic portfolio snapshots for all tracked wallets (PnL baseline + digest input).',
    cron: '*/15 * * * *',
    run: async (ctx) => {
      const out = await snapshotAllWallets();
      for (const failure of out.failed) ctx.log(`[snapshot] ${failure}`);
      return {
        ok: out.failed.length === 0,
        summary: `snapshotted ${out.snapshots}/${out.wallets} wallet(s), ${out.failed.length} failed`,
      };
    },
  });
}
