import { Keypair } from '@solana/web3.js';
import { encodeSecretKey } from '@sentinel/chain-solana';

// Generates a fresh agent keypair. Fund the address with a small amount and
// put the secret in .env as AGENT_SECRET_KEY (never commit it).
const kp = Keypair.generate();
console.log(`ADDRESS=${kp.publicKey.toBase58()}`);
console.log(`AGENT_SECRET_KEY=${encodeSecretKey(kp)}`);
