import { getAdapter, registerAdapter, supportedChains } from '@sentinel/chain';
import { solanaAdapter } from '@sentinel/chain-solana';

// Central chain registration. Adding a chain = import + register here;
// tools below resolve everything by chain id at runtime.
registerAdapter(solanaAdapter);

export { getAdapter, supportedChains };
