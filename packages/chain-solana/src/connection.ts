import { Connection } from '@solana/web3.js';
import { optional } from '@sentinel/config';

export function resolveRpcUrl(): string {
  return optional('RPC_URL', 'https://api.mainnet-beta.solana.com');
}

export type SolanaEnv = 'mainnet-beta' | 'devnet';

export function resolveSolanaEnv(): SolanaEnv {
  return optional('SOLANA_ENV', 'mainnet-beta') === 'devnet' ? 'devnet' : 'mainnet-beta';
}

export function createConnection(rpcUrl: string = resolveRpcUrl()): Connection {
  return new Connection(rpcUrl, 'confirmed');
}
