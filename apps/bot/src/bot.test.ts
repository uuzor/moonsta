import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { loadEnv } from '@sentinel/config';
import {
  closePool,
  createProposal,
  ensureUserByTelegram,
  ensureWallet,
  getPolicy,
  getProposal,
} from '@sentinel/db';
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

loadEnv(process.cwd());

const live = process.env.DATABASE_URL ? it : it.skip;

describe('bot sender', () => {
  it('falls back to console for test tags without throwing', async () => {
    const sender = defaultSender();
    await sender.sendText('not-a-telegram-id', 'hello');
    await sender.sendProposal('not-a-telegram-id', { id: 'p', kind: 'swap', text: 'card' });
  });
});

describe('bot handlers', () => {
  live('pause/resume/audit round-trip', async () => {
    const tag = `bot-${Date.now()}`;
    assert.match(await handlePause(tag), /No wallets tracked/);
    const user = await ensureUserByTelegram(tag);
    const wallet = await ensureWallet(user.id, 'solana', Keypair.generate().publicKey.toBase58());
    assert.match(await handlePause(tag), /Paused 1 wallet/);
    assert.equal((await getPolicy(wallet.id)).paused, true);
    assert.match(await handleResume(tag), /Resumed 1 wallet/);
    assert.equal((await getPolicy(wallet.id)).paused, false);
    const audit = await handleAudit(tag);
    assert.match(audit, /paused/);
    assert.match(audit, /resumed/);
    await closePool();
  });

  live('callbacks verify ownership and reject without chain access', async () => {
    const owner = await ensureUserByTelegram(`bot-own-${Date.now()}`);
    const stranger = await ensureUserByTelegram(`bot-str-${Date.now()}`);
    const wallet = await ensureWallet(owner.id, 'solana', Keypair.generate().publicKey.toBase58());
    const proposal = await createProposal(wallet.id, 'swap', { inputMint: 'a' }, new Date(Date.now() + 600_000));

    assert.deepEqual(await handleCallback(owner.telegram_id!, 'nonsense', null), {
      text: 'Unknown button.',
      alert: true,
    });
    const foreign = await handleCallback(stranger.telegram_id!, `approve:${proposal.id}`, null);
    assert.equal(foreign.alert, true);
    assert.match(foreign.text, /not yours/);

    const rejected = await handleCallback(owner.telegram_id!, `reject:${proposal.id}`, null);
    assert.equal(rejected.alert, false);
    assert.match(rejected.text, /Rejected swap proposal/);
    assert.equal((await getProposal(proposal.id))?.status, 'rejected');

    const again = await handleCallback(owner.telegram_id!, `reject:${proposal.id}`, null);
    assert.equal(again.alert, true);
    assert.match(again.text, /already rejected/);
    await closePool();
  });

  live('onboarding: start, auto-connect routing, connect', async () => {
    const tag = `bot-new-${Date.now()}`;
    assert.match(await handleStart(tag), /account is ready/);
    assert.match(await handleStart(tag), /Send me your Solana wallet address/);

    const addr = Keypair.generate().publicKey.toBase58();
    assert.equal(await shouldAutoConnect(tag, `  ${addr}  `), addr);
    assert.equal(await shouldAutoConnect(tag, 'hello there'), null);

    assert.match(await handleConnect(tag, 'not-an-address!!'), /doesn't look like a valid Solana/);
    const connected = await handleConnect(tag, addr);
    assert.match(connected, /Connected .* I now watch/);

    assert.match(await handleConnect(tag, addr), /already connected/);
    assert.match(await handleStart(tag), /watching 1 wallet/);
    assert.equal(await shouldAutoConnect(tag, addr), null);
    await closePool();
  });
});
