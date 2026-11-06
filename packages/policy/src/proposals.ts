import { Connection, Keypair } from '@solana/web3.js';
import {
  ProposalRow,
  getProposal,
  insertAuditEvent,
  markProposalsExpired,
  recordSpend,
  resolveProposal,
  setProposalOutcome,
} from '@sentinel/db';
import {
  SimulationError,
  buildWithdrawalTx,
  executeSwap,
  sendAndConfirm,
  verifyWithdrawalTx,
} from '@sentinel/chain-solana';
import { PolicyDeniedError, assertSwapAllowed, checkFunds } from './check';
import { SwapProposalPayload, WithdrawalPayload, usableAddress } from './withdrawals';

export interface ApproveDeps {
  connection: Connection;
  agent: Keypair;
}

async function loadPending(proposalId: string): Promise<ProposalRow> {
  await markProposalsExpired();
  const p = await getProposal(proposalId);
  if (!p) throw new Error('proposal not found');
  if (p.status !== 'pending') throw new Error(`proposal already ${p.status}`);
  return p;
}

type Actor = 'user' | 'agent' | 'system';

export async function rejectProposal(proposalId: string, actor: Actor = 'user'): Promise<void> {
  const p = await loadPending(proposalId);
  const claimed = await resolveProposal(p.id, 'rejected');
  if (!claimed) throw new Error('proposal already resolved');
  await insertAuditEvent({
    walletId: p.wallet_id,
    actor,
    action: 'proposal_rejected',
    detail: { proposalId: p.id, kind: p.kind },
  });
}

async function assertWithdrawalAllowed(walletId: string, pl: WithdrawalPayload): Promise<void> {
  if (!(await usableAddress(walletId, pl.toAddress))) {
    throw new Error('destination address is no longer usable (revoked or cooling down)');
  }
  const caps = await checkFunds(walletId, pl.usdValue);
  if (!caps.allowed) throw new PolicyDeniedError(caps.reason);
}

export interface PreviewResult {
  kind: string;
  summary: string;
  simulation: 'ok';
  outAmount?: string;
}

/** Validate + build + simulate without changing state or sending. */
export async function previewProposal(
  deps: ApproveDeps,
  proposalId: string,
): Promise<PreviewResult> {
  const p = await loadPending(proposalId);
  if (p.kind === 'swap') {
    const pl = p.payload as SwapProposalPayload;
    const r = await executeSwap({
      connection: deps.connection,
      keypair: deps.agent,
      inputMint: pl.inputMint,
      outputMint: pl.outputMint,
      amountRaw: pl.amountRaw,
      slippageBps: pl.slippageBps,
      dryRun: true,
      beforeBuild: (quote) =>
        assertSwapAllowed({
          walletId: p.wallet_id,
          inputMint: pl.inputMint,
          outputMint: pl.outputMint,
          amountRaw: pl.amountRaw,
          usdValue: pl.usdValue,
          slippageBps: pl.slippageBps,
          quote,
        }),
    });
    return {
      kind: 'swap',
      summary: `${pl.amountRaw} ${pl.inputMint.slice(0, 4)}… -> ~${r.outAmount} ${pl.outputMint.slice(0, 4)}…`,
      simulation: 'ok',
      outAmount: r.outAmount,
    };
  }
  const pl = p.payload as WithdrawalPayload;
  await assertWithdrawalAllowed(p.wallet_id, pl);
  const tx = await buildWithdrawalTx({
    connection: deps.connection,
    from: deps.agent,
    mint: pl.mint,
    amountRaw: pl.amountRaw,
    toAddress: pl.toAddress,
  });
  const ok = await verifyWithdrawalTx(tx, {
    from: deps.agent.publicKey,
    to: pl.toAddress,
    mint: pl.mint,
    amountRaw: pl.amountRaw,
  });
  if (!ok) throw new Error('built withdrawal failed structural verification');
  tx.sign([deps.agent]);
  const sim = await deps.connection.simulateTransaction(tx, { sigVerify: false });
  if (sim.value.err) {
    throw new SimulationError(
      `Simulation failed: ${JSON.stringify(sim.value.err)}`,
      sim.value.logs ?? [],
    );
  }
  return {
    kind: 'withdrawal',
    summary: `${pl.amountRaw} ${pl.mint.slice(0, 4)}… -> ${pl.toAddress.slice(0, 4)}…`,
    simulation: 'ok',
  };
}

/** Approve and execute exactly once. Re-validates everything at execution time. */
export async function approveProposal(
  deps: ApproveDeps,
  proposalId: string,
  actor: Actor = 'user',
): Promise<{ signature: string }> {
  const p = await loadPending(proposalId);
  const claimed = await resolveProposal(p.id, 'approved');
  if (!claimed) throw new Error('proposal already resolved');
  try {
    let signature: string;
    if (p.kind === 'swap') {
      const pl = p.payload as SwapProposalPayload;
      const r = await executeSwap({
        connection: deps.connection,
        keypair: deps.agent,
        inputMint: pl.inputMint,
        outputMint: pl.outputMint,
        amountRaw: pl.amountRaw,
        slippageBps: pl.slippageBps,
        dryRun: false,
        beforeBuild: (quote) =>
          assertSwapAllowed({
            walletId: p.wallet_id,
            inputMint: pl.inputMint,
            outputMint: pl.outputMint,
            amountRaw: pl.amountRaw,
            usdValue: pl.usdValue,
            slippageBps: pl.slippageBps,
            quote,
          }),
      });
      signature = r.signature ?? '';
      await recordSpend(p.wallet_id, pl.usdValue, 'swap', signature);
    } else {
      const pl = p.payload as WithdrawalPayload;
      await assertWithdrawalAllowed(p.wallet_id, pl);
      const tx = await buildWithdrawalTx({
        connection: deps.connection,
        from: deps.agent,
        mint: pl.mint,
        amountRaw: pl.amountRaw,
        toAddress: pl.toAddress,
      });
      const ok = await verifyWithdrawalTx(tx, {
        from: deps.agent.publicKey,
        to: pl.toAddress,
        mint: pl.mint,
        amountRaw: pl.amountRaw,
      });
      if (!ok) throw new Error('built withdrawal failed structural verification');
      tx.sign([deps.agent]);
      const sim = await deps.connection.simulateTransaction(tx, { sigVerify: false });
      if (sim.value.err) {
        throw new SimulationError(
          `Simulation failed: ${JSON.stringify(sim.value.err)}`,
          sim.value.logs ?? [],
        );
      }
      signature = await sendAndConfirm(deps.connection, tx);
      await recordSpend(p.wallet_id, pl.usdValue, 'withdrawal', signature);
    }
    await setProposalOutcome(p.id, 'executed');
    await insertAuditEvent({
      walletId: p.wallet_id,
      actor,
      action: 'proposal_executed',
      detail: { proposalId: p.id, kind: p.kind, signature },
    });
    return { signature };
  } catch (err) {
    await setProposalOutcome(p.id, 'failed');
    await insertAuditEvent({
      walletId: p.wallet_id,
      actor,
      action: 'proposal_failed',
      detail: { proposalId: p.id, kind: p.kind, error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}
