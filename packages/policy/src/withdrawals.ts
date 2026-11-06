import { PublicKey } from '@solana/web3.js';
import { optional } from '@sentinel/config';
import {
  ProposalRow,
  WithdrawalAddressRow,
  addWithdrawalAddress,
  createProposal,
  getWithdrawalAddress,
  promoteCooledAddresses,
  setWithdrawalAddressStatus,
} from '@sentinel/db';
import { MAX_SLIPPAGE_BPS } from '@sentinel/chain-solana';
import { PolicyDeniedError, checkFunds } from './check';

export function withdrawalCooldownMs(): number {
  return Number(optional('WITHDRAWAL_COOLDOWN_MS', String(24 * 3600 * 1000)));
}

export function proposalTtlMs(): number {
  return Number(optional('PROPOSAL_TTL_MS', String(15 * 60 * 1000)));
}

export interface WithdrawalPayload {
  mint: string;
  amountRaw: string;
  toAddress: string;
  usdValue: number;
}

export interface SwapProposalPayload {
  inputMint: string;
  outputMint: string;
  amountRaw: string;
  usdValue: number;
  slippageBps: number;
  protocol?: string;
  reason?: string;
}

function assertMint(mint: string): void {
  new PublicKey(mint);
}

function assertAmount(amountRaw: string): void {
  if (!/^\d+$/.test(amountRaw) || amountRaw === '0') {
    throw new Error('amountRaw must be a positive integer string');
  }
}

/** Add (or re-add) an address; usable only after the cooldown passes. */
export async function addAddress(
  walletId: string,
  address: string,
  label?: string,
): Promise<WithdrawalAddressRow> {
  new PublicKey(address);
  return addWithdrawalAddress(walletId, address, label, withdrawalCooldownMs());
}

export async function revokeAddress(walletId: string, address: string): Promise<void> {
  const row = await getWithdrawalAddress(walletId, address);
  if (!row) throw new Error('address not on the allowlist');
  await setWithdrawalAddressStatus(row.id, 'revoked');
}

/** True when the address is allowlisted, unrevoked, and past cooldown. */
export async function usableAddress(walletId: string, address: string): Promise<boolean> {
  await promoteCooledAddresses(walletId);
  const row = await getWithdrawalAddress(walletId, address);
  return !!row && row.status === 'active' && Date.now() >= new Date(row.active_at).getTime();
}

/**
 * Request a withdrawal. Always returns a pending proposal — execution needs a
 * separate explicit approval, even for allowlisted, cooled-down addresses.
 */
export async function requestWithdrawal(input: {
  walletId: string;
  mint: string;
  amountRaw: string;
  toAddress: string;
  usdValue: number;
}): Promise<ProposalRow> {
  assertMint(input.mint);
  new PublicKey(input.toAddress);
  assertAmount(input.amountRaw);
  if (!(await usableAddress(input.walletId, input.toAddress))) {
    throw new Error('address not allowlisted, revoked, or still cooling down');
  }
  const caps = await checkFunds(input.walletId, input.usdValue);
  if (!caps.allowed) throw new PolicyDeniedError(caps.reason);
  const payload: WithdrawalPayload = {
    mint: input.mint,
    amountRaw: input.amountRaw,
    toAddress: input.toAddress,
    usdValue: input.usdValue,
  };
  return createProposal(input.walletId, 'withdrawal', payload, new Date(Date.now() + proposalTtlMs()));
}

/** Agent/research path: propose a swap for one-tap approval. */
export async function requestSwapProposal(input: {
  walletId: string;
  inputMint: string;
  outputMint: string;
  amountRaw: string;
  usdValue: number;
  slippageBps: number;
  protocol?: string;
  reason?: string;
}): Promise<ProposalRow> {
  assertMint(input.inputMint);
  assertMint(input.outputMint);
  assertAmount(input.amountRaw);
  if (
    !Number.isInteger(input.slippageBps) ||
    input.slippageBps < 1 ||
    input.slippageBps > MAX_SLIPPAGE_BPS
  ) {
    throw new Error(`slippageBps must be 1..${MAX_SLIPPAGE_BPS}`);
  }
  const caps = await checkFunds(input.walletId, input.usdValue);
  if (!caps.allowed) throw new PolicyDeniedError(caps.reason);
  const payload: SwapProposalPayload = {
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    amountRaw: input.amountRaw,
    usdValue: input.usdValue,
    slippageBps: input.slippageBps,
    protocol: input.protocol,
    reason: input.reason,
  };
  return createProposal(input.walletId, 'swap', payload, new Date(Date.now() + proposalTtlMs()));
}
