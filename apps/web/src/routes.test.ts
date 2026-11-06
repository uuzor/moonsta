import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { loadEnv } from '@sentinel/config';
import {
  closePool,
  createProposal,
  ensureUserByTelegram,
  ensureWallet,
  getProposal,
  getRuleById,
  scheduleAction,
} from '@sentinel/db';
import { createRule } from '@sentinel/rules';
import { SOL_MINT } from '@sentinel/chain-solana';
import { createApp } from './index';

loadEnv(process.cwd());

const TOKEN = 'route-test-token';
process.env.TELEGRAM_BOT_TOKEN = TOKEN;

/** Independent forger written straight from the Telegram spec (not from src). */
function forge(userId: number): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId, first_name: 'T' }),
  };
  const pairs = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1));
  const checkString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = createHmac('sha256', secret).update(checkString).digest('hex');
  return `${pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}&hash=${hash}`;
}

const auth = (userId: number) => ({ authorization: `tma ${forge(userId)}` });

const live = process.env.DATABASE_URL ? it : it.skip;

describe('web api', () => {
  it('rejects missing and forged credentials', async () => {
    const app = createApp();
    assert.equal((await app.request('/api/me')).status, 401);
    assert.equal((await app.request('/api/me', { headers: { authorization: 'tma garbage' } })).status, 401);
    const other = forge(7).replace(/hash=[0-9a-f]+/, `hash=${'f'.repeat(64)}`);
    assert.equal((await app.request('/api/me', { headers: { authorization: `tma ${other}` } })).status, 401);
  });

  live('serves user-scoped reads', async () => {
    const tag = 910000001 + Math.floor(Math.random() * 1000);
    const user = await ensureUserByTelegram(String(tag));
    await ensureWallet(user.id, 'solana', Keypair.generate().publicKey.toBase58());
    const app = createApp();
    const me = await app.request('/api/me', { headers: auth(tag) });
    assert.equal(me.status, 200);
    const body = (await me.json()) as { telegramId: string; wallets: unknown[] };
    assert.equal(body.telegramId, String(tag));
    assert.equal(body.wallets.length, 1);
    assert.equal((await app.request('/api/history', { headers: auth(tag) })).status, 200);
    assert.equal((await app.request('/api/positions', { headers: auth(tag) })).status, 200);
    assert.equal((await app.request('/api/activity', { headers: auth(tag) })).status, 200);
    await closePool();
  });

  live('rule pause/resume round-trips with ownership', async () => {
    const owner = 920000001 + Math.floor(Math.random() * 1000);
    const stranger = owner + 5000;
    const user = await ensureUserByTelegram(String(owner));
    await ensureUserByTelegram(String(stranger));
    const wallet = await ensureWallet(user.id, 'solana', Keypair.generate().publicKey.toBase58());
    const rule = await createRule({
      walletId: wallet.id,
      kind: 'trailing_stop',
      asset: SOL_MINT,
      params: { width_pct: 10 },
      action: { type: 'alert' },
    });
    const app = createApp();
    const rules = (await (await app.request('/api/rules', { headers: auth(owner) })).json()) as {
      wallets: Array<{ rules: Array<{ id: string }> }>;
    };
    assert.ok(rules.wallets[0].rules.some((r) => r.id === rule.id));

    assert.equal((await app.request(`/api/rules/${rule.id}/pause`, { headers: auth(stranger), method: 'POST' })).status, 404);
    const paused = await app.request(`/api/rules/${rule.id}/pause`, { headers: auth(owner), method: 'POST' });
    assert.equal(paused.status, 200);
    assert.equal((await getRuleById(rule.id))?.status, 'paused');
    const resumed = await app.request(`/api/rules/${rule.id}/resume`, { headers: auth(owner), method: 'POST' });
    assert.equal(resumed.status, 200);
    assert.equal((await getRuleById(rule.id))?.status, 'active');
    await closePool();
  });

  live('proposal reject resolves through the policy path', async () => {
    const tag = 930000001 + Math.floor(Math.random() * 1000);
    const user = await ensureUserByTelegram(String(tag));
    const wallet = await ensureWallet(user.id, 'solana', Keypair.generate().publicKey.toBase58());
    const proposal = await createProposal(wallet.id, 'swap', { x: 1 }, new Date(Date.now() + 600_000));
    const app = createApp();
    const list = (await (await app.request('/api/proposals', { headers: auth(tag) })).json()) as {
      proposals: Array<{ id: string }>;
    };
    assert.ok(list.proposals.some((p) => p.id === proposal.id));
    const res = await app.request(`/api/proposals/${proposal.id}/reject`, { headers: auth(tag), method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal((await getProposal(proposal.id))?.status, 'rejected');
    await closePool();
  });

  live('scheduled list + cancel with ownership', async () => {
    const tag = 940000001 + Math.floor(Math.random() * 1000);
    const user = await ensureUserByTelegram(String(tag));
    const other = 940000001 + Math.floor(Math.random() * 1000) + 5000;
    await ensureUserByTelegram(String(other));
    const action = await scheduleAction({
      userId: user.id,
      kind: 'reminder',
      message: 'ping me',
      runAt: new Date(Date.now() + 3600_000),
    });
    const app = createApp();
    const list = (await (await app.request('/api/scheduled', { headers: auth(tag) })).json()) as {
      actions: Array<{ id: string; kind: string; status: string }>;
    };
    assert.ok(list.actions.some((a) => a.id === action.id && a.status === 'pending'));
    assert.equal(
      (await app.request(`/api/scheduled/${action.id}/cancel`, { headers: auth(other), method: 'POST' })).status,
      404,
    );
    const res = await app.request(`/api/scheduled/${action.id}/cancel`, { headers: auth(tag), method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { status: string }).status, 'cancelled');
    await closePool();
  });
});
