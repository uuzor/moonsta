import { loadEnv, optional } from '@sentinel/config';
import {
  closePool,
  ensureUserByTelegram,
  ensureWallet,
  insertAuditEvent,
  insertSnapshot,
  listActiveRules,
} from '@sentinel/db';
import {
  HoldingInput,
  RuleSummary,
  buildReport,
  formatReportText,
} from '@sentinel/portfolio';
import { solanaAdapter } from '@sentinel/chain-solana';

loadEnv();

const adapter = solanaAdapter;

function usage(): never {
  console.error('Usage: npm run report -- <WALLET_ADDRESS> [--json] [--no-db] [--rpc URL]');
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const address = args.find((a) => !a.startsWith('--'));
  if (!address) usage();
  const asJson = args.includes('--json');
  const useDb = !args.includes('--no-db');
  const rpcFlag = args.indexOf('--rpc');
  const rpcUrl = rpcFlag >= 0 ? args[rpcFlag + 1] : undefined;
  if (rpcFlag >= 0 && !rpcUrl) usage();

  try {
    adapter.assertAddress(address);
  } catch {
    console.error(`Invalid Solana address: ${address}`);
    process.exit(2);
  }
  if (rpcUrl) process.env.RPC_URL = rpcUrl;

  const [native, spl] = await Promise.all([
    adapter.getNativeBalance(address),
    adapter.getTokenBalances(address),
  ]);

  const nativeMint = adapter.nativeMint ?? '';
  const mints = [nativeMint, ...spl.map((s) => s.mint)];
  const prices = await adapter.getUsdPrices(mints);

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
    positions = await adapter.getPositions(address);
  } catch (err) {
    console.error(`warning: positions read failed (${(err as Error).message}); continuing without it`);
  }

  let rules: RuleSummary[] = [];
  let walletId: string | null = null;
  if (useDb) {
    try {
      const user = await ensureUserByTelegram(optional('REPORT_USER', 'local-cli'));
      const wallet = await ensureWallet(user.id, 'solana', address);
      walletId = wallet.id;
      rules = (await listActiveRules(wallet.id)).map((r) => ({
        id: r.id,
        kind: r.kind,
        asset: r.asset,
        status: r.status,
      }));
    } catch (err) {
      console.error(`warning: db unavailable (${(err as Error).message}); continuing without it`);
    }
  }

  const report = buildReport({ wallet: address, holdings, positions, rules });
  if (walletId) {
    try {
      await insertSnapshot(walletId, report.totalUsd, report);
      await insertAuditEvent({
        walletId,
        actor: 'user',
        action: 'report',
        detail: { totalUsd: report.totalUsd },
      });
    } catch (err) {
      console.error(`warning: snapshot/audit write failed (${(err as Error).message})`);
    } finally {
      await closePool();
    }
  }

  if (asJson) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReportText(report));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
