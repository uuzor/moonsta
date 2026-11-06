import { getAdapter } from '@sentinel/chain';
import {
  claimDueActions,
  enqueueReaction,
  finishAction,
  type ScheduledAction,
} from '@sentinel/db';
import { registerJob } from '@sentinel/jobs';
import { symbolFor } from '@sentinel/portfolio';

interface BaselineHolding {
  amountRaw: string;
  decimals: number;
}

interface CheckParams {
  chain?: string;
  address?: string;
  baseline?: { native?: BaselineHolding; tokens?: Record<string, BaselineHolding> };
}

function uiAmount(raw: string, decimals: number): number {
  return Number(BigInt(raw)) / 10 ** decimals;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: n < 1 && n > 0 ? 6 : 4 });
}

/** Deterministic balance diff. Reports deposits AND withdrawals honestly; silence is not an option. */
export function diffBalances(params: CheckParams, current: { nativeRaw: string; nativeDecimals: number; tokens: Record<string, { amountRaw: string; decimals: number }> }): string {
  const base = params.baseline;
  if (!base?.native) return 'no baseline was recorded; cannot compare';
  const lines: string[] = [];
  const dNative = uiAmount(current.nativeRaw, current.nativeDecimals) - uiAmount(base.native.amountRaw, base.native.decimals);
  if (dNative !== 0) {
    lines.push(`native ${dNative > 0 ? '+' : ''}${fmt(dNative)} (${fmt(uiAmount(base.native.amountRaw, base.native.decimals))} → ${fmt(uiAmount(current.nativeRaw, current.nativeDecimals))})`);
  }
  const baseTokens = base.tokens ?? {};
  const mints = new Set([...Object.keys(baseTokens), ...Object.keys(current.tokens)]);
  for (const mint of mints) {
    const b = baseTokens[mint];
    const c = current.tokens[mint];
    const bUi = b ? uiAmount(b.amountRaw, b.decimals) : 0;
    const cUi = c ? uiAmount(c.amountRaw, c.decimals) : 0;
    if (cUi !== bUi) {
      lines.push(`${symbolFor(mint)} ${cUi - bUi > 0 ? '+' : ''}${fmt(cUi - bUi)} (${fmt(bUi)} → ${fmt(cUi)})`);
    }
  }
  if (lines.length === 0) return 'no balance change since the baseline snapshot';
  return lines.join('; ');
}

async function fireBalanceCheck(action: ScheduledAction): Promise<string> {
  const params = (action.params ?? {}) as CheckParams;
  if (!params.chain || !params.address) throw new Error('balance_check is missing chain/address');
  const adapter = getAdapter(params.chain);
  const [native, spl] = await Promise.all([
    adapter.getNativeBalance(params.address),
    adapter.getTokenBalances(params.address),
  ]);
  return diffBalances(params, {
    nativeRaw: native.amountRaw,
    nativeDecimals: native.decimals,
    tokens: Object.fromEntries(spl.map((t) => [t.mint, { amountRaw: t.amountRaw, decimals: t.decimals }])),
  });
}

export async function drainDueActions(batch = 10): Promise<{ claimed: number; done: number; failed: number }> {
  const out = { claimed: 0, done: 0, failed: 0 };
  const actions = await claimDueActions(batch);
  out.claimed = actions.length;
  for (const action of actions) {
    try {
      let result: string | null = null;
      if (action.kind === 'reminder') result = action.message;
      else if (action.kind === 'balance_check') result = await fireBalanceCheck(action);
      await enqueueReaction({
        userId: action.user_id,
        walletId: action.wallet_id ?? undefined,
        kind: 'scheduled_fired',
        notifyPolicy: 'notify_first',
        payload: { actionId: action.id, actionKind: action.kind, message: action.message, result },
      });
      await finishAction(action.id, 'done');
      out.done += 1;
    } catch (err) {
      await finishAction(action.id, 'failed', err instanceof Error ? err.message : String(err));
      out.failed += 1;
    }
  }
  return out;
}

export function registerDueJob(): void {
  registerJob({
    name: 'due-actions',
    description: 'Fire due user-scheduled actions (reminders, balance checks, research briefs).',
    cron: '* * * * *',
    run: async () => {
      const out = await drainDueActions();
      return { ok: true, summary: `claimed ${out.claimed}, done ${out.done}, failed ${out.failed}` };
    },
  });
}
