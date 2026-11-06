import { RuleRow, getPool } from '@sentinel/db';
import { ValidRule, validateRule } from './schema';

export class RuleValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`Invalid rule: ${errors.join('; ')}`);
    this.errors = errors;
  }
}

export interface CreateRuleInput {
  walletId: string;
  kind: unknown;
  asset: unknown;
  params: unknown;
  action: unknown;
}

export async function createRule(input: CreateRuleInput): Promise<RuleRow> {
  const result = validateRule({
    kind: input.kind,
    asset: input.asset,
    params: input.params,
    action: input.action,
  });
  if (!result.ok) throw new RuleValidationError(result.errors);
  const rule: ValidRule = result.rule;
  const { rows } = await getPool().query<RuleRow>(
    `INSERT INTO rules (wallet_id, kind, asset, params, action)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, wallet_id, kind, asset, params, action, state, status, created_at, updated_at`,
    [input.walletId, rule.kind, rule.asset, JSON.stringify(rule.params), JSON.stringify(rule.action)],
  );
  return rows[0];
}

export type RuleStatus = 'active' | 'paused' | 'expired';

export async function setRuleStatus(id: string, status: RuleStatus): Promise<RuleRow | null> {
  const { rows } = await getPool().query<RuleRow>(
    `UPDATE rules SET status = $2, updated_at = now() WHERE id = $1
     RETURNING id, wallet_id, kind, asset, params, action, state, status, created_at, updated_at`,
    [id, status],
  );
  return rows[0] ?? null;
}

export async function deleteRule(id: string): Promise<boolean> {
  const { rowCount } = await getPool().query(`DELETE FROM rules WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}
