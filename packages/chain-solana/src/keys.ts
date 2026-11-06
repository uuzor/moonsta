import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { required } from '@sentinel/config';

/** Agent signing key from AGENT_SECRET_KEY (base58). Never log the secret. */
export function loadAgentKeypair(): Keypair {
  const secret = required('AGENT_SECRET_KEY');
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(secret.trim());
  } catch {
    throw new Error('AGENT_SECRET_KEY is not valid base58');
  }
  if (bytes.length !== 64) {
    throw new Error(`AGENT_SECRET_KEY must decode to 64 bytes, got ${bytes.length}`);
  }
  return Keypair.fromSecretKey(bytes);
}

export function encodeSecretKey(keypair: Keypair): string {
  return bs58.encode(keypair.secretKey);
}
