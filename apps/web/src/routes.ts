import { Context, Hono } from 'hono';
import { optional } from '@sentinel/config';
import {
  cancelScheduledAction,
  ensureUserByTelegram,
  getRuleById,
  listOpenPositions,
  listRecentProposals,
  listScheduledActions,
  listWalletRules,
  listWallets,
  portfolioHistory,
  recentAuditEvents,
} from '@sentinel/db';
import { getAdapter as resolveAdapter } from '@sentinel/chain';
import { createConnection, loadAgentKeypair } from '@sentinel/chain-solana';
import { setRuleStatus } from '@sentinel/rules';
import { buildReport, type HoldingInput, type RuleSummary } from '@sentinel/portfolio';
import { handleCallback, handlePause, handleResume } from '@sentinel/bot';
import { validateInitData } from './auth';

export interface ApiUser {
  telegramId: string;
  userId: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    apiUser: ApiUser;
  }
}

/** Every /api call carries `Authorization: tma <initData>`; the user id comes only from verified data. */
export function authMiddleware() {
  return async (c: Context, next: () => Promise<void>) => {
    const header = c.req.header('authorization') ?? '';
    const initData = header.startsWith('tma ') ? header.slice(4) : '';
    const res = validateInitData(initData, optional('TELEGRAM_BOT_TOKEN', ''));
    if (!res.ok) return c.json({ error: `unauthorized: ${res.error}` }, 401);
    const telegramId = String(res.user.id);
    const user = await ensureUserByTelegram(telegramId);
    c.set('apiUser', { telegramId, userId: user.id });
    await next();
  };
}

function userOf(c: Context): ApiUser {
  return c.get('apiUser');
}

async function ownWalletIds(userId: string): Promise<string[]> {
  return (await listWallets(userId)).map((w) => w.id);
}

function approveDepsOrNull() {
  try {
    return { connection: createConnection(), agent: loadAgentKeypair() };
  } catch {
    return null;
  }
}

