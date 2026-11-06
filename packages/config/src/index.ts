import fs from 'node:fs';
import path from 'node:path';

export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** Load .env from the repo root into process.env (never overrides existing). */
export function loadEnv(startDir: string = process.cwd()): void {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 6; i++) {
    const file = path.join(dir, '.env');
    if (fs.existsSync(file)) {
      const parsed = parseEnvFile(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] === undefined) process.env[k] = v;
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

export function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`Missing required env var: ${name}`);
  return v;
}
