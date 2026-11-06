import { Bot } from 'grammy';
import { optional, required } from '@sentinel/config';
import { closePool } from '@sentinel/db';
import { serveTurns } from '@sentinel/agent';
import { createConnection, loadAgentKeypair } from '@sentinel/chain-solana';
import { ApproveDeps } from '@sentinel/policy';
import { createCounter, createLock, createTurnQueue } from '@sentinel/queue';
import {
  handleAudit,
  handleCallback,
  handleConnect,
  handlePause,
  handleResume,
  handleStart,
  shouldAutoConnect,
} from './handlers';
import { defaultSender } from './sender';

function approveDepsOrNull(): ApproveDeps | null {
  try {
    return { connection: createConnection(), agent: loadAgentKeypair() };
  } catch {
    console.error('[bot] agent key unavailable — approvals will be declined until configured');
    return null;
  }
}

/** Long-polling bot + turn consumer. Resolves to a stopper. */
export async function startBotApp(token: string = required('TELEGRAM_BOT_TOKEN')): Promise<() => Promise<void>> {
  const bot = new Bot(token);
  const me = await bot.api.getMe();
  console.log(`[bot] @${me.username} up (long polling)`);
  const miniappUrl = optional('MINIAPP_URL', '');
  if (miniappUrl) {
    await bot.api
      .setChatMenuButton({ menu_button: { type: 'web_app', text: 'Dashboard', web_app: { url: miniappUrl } } })
      .then(() => console.log('[bot] menu button -> Mini App dashboard'))
      .catch((e: unknown) => console.error(`[bot] menu button failed: ${(e as Error).message}`));
  }
  const sender = defaultSender(bot);
  const deps = approveDepsOrNull();

  const queue = createTurnQueue();
  const lock = createLock();
  const counter = createCounter();
  const stopTurns = await serveTurns({ queue, lock, counter }, (tag) => (text) => sender.sendText(tag, text));

  bot.command('start', async (ctx) => {
    const id = senderId(ctx);
    await ctx.reply(id ? await safe(handleStart(id)) : 'Could not identify sender.');
  });
  const safe = (p: Promise<string>) => p.catch((e: unknown) => `Error: ${(e as Error).message}`);
  const senderId = (ctx: { from?: { id: number } }): string | null =>
    ctx.from ? String(ctx.from.id) : null;
  bot.command('pause', async (ctx) => {
    const id = senderId(ctx);
    await ctx.reply(id ? await safe(handlePause(id)) : 'Could not identify sender.');
  });
  bot.command('resume', async (ctx) => {
    const id = senderId(ctx);
    await ctx.reply(id ? await safe(handleResume(id)) : 'Could not identify sender.');
  });
  bot.command('audit', async (ctx) => {
    const id = senderId(ctx);
    await ctx.reply(id ? await safe(handleAudit(id)) : 'Could not identify sender.');
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return; // commands are handled above, never queued as turns
    const tag = String(ctx.from.id);
    const auto = await shouldAutoConnect(tag, text).catch(() => null);
    if (auto) {
      await ctx.reply(await safe(handleConnect(tag, auto)));
      return;
    }
    await queue.enqueue({ telegramId: tag, text, enqueuedAt: new Date().toISOString() });
  });

  bot.callbackQuery(/^(approve|reject):/, async (ctx) => {
    const id = senderId(ctx);
    if (!id) {
      await ctx.answerCallbackQuery({ text: 'Could not identify sender.', show_alert: true });
      return;
    }
    const res = await handleCallback(id, ctx.callbackQuery.data, deps);
    if (res.alert) await ctx.answerCallbackQuery({ text: res.text, show_alert: true });
    else await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await ctx.reply(res.text);
  });

  bot.start();
  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    await bot.stop();
    await stopTurns();
    await Promise.all([queue.close(), lock.close(), counter.close(), closePool()]);
  };
}
