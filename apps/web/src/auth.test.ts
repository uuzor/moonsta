import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { validateInitData } from './auth';

const TOKEN = 'test-bot-token-123';

/** Independent forger written straight from the Telegram spec (not from src). */
function forge(fields: Record<string, string>, token: string = TOKEN): string {
  const pairs = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1));
  const checkString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(checkString).digest('hex');
  return `${pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}&hash=${hash}`;
}

function fields(userId = 42): Record<string, string> {
  return {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAE9q7wZAAAAAA',
    user: JSON.stringify({ id: userId, first_name: 'Ada', username: 'ada' }),
  };
}

describe('initData validation', () => {
  it('accepts correctly signed data and parses the user', () => {
    const res = validateInitData(forge(fields(99)), TOKEN);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.user.id, 99);
      assert.equal(res.user.username, 'ada');
    }
  });

  it('rejects tampered values, wrong tokens, stale and hashless data', () => {
    const good = forge(fields());
    const tampered = good.replace('Ada', 'Adb');
    assert.equal(validateInitData(tampered, TOKEN).ok, false);
    assert.equal(validateInitData(good, 'wrong-token').ok, false);
    assert.equal(validateInitData(good.replace(/hash=[0-9a-f]+/, 'hash=0'.padEnd(69, '0')), TOKEN).ok, false);

    const old = forge({ ...fields(), auth_date: String(Math.floor(Date.now() / 1000) - 100_000) });
    assert.deepEqual(validateInitData(old, TOKEN), { ok: false, error: 'stale auth_date' });
  });
});
