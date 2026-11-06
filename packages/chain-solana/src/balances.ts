import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';

export interface SolBalance {
  lamports: number;
  sol: number;
}

export interface SplBalance {
  mint: string;
  amountRaw: string;
  decimals: number;
  uiAmount: number;
}

export async function getSolBalance(
  connection: Connection,
  owner: PublicKey,
): Promise<SolBalance> {
  const lamports = await connection.getBalance(owner);
  return { lamports, sol: lamports / 1_000_000_000 };
}

async function getProgramBalances(
  connection: Connection,
  owner: PublicKey,
  programId: PublicKey,
): Promise<SplBalance[]> {
  const resp = await connection.getParsedTokenAccountsByOwner(owner, { programId });
  const out: SplBalance[] = [];
  for (const { account } of resp.value) {
    const data = account.data;
    if (!('parsed' in data)) continue;
    const info = data.parsed.info;
    out.push({
      mint: info.mint,
      amountRaw: info.tokenAmount.amount,
      decimals: info.tokenAmount.decimals,
      uiAmount: info.tokenAmount.uiAmount ?? 0,
    });
  }
  return out;
}

/** All SPL balances across classic Token and Token-2022 programs. */
export async function getSplBalances(
  connection: Connection,
  owner: PublicKey,
): Promise<SplBalance[]> {
  const [classic, t22] = await Promise.all([
    getProgramBalances(connection, owner, TOKEN_PROGRAM_ID),
    getProgramBalances(connection, owner, TOKEN_2022_PROGRAM_ID),
  ]);
  return [...classic, ...t22];
}
