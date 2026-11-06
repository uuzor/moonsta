import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { encodeSecretKey, loadAgentKeypair } from './keys';

describe('agent keys', () => {
  it('round-trips a generated keypair through env', () => {
    const kp = Keypair.generate();
    process.env.SENTINEL_TEST_AGENT_KEY = encodeSecretKey(kp);
    const prev = process.env.AGENT_SECRET_KEY;
    process.env.AGENT_SECRET_KEY = process.env.SENTINEL_TEST_AGENT_KEY;
    try {
      const loaded = loadAgentKeypair();
      assert.equal(loaded.publicKey.toBase58(), kp.publicKey.toBase58());
    } finally {
      if (prev === undefined) delete process.env.AGENT_SECRET_KEY;
      else process.env.AGENT_SECRET_KEY = prev;
      delete process.env.SENTINEL_TEST_AGENT_KEY;
    }
  });

  it('rejects malformed secrets', () => {
    const prev = process.env.AGENT_SECRET_KEY;
    try {
      delete process.env.AGENT_SECRET_KEY;
      assert.throws(() => loadAgentKeypair(), /AGENT_SECRET_KEY/);
      process.env.AGENT_SECRET_KEY = '!!!not-base58!!!';
      assert.throws(() => loadAgentKeypair(), /base58/);
      process.env.AGENT_SECRET_KEY = '1'.repeat(10);
      assert.throws(() => loadAgentKeypair(), /64 bytes/);
    } finally {
      if (prev === undefined) delete process.env.AGENT_SECRET_KEY;
      else process.env.AGENT_SECRET_KEY = prev;
    }
  });
});
