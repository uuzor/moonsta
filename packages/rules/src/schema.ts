// Strict validation for guard rules. The LLM proposes; this module disposes.
// Nothing reaches the worker or the executor without passing here.

export const RULE_KINDS = ['price_drop', 'trailing_stop', 'liq_distance'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export interface PriceDropParams {
  threshold_pct: number;
  reference?: 'current' | 'fixed';
  reference_price?: number;
}

export interface TrailingStopParams {
  width_pct: number;
}

export interface LiqDistanceParams {
  distance_pct: number;
}

export type RuleParams = PriceDropParams | TrailingStopParams | LiqDistanceParams;

export type RuleAction =
  | { type: 'alert' }
  | { type: 'swap'; max_size_pct: number; to_mint: string };

export interface ValidRule {
  kind: RuleKind;
  asset: string;
  params: RuleParams;
  action: RuleAction;
}

export type ValidationResult =
  | { ok: true; rule: ValidRule }
  | { ok: false; errors: string[] };

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DRIFT_ASSET_RE = /^drift:[A-Za-z0-9-]{1,32}$/;

function isMint(s: unknown): s is string {
  return typeof s === 'string' && BASE58_RE.test(s);
}

function isAsset(s: unknown): s is string {
  return (
    (typeof s === 'string' && BASE58_RE.test(s)) ||
    (typeof s === 'string' && DRIFT_ASSET_RE.test(s))
  );
}

function numIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

function validateParams(kind: RuleKind, params: unknown, errors: string[]): RuleParams | null {
  if (typeof params !== 'object' || params === null) {
    errors.push('params must be an object');
    return null;
  }
  const p = params as Record<string, unknown>;
  if (kind === 'price_drop') {
    if (!numIn(p.threshold_pct, 0.5, 90)) {
      errors.push('price_drop.threshold_pct must be 0.5..90');
      return null;
    }
    const reference = p.reference ?? 'current';
    if (reference !== 'current' && reference !== 'fixed') {
      errors.push("price_drop.reference must be 'current' or 'fixed'");
      return null;
    }
    if (reference === 'fixed' && !numIn(p.reference_price, 0, Number.MAX_SAFE_INTEGER)) {
      errors.push('price_drop.reference_price must be a non-negative number when fixed');
      return null;
    }
    if (p.reference_price !== undefined && typeof p.reference_price !== 'number') {
      errors.push('price_drop.reference_price must be a number');
      return null;
    }
    return {
      threshold_pct: p.threshold_pct as number,
      reference,
      ...(typeof p.reference_price === 'number' ? { reference_price: p.reference_price } : {}),
    };
  }
  if (kind === 'trailing_stop') {
    if (!numIn(p.width_pct, 1, 60)) {
      errors.push('trailing_stop.width_pct must be 1..60');
      return null;
    }
    return { width_pct: p.width_pct as number };
  }
  if (!numIn(p.distance_pct, 1, 50)) {
    errors.push('liq_distance.distance_pct must be 1..50');
    return null;
  }
  return { distance_pct: p.distance_pct as number };
}

function validateAction(action: unknown, errors: string[]): RuleAction | null {
  if (typeof action !== 'object' || action === null) {
    errors.push('action must be an object');
    return null;
  }
  const a = action as Record<string, unknown>;
  if (a.type === 'alert') return { type: 'alert' };
  if (a.type === 'swap') {
    if (!numIn(a.max_size_pct, 1, 100)) {
      errors.push('swap.max_size_pct must be 1..100');
      return null;
    }
    if (!isMint(a.to_mint)) {
      errors.push('swap.to_mint must be a valid mint address');
      return null;
    }
    return { type: 'swap', max_size_pct: a.max_size_pct as number, to_mint: a.to_mint as string };
  }
  errors.push("action.type must be 'alert' or 'swap'");
  return null;
}

export function validateRule(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['rule must be an object'] };
  }
  const r = input as Record<string, unknown>;
  if (!RULE_KINDS.includes(r.kind as RuleKind)) {
    errors.push(`kind must be one of ${RULE_KINDS.join(', ')}`);
  }
  if (!isAsset(r.asset)) {
    errors.push('asset must be a mint address or drift:<MARKET>');
  }
  const params =
    errors.length === 0 ? validateParams(r.kind as RuleKind, r.params, errors) : null;
  const action = validateAction(r.action, errors);
  if (errors.length > 0 || params === null || action === null) {
    return { ok: false, errors };
  }
  if (r.kind === 'liq_distance' && !(r.asset as string).startsWith('drift:')) {
    return { ok: false, errors: ['liq_distance rules require a drift:<MARKET> asset'] };
  }
  return {
    ok: true,
    rule: { kind: r.kind as RuleKind, asset: r.asset as string, params, action },
  };
}
