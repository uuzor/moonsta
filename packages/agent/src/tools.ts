import { tool } from 'ai';
import { z } from 'zod';
import { ChainAdapter, UnknownProtocolError } from '@sentinel/chain';
import {
  WalletRow,
  cancelScheduledAction,
  ensureUserByTelegram,
  ensureWallet,
  findWallet,
  insertAuditEvent,
  listActiveRules,
  listOpenPositions,
  listPendingProposals,
  listScheduledActions,
  listWallets,
  scheduleAction,
} from '@sentinel/db';
import { requestSwapProposal, requestWithdrawal } from '@sentinel/policy';
import { Report, RuleSummary, buildReport } from '@sentinel/portfolio';
import { scoreHolding } from '@sentinel/risk';
import { createRule, setRuleStatus } from '@sentinel/rules';
import { getAdapter } from './chains';

export interface ToolContext {
  telegramId: string;
}

async function ownWallet(
  ctx: ToolContext,
  chain: string,
  address: string,
): Promise<{ adapter: ChainAdapter; wallet: WalletRow }> {
  const adapter = getAdapter(chain);
  try {
    adapter.assertAddress(address);
  } catch {
    throw new Error(`Invalid ${chain} address: ${address}`);
  }
  const user = await ensureUserByTelegram(ctx.telegramId);
  const wallet = await findWallet(user.id, chain, address);
  if (!wallet) {
    throw new Error(
      `Wallet ${address} is not registered to you on ${chain}. Use register_wallet first.`,
    );
  }
  return { adapter, wallet };
}

/** Symbol shorthand (SOL, USDC) or a raw mint address. */
function resolveMint(adapter: ChainAdapter, input: string): string {
  const mapped = adapter.symbols[input.toUpperCase()];
  if (mapped) return mapped;
  try {
    adapter.assertAddress(input);
  } catch {
    const known = Object.keys(adapter.symbols).join(', ');
    throw new Error(`Unknown token '${input}'. Pass a mint address${known ? ` or one of: ${known}` : ''}.`);
  }
  return input;
}

async function resolveAmount(
  adapter: ChainAdapter,
  address: string | undefined,
  mint: string,
  amountRaw?: string,
  amountUi?: number,
): Promise<{ raw: string; decimals: number }> {
  if ((amountRaw == null) === (amountUi == null)) {
    throw new Error('Provide exactly one of amountRaw or amountUi');
  }
  const isNative = adapter.nativeMint !== null && mint === adapter.nativeMint;
  if (amountRaw != null) {
    if (!/^\d+$/.test(amountRaw) || amountRaw === '0') {
      throw new Error('amountRaw must be a positive integer string');
    }
    let decimals = 0;
    if (address !== undefined) {
      decimals = isNative
        ? (await adapter.getNativeBalance(address)).decimals
        : ((await adapter.getMintInfo(mint))?.decimals ?? 0);
    }
    return { raw: amountRaw, decimals };
  }
  if (!Number.isFinite(amountUi) || (amountUi as number) <= 0) {
    throw new Error('amountUi must be positive');
  }
  if (address === undefined) throw new Error('address is required with amountUi (for decimals)');
  const decimals = isNative
    ? (await adapter.getNativeBalance(address)).decimals
    : ((await adapter.getMintInfo(mint))?.decimals ?? null);
  if (decimals === null) throw new Error('Unknown mint on this chain');
  return { raw: String(Math.round((amountUi as number) * 10 ** decimals)), decimals };
}

async function walletTargets(
  ctx: ToolContext,
  chain: string | undefined,
  address: string | undefined,
): Promise<Array<{ chain: string; address: string }>> {
  if (address !== undefined && chain === undefined) {
    throw new Error('chain is required when address is given (addresses are ambiguous across chains)');
  }
  if (address !== undefined && chain !== undefined) {
    const { wallet } = await ownWallet(ctx, chain, address);
    return [{ chain, address: wallet.address }];
  }
  if (chain !== undefined) getAdapter(chain);
  const user = await ensureUserByTelegram(ctx.telegramId);
  return (await listWallets(user.id, chain)).map((w) => ({ chain: w.chain, address: w.address }));
}

