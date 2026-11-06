import { Connection, VersionedTransaction } from '@solana/web3.js';

/** Send a signed versioned transaction and wait for confirmation. */
export async function sendAndConfirm(
  connection: Connection,
  tx: VersionedTransaction,
): Promise<string> {
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  const latest = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction(
    { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
    'confirmed',
  );
  return signature;
}
