import { Bot, InlineKeyboard } from 'grammy';
import { optional } from '@sentinel/config';

export interface ProposalCard {
  id: string;
  kind: string;
  /** AI-written explanation; buttons are attached to it. */
  text: string;
}

export interface NotifySender {
  sendText(tag: string, text: string): Promise<void>;
  sendProposal(tag: string, card: ProposalCard): Promise<void>;
}

const consoleSender: NotifySender = {
  sendText: async (tag, text) => {
    console.log(`[notify ${tag}] ${text}`);
  },
  sendProposal: async (tag, card) => {
    console.log(`[notify ${tag}] ${card.text}\n  [approve:${card.id}] [reject:${card.id}]`);
  },
};

function cardKeyboard(id: string): InlineKeyboard {
  return new InlineKeyboard().text('Approve', `approve:${id}`).text('Reject', `reject:${id}`);
}

/**
 * Telegram sender, falling back to console when no token is configured or the
 * tag is not a numeric Telegram id (test/stub tags must never crash delivery).
 */
export function defaultSender(existing?: Bot): NotifySender {
  const token = optional('TELEGRAM_BOT_TOKEN', '');
  if (!token) return consoleSender;
  const bot = existing ?? new Bot(token);
  const chatId = (tag: string): number | null => (/^\d+$/.test(tag) ? Number(tag) : null);
  return {
    sendText: async (tag, text) => {
      const id = chatId(tag);
      if (id === null) return consoleSender.sendText(tag, text);
      await bot.api.sendMessage(id, text);
    },
    sendProposal: async (tag, card) => {
      const id = chatId(tag);
      if (id === null) return consoleSender.sendProposal(tag, card);
      await bot.api.sendMessage(id, card.text, { reply_markup: cardKeyboard(card.id) });
    },
  };
}
