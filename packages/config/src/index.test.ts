import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { optional, parseEnvFile, required } from './index';

describe('parseEnvFile', () => {
  it('parses keys, skips comments and blanks, strips quotes', () => {
    const parsed = parseEnvFile(
      '# comment\n\nRPC_URL=https://example.com\nEMPTY=\nQUOTED="a=b"\nSINGLE=\'x y\'\n',
    );
    assert.deepEqual(parsed, {
      RPC_URL: 'https://example.com',
      EMPTY: '',
      QUOTED: 'a=b',
      SINGLE: 'x y',
    });
  });
});

describe('optional/required', () => {
  it('falls back and throws as expected', () => {
    delete process.env.SENTINEL_TEST_MISSING;
    assert.equal(optional('SENTINEL_TEST_MISSING', 'fb'), 'fb');
    assert.throws(() => required('SENTINEL_TEST_MISSING'), /Missing required env var/);
    process.env.SENTINEL_TEST_MISSING = 'v';
    assert.equal(required('SENTINEL_TEST_MISSING'), 'v');
    delete process.env.SENTINEL_TEST_MISSING;
  });
});
