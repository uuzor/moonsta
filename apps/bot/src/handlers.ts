import {
  ensureUserByTelegram,
  ensureWallet,
  findWallet,
  getProposal,
  insertAuditEvent,
  listWallets,
  recentAuditEvents,
  setPaused,
} from '@sentinel/db';
import { solanaAdapter } from '@sentinel/chain-solana';
import { ApproveDeps, approveProposal, rejectProposal } from '@sentinel/policy';

/** grammy-free handler logic so every path is unit-testable without Telegram. */

export async function handleStart(telegramId: string): Promise<string> {
  const user = await ensureUserByTelegram(telegramId);
  const wallets = await listWallets(user.id);
  if (wallets.length === 0) {
    return [
      'Moonsta — your money copilot that never sleeps. Your account is ready.',
      '',
      'Send me your Solana wallet address to connect it (find it in Phantom or Solflare),',
      'or say "track wallet <ADDRESS>".',
    ].join('\n');
  }
  return [
    `Welcome back — I'm watching ${wallets.length} wallet(s).`,
    'Ask for a report, say "protect <TOKEN>" to set a guard, or tap Approve on proposals.',
    '',
    'Commands: /pause /resume /audit',
  ].join('\n');
}

const BARE_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * First-run fast path: a bare address from a user with no wallets means
 * "connect this". Anything else (or any later address) goes to the agent,
 * which disambiguates via conversation and tools.
 */
export async function shouldAutoConnect(telegramId: string, text: string): Promise<string | null> {
  const candidate = text.trim();
  if (!BARE_ADDRESS_RE.test(candidate)) return null;
  const user = await ensureUserByTelegram(telegramId);
  const wallets = await listWallets(user.id);
  return wallets.length === 0 ? candidate : null;
}

export async function handleConnect(telegramId: string, address: string): Promise<string> {
  const user = await ensureUserByTelegram(telegramId);
  try {
    solanaAdapter.assertAddress(address);
  } catch {
    return 'That doesn\'t look like a valid Solana address. Send a wallet address (base58, from Phantom/Solflare), or say "track wallet <ADDRESS>".';
  }
  const existing = await findWallet(user.id, 'solana', address);
  if (existing) {
    return 'That wallet is already connected. Ask me for a full report, or say "protect <TOKEN>" to set up a guard.';
  }
  const wallet = await ensureWallet(user.id, 'solana', address);
  await insertAuditEvent({ walletId: wallet.id, actor: 'user', action: 'wallet_connected', detail: { via: 'telegram' } });
  return [
    `Connected ${address.slice(0, 4)}…${address.slice(-4)}. I now watch its balances and tokens.`,
    'Try: "give me a full report" or "score <TOKEN> and suggest a guard".',
  ].join('\n');
}

export async function handlePause(telegramId: string): Promise<string> {
  const user = await ensureUserByTelegram(telegramId);
  const wallets = await listWallets(user.id);
  for (const wallet of wallets) {
    await setPaused(wallet.id, true);
    await insertAuditEvent({ walletId: wallet.id, actor: 'user', action: 'paused', detail: { via: 'telegram' } });
  }
  if (wallets.length === 0) return 'No wallets tracked yet. Tell me to track a wallet first.';
  return `Paused ${wallets.length} wallet(s). Guard execution is frozen; /resume to unpause.`;
}

export async function handleResume(telegramId: string): Promise<string> {
  const user = await ensureUserByTelegram(telegramId);
  const wallets = await listWallets(user.id);
  for (const wallet of wallets) {
    await setPaused(wallet.id, false);
    await insertAuditEvent({ walletId: wallet.id, actor: 'user', action: 'resumed', detail: { via: 'telegram' } });
  }
  if (wallets.length === 0) return 'No wallets tracked yet. Tell me to track a wallet first.';
  return `Resumed ${wallets.length} wallet(s). Guards are live again.`;
}

export async function handleAudit(telegramId: string, limit = 10): Promise<string> {
  const user = await ensureUserByTelegram(telegramId);
  const wallets = await listWallets(user.id);
  if (wallets.length === 0) return 'No wallets tracked yet. Tell me to track a wallet first.';
  const rows = await recentAuditEvents(
    wallets.map((w) => w.id),
    limit,
  );
  if (rows.length === 0) return 'No activity recorded yet.';
  return rows
    .map((r) => `${new Date(r.created_at).toISOString().slice(5, 16).replace('T', ' ')} ${r.actor}/${r.action}`)
    .join('\n');
}

export interface CallbackResult {
  text: string;
  alert: boolean;
}

const CALLBACK_RE = /^(approve|reject):([0-9a-fA-F-]{36})$/;

/**
 * Approve/Reject tap. Ownership is verified (a user can only resolve their
 * own proposals); approval executes exactly once through the policy path.
 */
export async function handleCallback(
  telegramId: string,
  data: string,
  deps: ApproveDeps | null,
): Promise<CallbackResult> {
  const match = CALLBACK_RE.exec(data);
  if (!match) return { text: 'Unknown button.', alert: true };
  const [, verb, proposalId] = match;
  const user = await ensureUserByTelegram(telegramId);
  const proposal = await getProposal(proposalId);
  if (!proposal) return { text: 'Proposal not found — it may have expired.', alert: true };
  const mine = (await listWallets(user.id)).some((w) => w.id === proposal.wallet_id);
  if (!mine) return { text: 'That proposal is not yours.', alert: true };
  try {
    if (verb === 'reject') {
      await rejectProposal(proposalId, 'user');
      return { text: `Rejected ${proposal.kind} proposal ${proposalId.slice(0, 8)}. Nothing was executed.`, alert: false };
    }
    if (!deps) return { text: 'Execution is not configured on this bot (no agent key).', alert: true };
    const { signature } = await approveProposal(deps, proposalId, 'user');
    return { text: `Approved and executed. Signature: ${signature}`, alert: false };
  } catch (err) {
    return { text: `Could not ${verb}: ${(err as Error).message}`, alert: true };
  }
}
