// Deterministic per-token risk scoring. The model never sets these numbers;
// it only explains them. Weights are sensible defaults for the MVP, to be
// calibrated against real price history later.

export interface RiskInput {
  mint: string;
  /** False when the mint account could not be read at all. */
  mintKnown: boolean;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** 0-100 share of supply in top 10 accounts, null when unknown. */
  top10Pct: number | null;
  /** True when concentration is inapplicable (native SOL: wSOL supply is 0). */
  concentrationNA?: boolean;
  liquidityUsd: number | null;
  /** Days since first index (age proxy), null when unknown. */
  indexedDays: number | null;
  /** Absolute 24h price move in percent (volatility proxy), null when unknown. */
  change24hAbs: number | null;
  /**
   * Third-party verdict (0 clean .. 100 riskiest). Optional so older callers
   * keep working; missing counts as unknown. Capped below our own signals
   * because it partly overlaps them (authorities, concentration, liquidity).
   */
  external?: { score01: number; dangers: string[] } | null;
}

export interface RiskFactor {
  name: string;
  detail: string;
  points: number;
}

export type RiskGrade = 'low' | 'medium' | 'high' | 'extreme';

export interface GuardSuggestion {
  kind: 'trailing_stop';
  /** Trailing width in percent below the high. */
  width_pct: number;
  /** Whether a pre-approved auto-swap is suggested (else alert-only). */
  auto: boolean;
  /** Pre-approved sell size; 0 when alert-only. */
  max_size_pct: number;
  reason: string;
}

export interface RiskScore {
  mint: string;
  /** 0 (safest) to 100 (riskiest). */
  score: number;
  grade: RiskGrade;
  factors: RiskFactor[];
  suggestion: GuardSuggestion;
}

/** ~1.5x recent move, clamped to a sane band; 15% when volatility is unknown. */
export function suggestWidth(change24hAbs: number | null): number {
  const base = change24hAbs == null ? 15 : 1.5 * change24hAbs;
  return Math.round(Math.min(35, Math.max(8, base)) * 10) / 10;
}

function gradeFor(score: number): RiskGrade {
  if (score < 25) return 'low';
  if (score < 50) return 'medium';
  if (score < 75) return 'high';
  return 'extreme';
}

export function scoreToken(input: RiskInput): RiskScore {
  const factors: RiskFactor[] = [];
  const add = (name: string, detail: string, points: number) =>
    factors.push({ name, detail, points });

  if (!input.mintKnown) {
    add('mint', 'mint account unreadable', 20);
  } else {
    add(
      'mint authority',
      input.mintAuthority ? `set (${input.mintAuthority.slice(0, 4)}…)` : 'revoked',
      input.mintAuthority ? 15 : 0,
    );
    add(
      'freeze authority',
      input.freezeAuthority ? `set (${input.freezeAuthority.slice(0, 4)}…)` : 'revoked',
      input.freezeAuthority ? 15 : 0,
    );
  }

  if (input.concentrationNA) {
    add('concentration', 'n/a for native asset', 0);
  } else if (input.top10Pct == null) {
    add('concentration', 'top holders unknown', 15);
  } else if (input.top10Pct < 20) {
    add('concentration', `top 10 hold ${input.top10Pct.toFixed(1)}%`, 0);
  } else if (input.top10Pct < 40) {
    add('concentration', `top 10 hold ${input.top10Pct.toFixed(1)}%`, 10);
  } else if (input.top10Pct < 60) {
    add('concentration', `top 10 hold ${input.top10Pct.toFixed(1)}%`, 20);
  } else {
    add('concentration', `top 10 hold ${input.top10Pct.toFixed(1)}%`, 30);
  }

  if (input.liquidityUsd == null) {
    add('liquidity', 'depth unknown', 25);
  } else if (input.liquidityUsd > 1_000_000) {
    add('liquidity', `~$${Math.round(input.liquidityUsd).toLocaleString('en-US')} depth`, 0);
  } else if (input.liquidityUsd > 100_000) {
    add('liquidity', `~$${Math.round(input.liquidityUsd).toLocaleString('en-US')} depth`, 10);
  } else if (input.liquidityUsd > 10_000) {
    add('liquidity', `~$${Math.round(input.liquidityUsd).toLocaleString('en-US')} depth`, 20);
  } else {
    add('liquidity', `~$${Math.round(input.liquidityUsd).toLocaleString('en-US')} depth`, 30);
  }

  if (input.indexedDays == null) {
    add('age', 'first-seen unknown', 10);
  } else if (input.indexedDays > 365) {
    add('age', `tracked ${Math.round(input.indexedDays)}d`, 0);
  } else if (input.indexedDays > 90) {
    add('age', `tracked ${Math.round(input.indexedDays)}d`, 5);
  } else if (input.indexedDays > 30) {
    add('age', `tracked ${Math.round(input.indexedDays)}d`, 10);
  } else {
    add('age', `tracked ${Math.round(input.indexedDays)}d`, 15);
  }

  if (input.change24hAbs == null) {
    add('volatility', '24h move unknown', 10);
  } else if (input.change24hAbs < 5) {
    add('volatility', `24h move ${input.change24hAbs.toFixed(1)}%`, 0);
  } else if (input.change24hAbs < 15) {
    add('volatility', `24h move ${input.change24hAbs.toFixed(1)}%`, 5);
  } else if (input.change24hAbs < 30) {
    add('volatility', `24h move ${input.change24hAbs.toFixed(1)}%`, 10);
  } else {
    add('volatility', `24h move ${input.change24hAbs.toFixed(1)}%`, 15);
  }

  const ext = input.external ?? null;
  if (ext === null) {
    add('external audit', 'third-party verdict unavailable', 10);
  } else {
    const flags = ext.dangers.slice(0, 2).join('; ');
    const detail = `score ${ext.score01}/100${flags ? `: ${flags}` : ''}`;
    if (ext.score01 <= 15) add('external audit', detail, 0);
    else if (ext.score01 <= 40) add('external audit', detail, 8);
    else if (ext.score01 <= 70) add('external audit', detail, 15);
    else add('external audit', detail, 20);
  }

  const score = Math.min(100, factors.reduce((s, f) => s + f.points, 0));
  const grade = gradeFor(score);
  const width_pct = suggestWidth(input.change24hAbs);

  const suggestion: GuardSuggestion =
    grade === 'extreme'
      ? {
          kind: 'trailing_stop',
          width_pct,
          auto: false,
          max_size_pct: 0,
          reason: 'extreme risk: alert-only, never auto-sell',
        }
      : {
          kind: 'trailing_stop',
          width_pct,
          auto: true,
          max_size_pct: grade === 'low' ? 50 : grade === 'medium' ? 30 : 15,
          reason: `${grade} risk: pre-approved auto-swap to USDC on trigger`,
        };

  return { mint: input.mint, score, grade, factors, suggestion };
}
