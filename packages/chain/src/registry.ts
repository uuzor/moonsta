import { ChainAdapter } from './adapter';
import { ChainId } from './types';

export class UnknownChainError extends Error {
  readonly chain: string;
  constructor(chain: string, supported: ChainId[]) {
    super(`Unknown chain '${chain}'. Supported: ${supported.join(', ') || '(none registered)'}`);
    this.chain = chain;
  }
}

export class UnknownProtocolError extends Error {
  constructor(chain: string, protocol: string, supported: readonly string[]) {
    super(`Unknown protocol '${protocol}' on ${chain}. Supported: ${supported.join(', ')}`);
  }
}

const adapters = new Map<ChainId, ChainAdapter>();

export function registerAdapter(adapter: ChainAdapter): void {
  adapters.set(adapter.chain, adapter);
}

export function getAdapter(chain: string): ChainAdapter {
  const found = adapters.get(chain as ChainId);
  if (!found) throw new UnknownChainError(chain, [...adapters.keys()]);
  return found;
}

export function supportedChains(): ChainId[] {
  return [...adapters.keys()];
}

/** Test-only: reset the registry between cases. */
export function clearAdapters(): void {
  adapters.clear();
}
