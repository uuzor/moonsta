import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Telegram Mini App initData validation, per
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * secret = HMAC_SHA256(key="WebAppData", msg=bot_token)
 * check  = hex(HMAC_SHA256(secret, data_check_string)) == hash
 *
 * data_check_string = all received fields except `hash`, sorted alphabetically,
 * formatted `key=<value>` and joined with \n. Values are decoded with
 * decodeURIComponent per pair (NOT form-decoding: a literal + must survive).
 */

export interface MiniAppUser {
  id: number;
  username?: string;
  firstName?: string;
}

export type InitDataResult = { ok: true; user: MiniAppUser } | { ok: false; error: string };

function parsePairs(initData: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const part of initData.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const rawKey = eq < 0 ? part : part.slice(0, eq);
    const rawVal = eq < 0 ? '' : part.slice(eq + 1);
    try {
      out.push([decodeURIComponent(rawKey), decodeURIComponent(rawVal)]);
    } catch {
      return [];
    }
  }
  return out;
}

export function validateInitData(
  initData: string,
  botToken: string,
  maxAgeSec = 86400,
  nowSec: number = Math.floor(Date.now() / 1000),
): InitDataResult {
  if (!initData || !botToken) return { ok: false, error: 'missing initData or token' };
  const pairs = parsePairs(initData);
  if (pairs.length === 0) return { ok: false, error: 'unparseable initData' };
  const hash = pairs.find(([k]) => k === 'hash')?.[1];
  if (!hash || hash.length !== 64) return { ok: false, error: 'missing hash' };

  const checkString = pairs
    .filter(([k]) => k !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = createHmac('sha256', secret).update(checkString).digest('hex');
  let equal = false;
  try {
    equal = timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    equal = false;
  }
  if (!equal) return { ok: false, error: 'bad signature' };

  const authDate = Number(pairs.find(([k]) => k === 'auth_date')?.[1]);
  if (!Number.isFinite(authDate) || nowSec - authDate > maxAgeSec) {
    return { ok: false, error: 'stale auth_date' };
  }
  const rawUser = pairs.find(([k]) => k === 'user')?.[1];
  if (!rawUser) return { ok: false, error: 'missing user' };
  try {
    const parsed = JSON.parse(rawUser) as { id?: unknown; username?: unknown; first_name?: unknown };
    if (typeof parsed.id !== 'number') return { ok: false, error: 'bad user id' };
    return {
      ok: true,
      user: {
        id: parsed.id,
        username: typeof parsed.username === 'string' ? parsed.username : undefined,
        firstName: typeof parsed.first_name === 'string' ? parsed.first_name : undefined,
      },
    };
  } catch {
    return { ok: false, error: 'bad user payload' };
  }
}
