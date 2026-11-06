import { Pool } from 'pg';
import { optional } from '@sentinel/config';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: optional(
        'DATABASE_URL',
        'postgres://sentinel:sentinel@localhost:5432/sentinel',
      ),
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
