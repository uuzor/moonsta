import { PublicKey } from '@solana/web3.js';
import { loadEnv, optional } from '@sentinel/config';
import {
  closePool,
  ensureUserByTelegram,
  ensureWallet,
  getPolicy,
  listPendingProposals,
  listWithdrawalAddresses,
  setPaused,
  setPolicyCaps,
} from '@sentinel/db';
import {
  approveProposal,
  previewProposal,
  rejectProposal,
  requestSwapProposal,
  requestWithdrawal,
  revokeAddress,
  addAddress as addAllowlistAddress,
} from '@sentinel/policy';
import {
  SOL_MINT,
  createConnection,
  getUsdPrices,
  loadAgentKeypair,
  solanaAdapter,
} from '@sentinel/chain-solana';

loadEnv();

function usage(): never {
  console.error(
    'Usage:\n' +
      '  policy limits <WALLET> [--daily USD] [--per-tx USD]\n' +
      '  policy pause <WALLET> | resume <WALLET>\n' +
      '  policy addr add <WALLET> <ADDRESS> [--label L] | list <WALLET> | revoke <WALLET> <ADDRESS>\n' +
      '  policy withdraw request <WALLET> <MINT|SOL> <AMOUNT> <TO_ADDRESS>\n' +
      '  policy swap-propose <WALLET> <IN_MINT> <OUT_MINT> <AMOUNT_RAW> [--slippage BPS] [--reason R]\n' +
      '  policy proposals <WALLET>\n' +
      '  policy approve <PROPOSAL_ID> [--dry-run] | reject <PROPOSAL_ID>',
  );
  process.exit(2);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function resolveWallet(address: string) {
  const user = await ensureUserByTelegram(optional('REPORT_USER', 'local-cli'));
  return ensureWallet(user.id, 'solana', new PublicKey(address).toBase58());
}

function mintArg(a: string): string {
  return a === 'SOL' ? SOL_MINT : new PublicKey(a).toBase58();
}

async function uiToRaw(mint: string, amountUi: string): Promise<{ raw: string; decimals: number }> {
  const amount = Number(amountUi);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be positive');
  if (mint === SOL_MINT) return { raw: String(Math.round(amount * 1e9)), decimals: 9 };
  const info = await solanaAdapter.getMintInfo(mint);
  if (!info) throw new Error('mint not found on-chain');
  return { raw: String(Math.round(amount * 10 ** info.decimals)), decimals: info.decimals };
}

async function limits(args: string[]): Promise<void> {
  const [walletArg] = args;
  if (!walletArg) usage();
  const wallet = await resolveWallet(walletArg);
  const daily = flag(args, '--daily');
  const perTx = flag(args, '--per-tx');
  if (daily !== undefined || perTx !== undefined) {
    const row = await setPolicyCaps(wallet.id, {
      dailyCapUsd: daily !== undefined ? Number(daily) : undefined,
      perTxCapUsd: perTx !== undefined ? Number(perTx) : undefined,
    });
    console.log(`caps: daily=$${row.daily_cap_usd} per-tx=$${row.per_tx_cap_usd} paused=${row.paused}`);
  } else {
    const row = await getPolicy(wallet.id);
    console.log(`caps: daily=$${row.daily_cap_usd} per-tx=$${row.per_tx_cap_usd} paused=${row.paused}`);
  }
  await closePool();
}

async function pauseResume(args: string[], paused: boolean): Promise<void> {
  const [walletArg] = args;
  if (!walletArg) usage();
  const wallet = await resolveWallet(walletArg);
  await setPaused(wallet.id, paused);
  console.log(paused ? 'paused' : 'resumed');
  await closePool();
}

async function addr(args: string[]): Promise<void> {
  const [sub, walletArg, address] = args;
  if (!sub || !walletArg || (sub !== 'list' && !address)) usage();
  const wallet = await resolveWallet(walletArg);
  if (sub === 'add' && address) {
    const row = await addAllowlistAddress(wallet.id, new PublicKey(address).toBase58(), flag(args, '--label'));
    console.log(`added ${row.address.slice(0, 8)}… status=${row.status} usable after ${row.active_at}`);
  } else if (sub === 'list') {
    const rows = await listWithdrawalAddresses(wallet.id);
    if (rows.length === 0) console.log('(empty allowlist)');
    for (const r of rows) {
      console.log(`• ${r.address} [${r.status}] usable after ${r.active_at}${r.label ? ` (${r.label})` : ''}`);
    }
  } else if (sub === 'revoke' && address) {
    await revokeAddress(wallet.id, new PublicKey(address).toBase58());
    console.log('revoked');
  } else {
    usage();
  }
  await closePool();
}

async function withdrawRequest(args: string[]): Promise<void> {
  const [walletArg, mintA, amountUi, to] = args;
  if (!walletArg || !mintA || !amountUi || !to) usage();
  const wallet = await resolveWallet(walletArg);
  const mint = mintArg(mintA);
  const { raw } = await uiToRaw(mint, amountUi);
  const prices = await getUsdPrices([mint]);
  const usd = prices.get(mint)?.usdPrice;
  const p = await requestWithdrawal({
    walletId: wallet.id,
    mint,
    amountRaw: raw,
    toAddress: new PublicKey(to).toBase58(),
    usdValue: usd == null ? 0 : Number(amountUi) * usd,
  });
  if (usd == null) console.log('warning: unpriced token, USD caps cannot apply');
  console.log(`proposal ${p.id} pending, expires ${p.expires_at}`);
  await closePool();
}

async function swapPropose(args: string[]): Promise<void> {
  const [walletArg, inA, outA, raw] = args;
  if (!walletArg || !inA || !outA || !raw) usage();
  const wallet = await resolveWallet(walletArg);
  const inputMint = mintArg(inA);
  const outputMint = mintArg(outA);
  const p = await requestSwapProposal({
    walletId: wallet.id,
    inputMint,
    outputMint,
    amountRaw: raw,
    usdValue: 0,
    slippageBps: Number(flag(args, '--slippage') ?? 50),
    reason: flag(args, '--reason'),
  });
  console.log(`proposal ${p.id} pending, expires ${p.expires_at}`);
  await closePool();
}

async function proposals(args: string[]): Promise<void> {
  const [walletArg] = args;
  if (!walletArg) usage();
  const wallet = await resolveWallet(walletArg);
  const rows = await listPendingProposals(wallet.id);
  if (rows.length === 0) console.log('(no pending proposals)');
  for (const r of rows) {
    console.log(`• ${r.id} [${r.kind}] expires ${r.expires_at}\n  ${JSON.stringify(r.payload)}`);
  }
  await closePool();
}

async function approve(args: string[], dryRun: boolean): Promise<void> {
  const [id] = args;
  if (!id) usage();
  const deps = { connection: createConnection(), agent: loadAgentKeypair() };
  try {
    if (dryRun) {
      const r = await previewProposal(deps, id);
      console.log(`${r.kind}: ${r.summary} [simulation ${r.simulation}]`);
    } else {
      const r = await approveProposal(deps, id);
      console.log(`executed ${r.signature}`);
    }
  } finally {
    await closePool();
  }
}

async function reject(args: string[]): Promise<void> {
  const [id] = args;
  if (!id) usage();
  await rejectProposal(id);
  console.log('rejected');
  await closePool();
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'limits') await limits(rest);
  else if (cmd === 'pause') await pauseResume(rest, true);
  else if (cmd === 'resume') await pauseResume(rest, false);
  else if (cmd === 'addr') await addr(rest);
  else if (cmd === 'withdraw' && rest[0] === 'request') await withdrawRequest(rest.slice(1));
  else if (cmd === 'swap-propose') await swapPropose(rest);
  else if (cmd === 'proposals') await proposals(rest);
  else if (cmd === 'approve') await approve(rest, rest.includes('--dry-run'));
  else if (cmd === 'reject') await reject(rest);
  else usage();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
