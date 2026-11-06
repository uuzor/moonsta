import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
} from '@solana/spl-token';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { SOL_MINT } from './mints';

export interface BuildWithdrawalInput {
  connection: Connection;
  from: Keypair;
  mint: string;
  amountRaw: string;
  toAddress: string;
}

/**
 * Build an unsigned withdrawal transaction: a plain SOL transfer, or an SPL
 * transfer (creating the recipient ATA first when missing). Callers must run
 * verifyWithdrawalTx, simulate, and send separately.
 */
export async function buildWithdrawalTx(input: BuildWithdrawalInput): Promise<VersionedTransaction> {
  if (!/^\d+$/.test(input.amountRaw) || input.amountRaw === '0') {
    throw new Error('amountRaw must be a positive integer string');
  }
  const { connection, from } = input;
  const to = new PublicKey(input.toAddress);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  if (input.mint === SOL_MINT) {
    const ix = SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: to,
      lamports: Number(input.amountRaw),
    });
    const message = new TransactionMessage({
      payerKey: from.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();
    return new VersionedTransaction(message);
  }

  const mint = new PublicKey(input.mint);
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) throw new Error('mint account not found');
  const programId = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const fromAta = await getAssociatedTokenAddress(mint, from.publicKey, false, programId);
  const toAta = await getAssociatedTokenAddress(mint, to, false, programId);
  const instructions = [];
  if (!(await connection.getAccountInfo(toAta))) {
    instructions.push(
      createAssociatedTokenAccountInstruction(from.publicKey, toAta, to, mint, programId),
    );
  }
  instructions.push(
    createTransferInstruction(fromAta, toAta, from.publicKey, BigInt(input.amountRaw), [], programId),
  );
  const message = new TransactionMessage({
    payerKey: from.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

export interface ExpectedWithdrawal {
  from: PublicKey;
  to: string;
  mint: string;
  amountRaw: string;
}

/**
 * Structural verification: the transaction must be exactly the expected
 * withdrawal — right programs, right accounts, right amount, nothing else.
 * Anything unexpected fails closed.
 */
export async function verifyWithdrawalTx(
  tx: VersionedTransaction,
  expected: ExpectedWithdrawal,
): Promise<boolean> {
  try {
    const to = new PublicKey(expected.to);
    const decompiled = TransactionMessage.decompile(tx.message);
    const amount = BigInt(expected.amountRaw);

    if (expected.mint === SOL_MINT) {
      if (decompiled.instructions.length !== 1) return false;
      const ix = decompiled.instructions[0];
      if (!ix.programId.equals(SystemProgram.programId)) return false;
      if (ix.data.length !== 12 || ix.data.readUInt32LE(0) !== 2) return false;
      if (ix.data.readBigUInt64LE(4) !== amount) return false;
      if (ix.keys.length !== 2) return false;
      return (
        ix.keys[0].pubkey.equals(expected.from) &&
        ix.keys[0].isSigner &&
        ix.keys[1].pubkey.equals(to)
      );
    }

    const mint = new PublicKey(expected.mint);
    const ixs = decompiled.instructions;
    if (ixs.length < 1 || ixs.length > 2) return false;
    const transfer = ixs[ixs.length - 1];
    if (!transfer.programId.equals(TOKEN_PROGRAM_ID) && !transfer.programId.equals(TOKEN_2022_PROGRAM_ID)) {
      return false;
    }
    const tokenProgram = transfer.programId;
    if (transfer.data.length !== 9 || transfer.data[0] !== 3) return false;
    if (transfer.data.readBigUInt64LE(1) !== amount) return false;
    if (transfer.keys.length !== 3) return false;
    const fromAta = await getAssociatedTokenAddress(mint, expected.from, false, tokenProgram);
    const toAta = await getAssociatedTokenAddress(mint, to, false, tokenProgram);
    if (!transfer.keys[0].pubkey.equals(fromAta)) return false;
    if (!transfer.keys[1].pubkey.equals(toAta)) return false;
    if (!transfer.keys[2].pubkey.equals(expected.from) || !transfer.keys[2].isSigner) return false;

    if (ixs.length === 2) {
      const create = ixs[0];
      if (!create.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) return false;
      // create-ATA keys: [payer, ata, owner, mint, systemProgram, tokenProgram]
      if (create.keys.length !== 6) return false;
      if (!create.keys[0].pubkey.equals(expected.from) || !create.keys[0].isSigner) return false;
      if (!create.keys[1].pubkey.equals(toAta)) return false;
      if (!create.keys[2].pubkey.equals(to)) return false;
      if (!create.keys[3].pubkey.equals(mint)) return false;
      if (!create.keys[4].pubkey.equals(SystemProgram.programId)) return false;
      if (!create.keys[5].pubkey.equals(tokenProgram)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
