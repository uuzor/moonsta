import readline from 'node:readline';
import { loadEnv, optional } from '@sentinel/config';
import {
  closePool,
  ensureUserByTelegram,
  ensureWallet,
  insertAuditEvent,
  listActiveRules,
} from '@sentinel/db';
import { MIN_GUARD_USD, symbolFor } from '@sentinel/portfolio';
import { createRule } from '@sentinel/rules';
import { RiskScore, scoreHolding } from '@sentinel/risk';
import { USDC_MINT, solanaAdapter } from '@sentinel/chain-solana';

loadEnv();

const adapter = solanaAdapter;

function usage(): never {
  console.error(
    'Usage:\n' +
      '  npm run guard -- suggest <WALLET> [--mint MINT] [--apply] [--yes] [--json] [--no-db] [--rpc URL]\n' +
      '  npm run guard -- list <WALLET>',
  );
  process.exit(2);
}

function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    }),
  );
}

function formatSuggestion(s: RiskScore): string {
  const factors = s.factors.map((f) => `${f.name}: ${f.detail} (+${f.points})`).join(' · ');
  const g = s.suggestion;
  const action = g.auto
    ? `auto-swap up to ${g.max_size_pct}% to USDC`
    : 'alert-only (no auto-swap)';
  return (
    `${symbolFor(s.mint)} (${s.mint.slice(0, 4)}…${s.mint.slice(-4)}): ` +
    `score ${s.score}/100 ${s.grade.toUpperCase()}\n  ${factors}\n  → suggest: trailing stop -${g.width_pct}%, ${action}`
  );
}

async function suggest(args: string[]): Promise<void> {
  const walletArg = args.find((a) => !a.startsWith('--'));
  if (!walletArg) usage();
  try {
    adapter.assertAddress(walletArg);
  } catch {
    console.error(`Invalid address: ${walletArg}`);
    process.exit(2);
  }
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const onlyMint = flag('--mint');
  const apply = args.includes('--apply');
  const yes = args.includes('--yes');
  const asJson = args.includes('--json');
  const useDb = !args.includes('--no-db');
  const rpcUrl = flag('--rpc');
  if (rpcUrl) process.env.RPC_URL = rpcUrl;

  let mints: string[];
  if (onlyMint) {
    adapter.assertAddress(onlyMint);
    mints = [onlyMint];
    try {
      if (onlyMint === adapter.nativeMint) {
        const b = await adapter.getNativeBalance(walletArg);
        if (!asJson) console.log(`Balance: ${b.amount}\n`);
      } else {
        const all = await adapter.getTokenBalances(walletArg);
        const bal = all.find((b) => b.mint === onlyMint);
        if (!asJson) console.log(`Balance: ${bal?.uiAmount ?? 'none'}\n`);
      }
    } catch {
      if (!asJson) console.log('Balance: unknown\n');
    }
  } else {
    const [native, spl] = await Promise.all([
      adapter.getNativeBalance(walletArg),
      adapter.getTokenBalances(walletArg),
    ]);
    const nativeMint = adapter.nativeMint ?? '';
    const all = [nativeMint, ...spl.map((s) => s.mint)];
    const prices = await adapter.getUsdPrices(all);
    const values = new Map<string, number>();
    values.set(nativeMint, native.amount * (prices.get(nativeMint)?.usdPrice ?? 0));
    for (const s of spl) values.set(s.mint, s.uiAmount * (prices.get(s.mint)?.usdPrice ?? 0));
    mints = [...values.entries()].filter(([, v]) => v >= MIN_GUARD_USD).map(([m]) => m);
    if (mints.length === 0) {
      console.log(`No holdings above $${MIN_GUARD_USD} to guard.`);
      return;
    }
  }

  const scores: RiskScore[] = [];
  for (const mint of mints) scores.push(await scoreHolding(adapter, mint));

  // Stablecoins have nothing safer to auto-rotate into: alert-only.
  const stables = new Set([USDC_MINT, 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
  for (const s of scores) {
    if (stables.has(s.mint) && s.suggestion.auto) {
      s.suggestion = {
        ...s.suggestion,
        auto: false,
        max_size_pct: 0,
        reason: 'stablecoin: alert-only, nothing safer to rotate into',
      };
    }
  }

  if (asJson) {
    console.log(JSON.stringify(scores, null, 2));
  } else {
    for (const s of scores) console.log(formatSuggestion(s) + '\n');
  }

  if (!apply) return;
  if (!useDb) {
    console.error('--apply requires the database (drop --no-db)');
    process.exit(2);
  }
  const user = await ensureUserByTelegram(optional('REPORT_USER', 'local-cli'));
  const wallet = await ensureWallet(user.id, 'solana', walletArg);
  const covered = new Set((await listActiveRules(wallet.id)).map((r) => r.asset));
  const fresh = scores.filter((s) => !covered.has(s.mint));
  const skipped = scores.length - fresh.length;
  if (skipped > 0 && !asJson) console.log(`${skipped} token(s) already guarded, skipped.`);
  if (fresh.length === 0) {
    await closePool();
    return;
  }
  if (!yes && !(await confirm(`Apply ${fresh.length} guard rule(s)? [y/N] `))) {
    console.log('Aborted.');
    await closePool();
    return;
  }
  for (const s of fresh) {
    const g = s.suggestion;
    const rule = await createRule({
      walletId: wallet.id,
      kind: 'trailing_stop',
      asset: s.mint,
      params: { width_pct: g.width_pct },
      action: g.auto
        ? { type: 'swap', max_size_pct: g.max_size_pct, to_mint: USDC_MINT }
        : { type: 'alert' },
    });
    await insertAuditEvent({
      walletId: wallet.id,
      actor: 'user',
      action: 'rule_apply',
      detail: { ruleId: rule.id, asset: s.mint, grade: s.grade },
    });
    if (!asJson) console.log(`Applied ${rule.id.slice(0, 8)}… on ${symbolFor(s.mint)} (${s.grade})`);
  }
  await closePool();
}

async function list(args: string[]): Promise<void> {
  const walletArg = args.find((a) => !a.startsWith('--'));
  if (!walletArg) usage();
  const user = await ensureUserByTelegram(optional('REPORT_USER', 'local-cli'));
  const wallet = await ensureWallet(user.id, 'solana', walletArg);
  const rules = await listActiveRules(wallet.id);
  await closePool();
  if (rules.length === 0) {
    console.log('No active guard rules.');
    return;
  }
  for (const r of rules) {
    console.log(
      `• ${r.id.slice(0, 8)}… ${r.kind} on ${symbolFor(r.asset)} ` +
        `params=${JSON.stringify(r.params)} action=${JSON.stringify(r.action)}`,
    );
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd.startsWith('--')) {
    await suggest(process.argv.slice(2)); // default command
  } else if (cmd === 'suggest') {
    await suggest(rest);
  } else if (cmd === 'list') {
    await list(rest);
  } else {
    usage();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