export function createApi() {
  const api = new Hono();
  api.use('*', authMiddleware());

  api.get('/me', async (c) => {
    const { telegramId, userId } = userOf(c);
    const wallets = await listWallets(userId);
    return c.json({
      telegramId,
      wallets: wallets.map((w) => ({ chain: w.chain, address: w.address, label: w.label })),
    });
  });

  api.get('/portfolio', async (c) => {
    const { userId } = userOf(c);
    const wallets = await listWallets(userId);
    const out = [];
    let totalUsd = 0;
    for (const w of wallets) {
      try {
        const adapter = resolveAdapter(w.chain);
        const [native, spl] = await Promise.all([
          adapter.getNativeBalance(w.address),
          adapter.getTokenBalances(w.address),
        ]);
        const nativeMint = adapter.nativeMint ?? '';
        const prices = await adapter.getUsdPrices([nativeMint, ...spl.map((s) => s.mint)]);
        const holdings: HoldingInput[] = [
          { mint: nativeMint, amount: native.amount, usdPrice: prices.get(nativeMint)?.usdPrice, change24h: prices.get(nativeMint)?.change24h },
          ...spl.map((s) => ({
            mint: s.mint,
            amount: s.uiAmount,
            usdPrice: prices.get(s.mint)?.usdPrice,
            change24h: prices.get(s.mint)?.change24h,
          })),
        ];
        const positions = await adapter.getPositions(w.address).catch(() => null);
        const rules: RuleSummary[] = (await listWalletRules(w.id))
          .filter((r) => r.status === 'active')
          .map((r) => ({ id: r.id, kind: r.kind, asset: r.asset, status: r.status }));
        const report = buildReport({ wallet: w.address, holdings, positions, rules });
        totalUsd += report.totalUsd;
        out.push({ chain: w.chain, address: w.address, label: w.label, report });
      } catch (e) {
        out.push({ chain: w.chain, address: w.address, label: w.label, error: (e as Error).message });
      }
    }
    return c.json({ totalUsd, wallets: out });
  });

  api.get('/history', async (c) => {
    const { userId } = userOf(c);
    const days = Math.min(Math.max(Number(c.req.query('days') ?? 30) || 30, 1), 90);
    return c.json({ days, points: await portfolioHistory(userId, days) });
  });

  api.get('/positions', async (c) => {
    const { userId } = userOf(c);
    const wallets = await listWallets(userId);
    const out = [];
    for (const w of wallets) {
      const tracked = await listOpenPositions(w.id);
      let onchain: unknown = [];
      try {
        onchain = await resolveAdapter(w.chain).getPositions(w.address);
      } catch (e) {
        onchain = { error: (e as Error).message };
      }
      out.push({ chain: w.chain, address: w.address, tracked, onchain });
    }
    return c.json({ wallets: out });
  });

  api.get('/rules', async (c) => {
    const { userId } = userOf(c);
    const wallets = await listWallets(userId);
    const out = [];
    for (const w of wallets) {
      const rules = await listWalletRules(w.id);
      out.push({
        chain: w.chain,
        address: w.address,
        rules: rules.map((r) => ({
          id: r.id,
          kind: r.kind,
          asset: r.asset,
          params: r.params,
          action: r.action,
          status: r.status,
          updatedAt: r.updated_at,
        })),
      });
    }
    return c.json({ wallets: out });
  });

  api.post('/rules/:id/pause', async (c) => {
    const { userId } = userOf(c);
    const rule = await getRuleById(c.req.param('id'));
    if (!rule || !(await ownWalletIds(userId)).includes(rule.wallet_id)) {
      return c.json({ error: 'rule not found' }, 404);
    }
    const row = await setRuleStatus(rule.id, 'paused');
    return c.json({ id: row?.id, status: row?.status });
  });

  api.post('/rules/:id/resume', async (c) => {
    const { userId } = userOf(c);
    const rule = await getRuleById(c.req.param('id'));
    if (!rule || !(await ownWalletIds(userId)).includes(rule.wallet_id)) {
      return c.json({ error: 'rule not found' }, 404);
    }
    const row = await setRuleStatus(rule.id, 'active');
    return c.json({ id: row?.id, status: row?.status });
  });

  api.get('/proposals', async (c) => {
    const { userId } = userOf(c);
    const rows = await listRecentProposals(await ownWalletIds(userId), 20);
    return c.json({
      proposals: rows.map((p) => ({
        id: p.id,
        kind: p.kind,
        payload: p.payload,
        status: p.status,
        expiresAt: p.expires_at,
        createdAt: p.created_at,
      })),
    });
  });

  api.post('/proposals/:id/approve', async (c) => {
    const { telegramId } = userOf(c);
    const res = await handleCallback(telegramId, `approve:${c.req.param('id')}`, approveDepsOrNull());
    return c.json(res, res.alert ? 400 : 200);
  });

  api.post('/proposals/:id/reject', async (c) => {
    const { telegramId } = userOf(c);
    const res = await handleCallback(telegramId, `reject:${c.req.param('id')}`, approveDepsOrNull());
    return c.json(res, res.alert ? 400 : 200);
  });

  api.get('/activity', async (c) => {
    const { userId } = userOf(c);
    const rows = await recentAuditEvents(await ownWalletIds(userId), 30);
    return c.json({
      events: rows.map((r) => ({
        actor: r.actor,
        action: r.action,
        detail: r.detail,
        at: r.created_at,
      })),
    });
  });

  api.get('/scheduled', async (c) => {
    const { userId } = userOf(c);
    const rows = await listScheduledActions(userId);
    return c.json({
      actions: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        message: r.message,
        runAt: r.run_at,
        status: r.status,
      })),
    });
  });

  api.post('/scheduled/:id/cancel', async (c) => {
    const { userId } = userOf(c);
    const row = await cancelScheduledAction(c.req.param('id'), userId);
    if (!row) return c.json({ error: 'action not found, not yours, or no longer pending' }, 404);
    return c.json({ id: row.id, status: row.status });
  });

  api.post('/pause-all', async (c) => c.json({ message: await handlePause(userOf(c).telegramId) }));
  api.post('/resume-all', async (c) => c.json({ message: await handleResume(userOf(c).telegramId) }));

  return api;
}