const chainArg = z.string().describe('Chain id, e.g. solana');
const addressArg = z.string().describe('User wallet address on that chain');

export function buildTools(ctx: ToolContext, onCall?: (name: string) => void) {
  const wrap = <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    onCall?.(name);
    return fn();
  };

  return {
    register_wallet: tool({
      description: 'Register one of the user\'s wallet addresses for tracking on a chain.',
      inputSchema: z.object({
        chain: chainArg,
        address: addressArg,
        label: z.string().optional().describe('Friendly label, e.g. main vault'),
      }),
      execute: async ({ chain, address, label }) =>
        wrap('register_wallet', async () => {
          const adapter = getAdapter(chain);
          try {
            adapter.assertAddress(address);
          } catch {
            throw new Error(`Invalid ${chain} address: ${address}`);
          }
          const user = await ensureUserByTelegram(ctx.telegramId);
          const wallet = await ensureWallet(user.id, chain, address, label);
          await insertAuditEvent({
            walletId: wallet.id,
            actor: 'user',
            action: 'wallet_registered',
            detail: { chain, address },
          });
          return { walletId: wallet.id, chain, address };
        }),
    }),

    list_wallets: tool({
      description: 'List the wallets the user has registered for tracking, optionally on one chain.',
      inputSchema: z.object({ chain: chainArg.optional() }),
      execute: async ({ chain }) =>
        wrap('list_wallets', async () => {
          if (chain !== undefined) getAdapter(chain);
          const user = await ensureUserByTelegram(ctx.telegramId);
          const rows = await listWallets(user.id, chain);
          return rows.map((w) => ({ chain: w.chain, address: w.address, label: w.label }));
        }),
    }),

    get_portfolio: tool({
      description:
        'Portfolio across one wallet, one chain, or everything tracked. Omit both chain and address to aggregate all registered wallets.',
      inputSchema: z.object({ chain: chainArg.optional(), address: addressArg.optional() }),
      execute: async ({ chain, address }) =>
        wrap('get_portfolio', async () => {
          const targets = await walletTargets(ctx, chain, address);
          if (targets.length === 0) {
            return {
              totalUsd: 0,
              wallets: [],
              note: 'No wallets registered yet. Use register_wallet first.',
            };
          }
          const user = await ensureUserByTelegram(ctx.telegramId);
          const wallets = [];
          for (const t of targets) {
            try {
              const adapter = getAdapter(t.chain);
              const wallet = await findWallet(user.id, t.chain, t.address);
              if (!wallet) continue;
              const [native, spl] = await Promise.all([
                adapter.getNativeBalance(t.address),
                adapter.getTokenBalances(t.address),
              ]);
              const nativeMint = adapter.nativeMint ?? '';
              const prices = await adapter.getUsdPrices([nativeMint, ...spl.map((s) => s.mint)]);
              const positions = await adapter.getPositions(t.address).catch(() => null);
              const rules: RuleSummary[] = (await listActiveRules(wallet.id)).map((r) => ({
                id: r.id,
                kind: r.kind,
                asset: r.asset,
                status: r.status,
              }));
              const report = buildReport({
                wallet: t.address,
                holdings: [
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
                ],
                positions,
                rules,
              });
              wallets.push({ chain: t.chain, address: t.address, report });
            } catch (e) {
              wallets.push({ chain: t.chain, address: t.address, error: (e as Error).message });
            }
          }
          const ok = wallets.filter(
            (w): w is { chain: string; address: string; report: Report } => 'report' in w,
          );
          const totalUsd = ok.reduce((s, w) => s + w.report.totalUsd, 0);
          let weight = 0;
          let changeSum = 0;
          for (const w of ok) {
            if (w.report.change24h != null) {
              weight += w.report.totalUsd;
              changeSum += w.report.totalUsd * w.report.change24h;
            }
          }
          return { totalUsd, change24h: weight > 0 ? changeSum / weight : null, wallets };
        }),
    }),

    get_positions: tool({
      description:
        'Open positions across one wallet, one chain, or everything tracked. Combines on-chain protocol positions with agent-tracked trades.',
      inputSchema: z.object({ chain: chainArg.optional(), address: addressArg.optional() }),
      execute: async ({ chain, address }) =>
        wrap('get_positions', async () => {
          const targets = await walletTargets(ctx, chain, address);
          if (targets.length === 0) return { wallets: [], note: 'No wallets registered yet.' };
          const user = await ensureUserByTelegram(ctx.telegramId);
          const wallets = [];
          for (const t of targets) {
            try {
              const adapter = getAdapter(t.chain);
              const wallet = await findWallet(user.id, t.chain, t.address);
              if (!wallet) continue;
              const [onchain, tracked] = await Promise.all([
                adapter.getPositions(t.address).catch((e) => ({ error: (e as Error).message })),
                listOpenPositions(wallet.id),
              ]);
              wallets.push({ chain: t.chain, address: t.address, onchain, tracked });
            } catch (e) {
              wallets.push({ chain: t.chain, address: t.address, error: (e as Error).message });
            }
          }
          return { wallets };
        }),
    }),

    score_token: tool({
      description: 'Risk score (0-100) for a token plus a suggested trailing-stop guard. Read-only.',
      inputSchema: z.object({
        chain: chainArg,
        mint: z.string().describe('Token mint address or symbol (e.g. SOL)'),
      }),
      execute: async ({ chain, mint }) =>
        wrap('score_token', async () => {
          const adapter = getAdapter(chain);
          return scoreHolding(adapter, resolveMint(adapter, mint));
        }),
    }),

    manage_guards: tool({
      description:
        'Guard rules: suggest (score only), apply (create the suggested trailing stop), create (custom rule with user threshold), list, pause, resume.',
      inputSchema: z.object({
        chain: chainArg,
        address: addressArg,
        action: z.enum(['suggest', 'apply', 'create', 'list', 'pause', 'resume']),
        mint: z.string().optional().describe('Token mint or symbol (suggest/apply/create)'),
        ruleId: z.string().optional().describe('Rule id (pause/resume)'),
        kind: z.enum(['price_drop', 'trailing_stop']).optional().describe('Rule kind (create)'),
        thresholdPct: z.number().optional().describe('Drop percent that fires the rule (create)'),
        alertOnly: z.boolean().optional().describe('Notify only, never swap (create, default true)'),
        maxSizePct: z.number().optional().describe('Max % to swap when firing (create with alertOnly=false)'),
        toMint: z.string().optional().describe('Swap destination mint or symbol (create with alertOnly=false)'),
      }),
      execute: async ({ chain, address, action, mint, ruleId, kind, thresholdPct, alertOnly, maxSizePct, toMint }) =>
        wrap('manage_guards', async () => {
          const { adapter, wallet } = await ownWallet(ctx, chain, address);
          if (action === 'list') {
            return (await listActiveRules(wallet.id)).map((r) => ({
              id: r.id,
              kind: r.kind,
              asset: r.asset,
              params: r.params,
              action: r.action,
            }));
          }
          if (action === 'pause' || action === 'resume') {
            if (!ruleId) throw new Error('ruleId is required');
            const row = await setRuleStatus(ruleId, action === 'pause' ? 'paused' : 'active');
            if (!row) throw new Error('Rule not found');
            return { id: row.id, status: row.status };
          }
          if (!mint) throw new Error('mint is required');
          const resolved = resolveMint(adapter, mint);
          if (action === 'create') {
            if (!kind) throw new Error('kind is required (price_drop | trailing_stop)');
            if (thresholdPct == null) throw new Error('thresholdPct is required');
            const stable = (adapter.stableMints as readonly string[]).includes(resolved);
            const alert = alertOnly ?? true;
            const params = kind === 'price_drop' ? { threshold_pct: thresholdPct } : { width_pct: thresholdPct };
            const rule = await createRule({
              walletId: wallet.id,
              kind,
              asset: resolved,
              params,
              action:
                alert || stable
                  ? { type: 'alert' }
                  : {
                      type: 'swap',
                      max_size_pct: maxSizePct ?? 30,
                      to_mint: toMint ? resolveMint(adapter, toMint) : ((adapter.stableMints[0] ?? resolved) as string),
                    },
            });
            await insertAuditEvent({
              walletId: wallet.id,
              actor: 'user',
              action: 'rule_create',
              detail: { ruleId: rule.id, kind, asset: resolved, alert: alert || stable, via: 'chat' },
            });
            return { ruleId: rule.id, kind, alert: alert || stable };
          }
          const score = await scoreHolding(adapter, resolved);
          if (action === 'suggest') return score;
          const covered = (await listActiveRules(wallet.id)).some((r) => r.asset === resolved);
          if (covered) return { alreadyGuarded: true, mint: resolved };
          const stable = (adapter.stableMints as readonly string[]).includes(resolved);
          const auto = score.suggestion.auto && !stable;
          const rule = await createRule({
            walletId: wallet.id,
            kind: 'trailing_stop',
            asset: resolved,
            params: { width_pct: score.suggestion.width_pct },
            action: auto
              ? {
                  type: 'swap',
                  max_size_pct: score.suggestion.max_size_pct,
                  to_mint: adapter.stableMints[0] ?? resolved,
                }
              : { type: 'alert' },
          });
          await insertAuditEvent({
            walletId: wallet.id,
            actor: 'user',
            action: 'rule_apply',
            detail: { ruleId: rule.id, asset: resolved, grade: score.grade, via: 'chat' },
          });
          return { ruleId: rule.id, grade: score.grade, auto };
        }),
    }),

    swap: tool({
      description:
        'Swaps. quote compares venues without moving anything; execute pre-checks balance and policy, then creates an approval the user must tap (it never sends from chat).',
      inputSchema: z.object({
        chain: chainArg,
        type: z.enum(['quote', 'execute']),
        baseToken: z.string().describe('Token to sell: mint or symbol'),
        outToken: z.string().describe('Token to buy: mint or symbol'),
        amountRaw: z.string().optional().describe('Input amount in base units (exactly one of raw/ui)'),
        amountUi: z.number().optional().describe('Human-readable input amount (needs address)'),
        protocol: z.string().optional().describe('One venue, or all supported when omitted'),
        slippageBps: z.number().optional().describe('Max slippage, 1..300 (default 50)'),
        address: z.string().optional().describe('Wallet (required for execute)'),
        reason: z.string().optional(),
      }),
      execute: async ({ chain, type, baseToken, outToken, amountRaw, amountUi, protocol, slippageBps, address, reason }) =>
        wrap('swap', async () => {
          const adapter = getAdapter(chain);
          const base = resolveMint(adapter, baseToken);
          const out = resolveMint(adapter, outToken);
          const slip = slippageBps ?? 50;
          if (!Number.isInteger(slip) || slip < 1 || slip > 300) {
            throw new Error('slippageBps must be 1..300');
          }
          if (protocol && !adapter.supportedProtocols.includes(protocol)) {
            throw new UnknownProtocolError(chain, protocol, adapter.supportedProtocols);
          }
          if (type === 'quote') {
            const { raw } = await resolveAmount(adapter, address, base, amountRaw, amountUi);
            const quotes = await adapter.quoteSwap({
              inputMint: base,
              outputMint: out,
              amountRaw: raw,
              slippageBps: slip,
              protocol,
            });
            const best = [...quotes].sort((a, b) => (BigInt(b.outAmount) > BigInt(a.outAmount) ? 1 : -1))[0];
            return {
              base,
              out,
              amountRaw: raw,
              slippageBps: slip,
              quotes: quotes.map((q) => ({ protocol: q.protocol, outAmount: q.outAmount })),
              best: best?.protocol ?? null,
              note: 'Quotes only — nothing moves.',
            };
          }
          if (!address) throw new Error('address is required to execute');
          const { wallet } = await ownWallet(ctx, chain, address);
          const { raw, decimals } = await resolveAmount(adapter, address, base, amountRaw, amountUi);
          const isNative = adapter.nativeMint !== null && base === adapter.nativeMint;
          const have = isNative
            ? BigInt((await adapter.getNativeBalance(address)).amountRaw)
            : BigInt((await adapter.getTokenBalances(address)).find((b) => b.mint === base)?.amountRaw ?? '0');
          if (have < BigInt(raw)) throw new Error('Insufficient balance for the proposed swap');
          const prices = await adapter.getUsdPrices([base]);
          const usd = prices.get(base)?.usdPrice;
          const proposal = await requestSwapProposal({
            walletId: wallet.id,
            inputMint: base,
            outputMint: out,
            amountRaw: raw,
            usdValue: usd == null ? 0 : (Number(raw) / 10 ** decimals) * usd,
            slippageBps: slip,
            protocol,
            reason,
          });
          return {
            proposalId: proposal.id,
            expires: proposal.expires_at,
            note: 'Swap prepared — the user must tap approve. Nothing moves until then.',
          };
        }),
    }),

    perp: tool({
      description:
        'Perpetuals. positions reviews open perps today; preview/open/close are not yet supported (Phase 2: drift execution).',
      inputSchema: z.object({
        chain: chainArg,
        address: addressArg,
        action: z.enum(['positions', 'preview', 'open', 'close']),
        market: z.string().optional().describe('e.g. SOL-PERP'),
        side: z.enum(['long', 'short']).optional(),
        sizeUi: z.number().optional(),
        leverage: z.number().optional(),
      }),
      execute: async ({ chain, address, action }) =>
        wrap('perp', async () => {
          const { adapter, wallet } = await ownWallet(ctx, chain, address);
          if (action === 'positions') {
            const onchain = await adapter.getPositions(address).catch((e) => ({ error: (e as Error).message }));
            const perps = Array.isArray(onchain) ? onchain.filter((p) => p.kind === 'perp') : onchain;
            const tracked = (await listOpenPositions(wallet.id)).filter((p) => p.venue === 'drift');
            return { perps, tracked };
          }
          return {
            supported: false,
            note: 'Perp trading ships in Phase 2 (drift execution). Positions review works today.',
          };
        }),
    }),

    request_withdrawal: tool({
      description:
        'Propose a withdrawal to an allowlisted address. Always needs explicit user approval.',
      inputSchema: z.object({
        chain: chainArg,
        address: addressArg,
        mint: z.string().describe('Token mint or symbol, or the native symbol for the base asset'),
        amountUi: z.number().describe('Human-readable amount, e.g. 1.5'),
        toAddress: z.string().describe('Destination (must be allowlisted and cooled down)'),
      }),
      execute: async ({ chain, address, mint, amountUi, toAddress }) =>
        wrap('request_withdrawal', async () => {
          const { adapter, wallet } = await ownWallet(ctx, chain, address);
          const resolved = resolveMint(adapter, mint);
          adapter.assertAddress(toAddress);
          const { raw } = await resolveAmount(adapter, address, resolved, undefined, amountUi);
          const prices = await adapter.getUsdPrices([resolved]);
          const usd = prices.get(resolved)?.usdPrice;
          const proposal = await requestWithdrawal({
            walletId: wallet.id,
            mint: resolved,
            amountRaw: raw,
            toAddress,
            usdValue: usd == null ? 0 : amountUi * usd,
          });
          return {
            proposalId: proposal.id,
            expires: proposal.expires_at,
            note: 'Withdrawals always need explicit user approval.',
          };
        }),
    }),

    get_proposals: tool({
      description: 'List pending approvals with plain explanations. The agent cannot approve.',
      inputSchema: z.object({ chain: chainArg, address: addressArg }),
      execute: async ({ chain, address }) =>
        wrap('get_proposals', async () => {
          const { wallet } = await ownWallet(ctx, chain, address);
          const rows = await listPendingProposals(wallet.id);
          return rows.map((r) => ({
            id: r.id,
            kind: r.kind,
            payload: r.payload,
            expires: r.expires_at,
            note: 'The user approves or rejects from chat buttons.',
          }));
        }),
    }),

    schedule: tool({
      description:
        'One-shot scheduled actions, delivered as a chat notification when due: reminder (say something later), balance_check (snapshot a wallet now, report any deposit/withdrawal at fire time), research (answer an on-chain research question at fire time). Convert the user\'s words to minutes (e.g. "in 3 hours" = 180).',
      inputSchema: z.object({
        action: z.enum(['create', 'list', 'cancel']),
        kind: z.enum(['reminder', 'balance_check', 'research']).optional().describe('Action kind (create)'),
        inMinutes: z.number().optional().describe('Minutes from now to fire, 1..43200 (create)'),
        message: z.string().optional().describe('Reminder text, check label, or research question (create)'),
        chain: chainArg.optional().describe('Wallet chain (balance_check, or to attach context)'),
        address: addressArg.optional().describe('Wallet address (balance_check, or to attach context)'),
        actionId: z.string().optional().describe('Scheduled action id (cancel)'),
      }),
      execute: async ({ action, kind, inMinutes, message, chain, address, actionId }) =>
        wrap('schedule', async () => {
          const user = await ensureUserByTelegram(ctx.telegramId);
          if (action === 'list') {
            return (await listScheduledActions(user.id)).map((r) => ({
              id: r.id,
              kind: r.kind,
              message: r.message,
              runAt: r.run_at,
              status: r.status,
            }));
          }
          if (action === 'cancel') {
            if (!actionId) throw new Error('actionId is required');
            const row = await cancelScheduledAction(actionId, user.id);
            if (!row) throw new Error('Action not found, not yours, or no longer pending');
            return { id: row.id, status: row.status };
          }
          if (!kind) throw new Error('kind is required (reminder | balance_check | research)');
          if (inMinutes == null || !Number.isInteger(inMinutes) || inMinutes < 1 || inMinutes > 43200) {
            throw new Error('inMinutes must be an integer 1..43200 (30 days)');
          }
          if (!message || message.length > 500) throw new Error('message is required (max 500 chars)');
          let wallet: WalletRow | null = null;
          if (address !== undefined) {
            if (chain === undefined) throw new Error('chain is required when address is given');
            wallet = (await ownWallet(ctx, chain, address)).wallet;
          } else if (kind === 'balance_check') {
            const owned = await listWallets(user.id, chain);
            if (owned.length === 0) throw new Error('No wallet to watch — track one first');
            if (owned.length > 1 && chain === undefined) {
              throw new Error('You have several wallets — which address should I watch?');
            }
            wallet = owned[0];
          }
          let params: unknown = {};
          if (kind === 'balance_check' && wallet) {
            const adapter = getAdapter(wallet.chain);
            const [native, spl] = await Promise.all([
              adapter.getNativeBalance(wallet.address),
              adapter.getTokenBalances(wallet.address),
            ]);
            params = {
              chain: wallet.chain,
              address: wallet.address,
              baseline: {
                native: { amountRaw: native.amountRaw, decimals: native.decimals },
                tokens: Object.fromEntries(spl.map((t) => [t.mint, { amountRaw: t.amountRaw, decimals: t.decimals }])),
              },
            };
          }
          const row = await scheduleAction({
            userId: user.id,
            walletId: wallet?.id,
            kind,
            message,
            params,
            runAt: new Date(Date.now() + inMinutes * 60_000),
          });
          await insertAuditEvent({
            walletId: wallet?.id ?? null,
            actor: 'user',
            action: 'scheduled',
            detail: { actionId: row.id, kind, runAt: row.run_at, via: 'chat' },
          });
          return { actionId: row.id, kind, message, runAt: row.run_at };
        }),
    }),
  };
}

export type MoonstaTools = ReturnType<typeof buildTools>;
