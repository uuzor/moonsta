import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  EvalRule,
  enqueueReaction,
  insertAuditEvent,
  listActiveRulesForEval,
  recordSpend,
  registerPosition,
  releaseTrigger,
  tryInsertTrigger,
  updateRuleState,
} from '@sentinel/db';
import { PolicyDeniedError, assertSwapAllowed } from '@sentinel/policy';
import { setRuleStatus } from '@sentinel/rules';
import {
  SOL_MINT,
  executeSwap,
  getSolBalance,
  getSplBalances,
  getUsdPrices,
} from '@sentinel/chain-solana';

export interface RuleState {
  baseline?: number;
  high?: number;
}

export interface Decision {
  fire: boolean;
  state: RuleState;
  detail: string;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Pure trigger decision for spot price rules. Bad prices never fire. */
export function decideOnPrice(
  kind: string,
  params: Record<string, unknown>,
  state: RuleState,
  price: number,
): Decision {
  if (!(price > 0)) return { fire: false, state, detail: 'bad price' };
  if (kind === 'price_drop') {
    const threshold = num(params.threshold_pct);
    if (threshold === null) throw new Error('price_drop rule missing threshold_pct');
    const reference = params.reference ?? 'current';
    const baseline =
      reference === 'fixed' ? num(params.reference_price) : (state.baseline ?? price);
    if (baseline === null || !(baseline > 0)) {
      throw new Error('price_drop rule has no usable baseline');
    }
    const next: RuleState = { ...state, baseline };
    const dropPct = ((baseline - price) / baseline) * 100;
    const fire = dropPct >= threshold;
    return { fire, state: next, detail: `drop ${dropPct.toFixed(2)}% vs ${threshold}%` };
  }
  if (kind === 'trailing_stop') {
    const width = num(params.width_pct);
    if (width === null) throw new Error('trailing_stop rule missing width_pct');
    const high = Math.max(state.high ?? price, price);
    const dropPct = ((high - price) / high) * 100;
    const fire = dropPct >= width;
    return { fire, state: { ...state, high }, detail: `off-high ${dropPct.toFixed(2)}% vs ${width}%` };
  }
  throw new Error(`unsupported rule kind for price eval: ${kind}`);
}

export interface EvalContext {
  connection: Connection;
  agent: Keypair;
  dryRun: boolean;
}

export interface EvalSummary {
  checked: number;
  fired: number;
  executed: number;
  skipped: string[];
  errors: string[];
}

/** Lamports always left in the agent wallet for fees when selling SOL. */
export const FEE_BUFFER_LAMPORTS = 10_000_000;

async function sizeRaw(
  ctx: EvalContext,
  mint: string,
  maxSizePct: number,
): Promise<{ raw: string; decimals: number } | null> {
  if (mint === SOL_MINT) {
    const { lamports } = await getSolBalance(ctx.connection, ctx.agent.publicKey);
    const raw = Math.floor(((lamports - FEE_BUFFER_LAMPORTS) * maxSizePct) / 100);
    return raw > 0 ? { raw: String(raw), decimals: 9 } : null;
  }
  const balances = await getSplBalances(ctx.connection, ctx.agent.publicKey);
  const bal = balances.find((b) => b.mint === mint);
  if (!bal) return null;
  const raw = (BigInt(bal.amountRaw) * BigInt(Math.floor(maxSizePct))) / 100n;
  return raw > 0n ? { raw: raw.toString(), decimals: bal.decimals } : null;
}

async function performAction(
  ctx: EvalContext,
  rule: EvalRule,
  price: number,
  summary: EvalSummary,
): Promise<void> {
  const action = rule.action as
    | { type: 'alert' }
    | { type: 'swap'; max_size_pct: number; to_mint: string };
  if (action.type === 'alert' || !rule.is_agent_wallet) {
    const downgraded = action.type !== 'alert';
    await insertAuditEvent({
      walletId: rule.wallet_id,
      actor: 'agent',
      action: downgraded ? 'rule_downgraded' : 'rule_alert',
      detail: {
        ruleId: rule.id,
        asset: rule.asset,
        price,
        reason: downgraded ? 'watched wallet is not agent-controlled' : undefined,
      },
    });
    await setRuleStatus(rule.id, 'expired');
    await enqueueReaction({
      userId: rule.user_id,
      walletId: rule.wallet_id,
      kind: 'rule_fired',
      notifyPolicy: 'notify_first',
      payload: {
        ruleId: rule.id,
        kind: rule.kind,
        asset: rule.asset,
        price,
        actionTaken: downgraded ? 'downgraded' : 'alert',
        reason: downgraded ? 'watched wallet is not agent-controlled' : undefined,
      },
    });
    return;
  }

  const sized = await sizeRaw(ctx, rule.asset, action.max_size_pct);
  if (sized === null) {
    await insertAuditEvent({
      walletId: rule.wallet_id,
      actor: 'agent',
      action: 'rule_skipped_empty',
      detail: { ruleId: rule.id, asset: rule.asset },
    });
    await setRuleStatus(rule.id, 'expired');
    await enqueueReaction({
      userId: rule.user_id,
      walletId: rule.wallet_id,
      kind: 'rule_fired',
      notifyPolicy: 'notify_first',
      payload: {
        ruleId: rule.id,
        kind: rule.kind,
        asset: rule.asset,
        price,
        actionTaken: 'skipped_empty',
        reason: 'agent wallet holds none of the asset',
      },
    });
    return;
  }
  const amountRaw = sized.raw;
  const usdValue = (Number(amountRaw) / 10 ** sized.decimals) * price;

  const result = await executeSwap({
    connection: ctx.connection,
    keypair: ctx.agent,
    inputMint: rule.asset,
    outputMint: action.to_mint,
    amountRaw,
    slippageBps: 50,
    dryRun: ctx.dryRun,
    beforeBuild: (quote) =>
      assertSwapAllowed({
        walletId: rule.wallet_id,
        inputMint: rule.asset,
        outputMint: action.to_mint,
        amountRaw,
        usdValue,
        slippageBps: 50,
        quote,
      }),
  });
  if (!ctx.dryRun && result.signature) {
    await recordSpend(rule.wallet_id, usdValue, 'swap', result.signature);
  }
  await registerPosition({
    walletId: rule.wallet_id,
    venue: 'jupiter',
    market: `${rule.asset}->${action.to_mint}`,
    side: 'sell',
    entryPrice: price,
    meta: { ruleId: rule.id, signature: result.signature, outAmount: result.outAmount, dryRun: ctx.dryRun },
  });
  await insertAuditEvent({
    walletId: rule.wallet_id,
    actor: 'agent',
    action: ctx.dryRun ? 'rule_dry_run' : 'rule_executed',
    detail: { ruleId: rule.id, asset: rule.asset, amountRaw, outAmount: result.outAmount, signature: result.signature },
  });
  if (ctx.dryRun) {
    // Dry runs must never consume real rules: release the claim.
    await releaseTrigger(`fire:${rule.id}`);
  } else {
    await setRuleStatus(rule.id, 'expired');
    await enqueueReaction({
      userId: rule.user_id,
      walletId: rule.wallet_id,
      kind: 'rule_fired',
      notifyPolicy: 'act_then_notify',
      payload: {
        ruleId: rule.id,
        kind: rule.kind,
        asset: rule.asset,
        price,
        actionTaken: 'swap',
        amountRaw,
        outAmount: result.outAmount,
        signature: result.signature,
      },
    });
  }
  summary.executed += 1;
}

/** One evaluation pass over all active rules. Rules fire at most once. */
export async function evaluateOnce(ctx: EvalContext): Promise<EvalSummary> {
  const summary: EvalSummary = { checked: 0, fired: 0, executed: 0, skipped: [], errors: [] };
  const rules = await listActiveRulesForEval();
  const mints = [...new Set(rules.map((r) => r.asset).filter((a) => !a.startsWith('drift:')))];
  if (mints.length === 0) return summary;
  const prices = await getUsdPrices(mints);

  for (const rule of rules) {
    if (rule.asset.startsWith('drift:') || rule.kind === 'liq_distance') {
      summary.skipped.push(`${rule.id.slice(0, 8)}:liq-deferred`);
      continue;
    }
    summary.checked += 1;
    try {
      const price = prices.get(rule.asset)?.usdPrice;
      if (price === undefined) {
        summary.skipped.push(`${rule.id.slice(0, 8)}:unpriced`);
        continue;
      }
      const decision = decideOnPrice(
        rule.kind,
        (rule.params as Record<string, unknown>) ?? {},
        (rule.state as RuleState) ?? {},
        price,
      );
      await updateRuleState(rule.id, decision.state);
      if (!decision.fire) continue;
      const key = `fire:${rule.id}`;
      const claimed = await tryInsertTrigger(rule.id, key, 'fired', {
        price,
        detail: decision.detail,
      });
      if (!claimed) {
        summary.skipped.push(`${rule.id.slice(0, 8)}:already-claimed`);
        continue;
      }
      summary.fired += 1;
      try {
        await performAction(ctx, rule, price, summary);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof PolicyDeniedError) {
          await setRuleStatus(rule.id, 'expired');
          await insertAuditEvent({
            walletId: rule.wallet_id,
            actor: 'agent',
            action: 'rule_denied',
            detail: { ruleId: rule.id, error: msg },
          });
          await enqueueReaction({
            userId: rule.user_id,
            walletId: rule.wallet_id,
            kind: 'rule_fired',
            notifyPolicy: 'notify_first',
            payload: {
              ruleId: rule.id,
              kind: rule.kind,
              asset: rule.asset,
              price,
              actionTaken: 'denied',
              reason: msg,
            },
          });
          summary.skipped.push(`${rule.id.slice(0, 8)}:denied`);
          continue;
        }
        await releaseTrigger(key);
        summary.errors.push(`${rule.id.slice(0, 8)}:${msg}`);
        await insertAuditEvent({
          walletId: rule.wallet_id,
          actor: 'agent',
          action: 'rule_failed',
          detail: { ruleId: rule.id, error: msg },
        });
      }
    } catch (err) {
      summary.errors.push(`${rule.id.slice(0, 8)}:${err instanceof Error ? err.message : err}`);
    }
  }
  return summary;
}

export function agentPublicKey(ctx: EvalContext): PublicKey {
  return ctx.agent.publicKey;
}
