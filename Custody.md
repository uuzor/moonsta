# Moonsta — Custody Architecture

Decision: ship Phase 1 (MLH weekend) on an **agent hot wallet** with the
off-chain policy engine. Everything below is the recorded progression path,
designed so each step narrows trust without changing policy semantics.

## Guiding principle: full autonomy inside the sandbox, one hard gate

The agent's job is protecting capital while the user sleeps — waiting for
approval at 3am defeats the purpose. So the agent is **fully autonomous
inside the session sandbox**: protective swaps within caps, perp
risk-reduction (reduce-only), guard re-arming — all act-then-notify, no
approval. Research proposals and new positions are notify-first (nothing
bleeds at 3am there). Exactly one action class always requires explicit
approval: **withdrawals to external addresses** (money leaving user control
entirely). This gate survives every custody upgrade, including MPC — it is
the line between "delegated protector" and "custodian."

## Core model: sessions × sponsorship

Two orthogonal pieces that compose:

- **Session = authorization.** The user grants the agent bounded authority:
  spend up to X, only these programs/tokens, expires at T, revocable anytime.
- **Sponsorship = gas.** The agent (or a paymaster) pays execution fees out of
  its own pocket, tracked against its own caps.

Stacked, the agent acts *within the session* and *pays its own way*. The user
signs one session setup, funds nothing, holds no gas tokens. Sponsorship is
what makes sessions practical — it deletes the classic "fund the session key
with gas" friction.

## Current state (Phase 1): hot wallet + policy engine

- Agent keypair (`AGENT_SECRET_KEY`) holds a small funded balance; it is the
  only key that can move funds, and only from the agent wallet.
- All limits live in the policy engine: per-tx cap, daily cap, token/program
  allowlists, slippage caps, `/pause` kill switch, withdrawal approvals.
- Every execution path re-checks policy in `beforeBuild` plus post-simulation
  structural verification (allowlisted programs only, outputs to user accounts).
- Honest framing: weakest custody story, strongest velocity. Correct for the
  weekend demo.

## Progression path (trust narrows, semantics stay)

1. **Hot wallet + off-chain policy** (now). Limits enforced by our code.
2. **SPL token delegations (`approve`/`revoke`)** (cheap next step). User
   approves the agent to spend up to X of a specific token, revocable anytime.
   On-chain-enforced sessions for swaps; does not cover SOL or perps.
3. **Squads smart wallet** (Solana-native endgame). Agent is a limited,
   time-bound signer; user stays admin and can revoke. Caps/expiry on-chain.
4. **NEAR Chain Signatures + policy contract** (cross-chain endgame, NEAR
   week). Sessions live in one place (NEAR) while execution happens everywhere
   (see below).

The policy engine is already the session policy — each step only moves the
same semantics (caps, allowlists, expiry, revocation) into on-chain
enforcement. Session validity (expired? allowance remaining?) becomes one more
tool pre-check; sponsor spend becomes one more capped spend category.
`beforeBuild` and structural verification do not change.

## NEAR Chain Signatures: custody analysis

Verified against current NEAR docs (Nov 2026): MPC network, no single party
ever holds the private key; Solana (Ed25519) supported on mainnet; derived
address = f(MPC master key, NEAR account, path); production-proven via NEAR
Intents ($30B+ volume).

- **Key custody: no.** There is no raw key material anywhere, including on
  our server.
- **Effective custody = whoever can authorize `sign`.** The only way to get a
  signature is calling `v1.signer` as the NEAR account (or via a proxy
  contract). If our server key can request arbitrary signatures, we effectively
  custody the funds and a sharp judge will see through it.
- **Target design:** user-controlled NEAR account + on-chain policy contract
  gating `sign` requests (paths, spend, expiry, revocation) = delegated
  authority with limits, not custody.
- **Residual trust:** the MPC validator threshold set (secured by NEAR
  staking). Trust-minimized, not trustless — one honest sentence on the slide.
- **Cost note:** every signature request is itself a NEAR transaction (NEAR
  gas per signature) on top of destination-chain gas.
- **Code impact:** contained signer swap. The Solana executor keeps building
  and verifying transactions exactly as today; only the signing step changes
  from local keypair to `v1.signer` request.

## Sponsored fees ("gasless" done honestly)

Chain Signatures solves keys, not gas: a zero-balance derived address cannot
transact on any chain. Gasless UX needs a sponsor layer on top:

- **Solana: easy.** Sub-cent fees + native fee-payer/instruction-signer
  separation. Our sponsor key pays; the user's derived address authorizes.
- **EVM: paymaster/relayer.** Real infra, sane on L2s. Roadmap.
- **Bitcoin: no abstraction.** Fees in BTC, someone funds the address.
- **NEAR Intents swaps:** gasless only in the narrow sense (solvers take fees
  from the trade). Swaps, not arbitrary transactions.

Pitch line: "MPC custody, zero SOL required in the user's wallet, every cent
of sponsor spend capped and audited by the policy engine."

## Session object (shape, to be specced against the policy engine)

- `scope`: chains + programs/tokens allowed (maps to allowlists).
- `allowance`: per-tx and total spend caps (maps to caps).
- `expires_at`: hard expiry; expired sessions fail pre-checks.
- `revoked`: user revocation; `/pause` is the global equivalent.
- `sponsor_cap`: max gas spend attributable to this session.
