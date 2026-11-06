# Moonsta — Plan

Chat-native Solana guardian agent: portfolio guard, scheduled research, and approve-to-execute trading from Telegram. Built for two live hackathons with one codebase.

## Targets

- **MLH Solana Hackathon** (Nov 6–8, online, Devpost deadline Nov 8). AI Track wants autonomous on-chain agents with spending limits + NL-to-transaction interfaces with clear confirmation. DeFi Track ("automated strategies") fits as a second angle.
- **NEAR HACKATHON** (Nov 1–14, $250k pool, no signup; submit public repo + X demo post by Nov 14). Fits Unstoppable DeFi ("trading agents powered by NEAR Intents"), Agent Economy, and Autonomous Business.

## Validated stack

| Decision | Choice | Evidence |
|---|---|---|
| Swaps | Jupiter Swap API V2 (`/swap/v1/quote` → `/swap/v1/swap`) | Official docs: V2 unifies and supersedes Ultra/Metis |
| Perps | Drift via `@drift-labs/sdk` (pin stable, not beta) | npm registry; confirm web3.js major compat at scaffold |
| Bot | Telegram + grammY (TypeScript) | npm registry, current |
| Automation | Custom rules engine + worker; no Zapier; skip n8n for MVP | `INTEGRATION.md` analysis |
| Queue / store | Redis + BullMQ; Postgres (rules, positions, triggers, audit) | npm registry |
| Data in | Helius webhooks/RPC + Pyth; fallback to RPC polling | Verify endpoints/keys at build |
| NEAR leg (P2) | Intents + Chain Signatures (MPC-derived Solana addresses, native assets) | NEAR intents repo |
| Custody | P1: funded agent sub-wallet + server caps + simulation + `/pause`. P2: Squads v4 spending limits | Squads v4 has per-token on-chain caps; verify SDK at build |
| Agent model | Muse Spark (`muse-spark-1.3`) via Meta Model API, OpenAI-compatible at `https://api.meta.ai/v1`; fallback = second OpenAI-compatible provider from env, fail over once on 429/5xx/timeout | Meta docs (base URL, models, tool_calls); fallback provider TBD |
| Agent framework | Vercel AI SDK (`ai` + `@ai-sdk/openai-compatible`, matched majors per peerDeps) + our own typed tools over existing packages; Solana Agent Kit rejected for execution (its custody model conflicts with the policy engine) | AI SDK package readme (createOpenAICompatible); SAK search-level |
| Chain adapters | Thin agent, fat tools: one tool surface with `chain` param; `@sentinel/chain` defines the interface, `@sentinel/chain-<id>` packages implement it (Solana first). Policy stays centralized and is checked at propose time (fail fast) and execution time (enforced). Approvals are never agent tools — user buttons only. | Architecture decision (user-approved) |
| Concurrency | BullMQ/Redis queue + per-user Redis locks + per-user LLM budgets; in-memory drivers for sandbox/demo where Redis is unavailable | Design decision (user: full SaaS now, one server key) |

LLM does NL→rule JSON and digest synthesis only. Guard triggers, risk numbers, and policy checks are deterministic code. Fetched token data/news is untrusted input, never flows into rule logic.

## Architecture

```
Telegram (grammY): webhook ingress → enqueue turn → ack; callbacks enqueue resume-jobs
        │
  agent queue (BullMQ: agent-turns) ── per-user lock serializes turns; rate-limited
        │
  agent workers (stateless, horizontal) ── Muse Spark + fallback router
        │     │                              │ budgets/steps/timeout per turn
        │     │                         tools (READ + PROPOSE only, never sign):
        │     │                         portfolio, positions, risk, guards, proposals
        │     │                              │ chain param → adapter registry
        │     │                         @sentinel/chain-<id> packages (solana, near…)
        │     └── Postgres (history, llm_usage, budgets) + Redis (locks, counters)
        │
  rules engine ── NL→JSON schema validation, spending caps, user confirm
        │
  guard worker ── evaluator (deterministic) → policy engine → executor
  (separate queue,      │                          │              │
   never starved)  Helius/Pyth              allowlists,     venue adapters:
                   streams+poll              caps, sim      Jupiter-V2 → Drift → NEAR Intents
                        │                       check            │
        └── Postgres (rules, positions, triggers, audit, snapshots)
        └── research cron ── digest + one proposal with approve button
```

Money safety: the LLM only reads and proposes. All signing stays in the
worker/policy path; approvals resolve via callback jobs, withdrawals always
require explicit approval, and the model never sees secret keys.

Venue adapter interface: `watch / getRisk / buildTx / simulate`. Adding a venue = one file.

## Feature set

1. **Portfolio awareness + full report.** Reader pulls SOL, all SPL balances, USD values, open Drift positions. `report` returns holdings, allocation %, 24h change, risk flags, active rules, unprotected tokens. PnL labeled "since tracking started" (cost basis only for agent-made or reconstructible trades). Scheduled snapshots feed the digest.
2. **Per-token risk scoring + suggested stops.** Deterministic scorer: mint/freeze authority, holder concentration, liquidity depth, token age, volatility. Runs on new tokens and pre-buy. Suggests stop-loss width (~1.5–2x recent ATR, tighter on high-risk) with an "Apply suggested guard" button. LLM explains only. First cut uses sensible defaults, not a tuned model.
3. **Guard rules.** Price-drop and trailing-stop rules with pre-approved bounded execution (e.g. "may sell up to 30% of X to USDC if stop triggers"); alert-only mode also available. Drift liquidation-distance alerts (read-only in P1).
4. **Policy engine.** Between every trigger/request and signing. Within limits: swaps, perp open/close (P2), prediction trades (later) — checked against per-tx cap, daily cap, token/program allowlists, slippage. **Withdrawals (any transfer out of user control) always require explicit approval** — no pre-authorization can cover them. Post-simulation verification: instructions touch allowlisted programs only, outputs land in user's own accounts. Withdrawal addresses from a user-confirmed allowlist with cooldown on new entries.
5. **Research digests.** Scheduled job → trending/yield/news brief + one concrete proposal with Approve/Reject.
6. **Position monitoring loop.** Every execution registers a position the guard watches: guard → research → propose → execute → guard.
7. **Safety rails.** Tx simulation, slippage caps, daily loss limit, `/pause` kill switch, idempotent triggers (no double-sell), chat-readable audit log.
8. **Conversational agent.** Muse Spark (+ fallback) driving typed tools: `get_portfolio` and `get_positions` (chain/address optional, aggregate when omitted), `score_token`, `manage_guards`, `swap` (`quote` compares venues, `execute` pre-checks then proposes — never sends from chat), `perp` (positions live, trading Phase 2), `request_withdrawal` (propose-only), `get_proposals`, `register_wallet`, `list_wallets`. Tools pre-check policy/balance (fail fast), execution paths re-check (enforced). Approve/reject are NOT tools — Telegram buttons only. Max 30 tool steps and 8000 output tokens per turn, 40 messages of history, 20 turns/min; budgets persisted per user.
9. **Multi-user concurrency.** One server Muse key with per-user daily token/$ budgets and turn caps; BullMQ turn queue with per-user locks (no interleaved turns, no double-spend race); stateless workers scale horizontally; guard queue stays independent. In-memory queue/lock drivers for sandbox/demo, Redis drivers for prod.

## Phase 1 — MLH weekend (Nov 6–8)

- [x] Monorepo scaffold + Postgres/Redis via Compose
- [x] Portfolio reader + full report
- [x] Risk scorer + suggested stop-loss + one-tap apply
- [x] Price-drop / trailing-stop guards + Jupiter V2 execution
- [x] Policy engine + withdrawal approval flow
- [x] Agent core (chain packages + Solana adapter; Spark + fallback router; tools; runTurn)
- [x] Concurrency (turn queue, per-user locks, budgets; memory + Redis drivers)
- [x] Modular scheduler (job registry + monitored runner; memory/cron + BullMQ drivers; sweep + snapshot jobs; digest slot reserved)
- [x] Reaction pipeline, time + price (rule_fired / proposal_expired events; AI notify_first / act_then_notify via drain-reactions; wallet-diff + digest content later)
- [x] Action schedule (custom price alerts from chat; one-shot reminders, balance checks, research briefs via schedule tool + due-actions job; Mini App Schedules tab)
- [x] Telegram UI wired to agent queue, `/pause`, audit log (+ Approve/Reject buttons; needs TELEGRAM_BOT_TOKEN for live)
- [x] Mini App dashboard (portfolio + sparkline, positions, guard toggles, in-app approvals, activity; needs https URL + MINIAPP_URL for live)
- [ ] One scheduled digest
- [ ] Drift read-only liquidation alerts
- [ ] Crash demo (devnet or simulated trigger) + recording
- [ ] Devpost submission

## Phase 2 — NEAR week (Nov 9–14)

- [ ] Drift execution (reduce-only close from guard; reference: `sendaifun/solana-agent-kit` `plugin-defi/src/drift/tools/drift.ts` → `driftPerpTrade`, Apache-2.0)
- [ ] NEAR Intents settlement leg / chain-abstraction custody story
- [ ] Wallet ownership proof (sign-a-nonce; tracking ≠ control today)
- [ ] Squads v4 spending limits (if SDK checks pass)
- [ ] Prediction markets if room, else roadmap slide
- [ ] Polish, README, public repo + X demo post, NEAR submission

## Validation

- `typecheck` + unit tests green before any demo: schema accept/reject, cap enforcement, idempotency, policy classification (withdrawal always blocked without approval).
- Devnet E2E: fund agent wallet → set rule in chat → force trigger → assert simulated + executed swap + audit entry.
- Kill-switch test: `/pause` blocks a pending trigger. Withdrawal test: unapproved withdrawal blocked, approved one executes to allowlisted address.
- Submission checklists: Devpost + video (Nov 8); public repo + X post (Nov 14).

## Risks

- **Timeline** is the top risk (~3 days to MLH). Phase 1 cuts are deliberate; prediction markets and multi-chain stay on the roadmap slide.
- Build-time verifications: Jupiter V2 schema, Drift stable pin + web3.js compat, Helius/Pyth keys, Squads SDK, Intents API shape.
- Judge probes: key handling (devnet + tiny amounts), prompt injection via token metadata.
- Redis is unavailable in this sandbox (no daemon): agent/queue work runs on the in-memory drivers here; Redis drivers get exercised via Compose where Docker runs.
- Meta API rate limits untested: verify on first live call; fallback provider choice still TBD (env-configured, any OpenAI-compatible endpoint).
- `ai` + `@ai-sdk/openai-compatible` majors must match: resolve via peerDeps at install time.

## Sources

- https://events.mlh.com/events/15200-solana-hackathon
- https://www.near.org/blog/near-hackathon-build-beyond-boundaries
- https://raw.githubusercontent.com/near/near-intents/main/content/use-cases/chain-abstraction.md
- https://developers.jup.ag/docs/swap-api
- https://registry.npmjs.org/%40drift-labs%2Fsdk/latest
- https://registry.npmjs.org/grammy/latest
- https://registry.npmjs.org/%40solana%2Fweb3.js/latest
- https://registry.npmjs.org/bullmq/latest
- https://registry.npmjs.org/pg/latest
- https://dev.meta.ai/docs/getting-started/overview
- https://dev.meta.ai/docs/cookbook/tool-function-calling
- https://registry.npmjs.org/%40ai-sdk%2Fopenai-compatible

◆ Good timing for this question — the scheduler step just gave us the plumbing to do it properly. Here's the full
  picture.

  What the system can react to today

  Guard rules (worker loop, polled):
  • price_drop — live. Fires when spot price falls X% vs baseline.
  • trailing_stop — live. Fires when price falls X% off the running high.
  • liq_distance — schema only. Validates, but the evaluator skips it (liq-deferred). Drift liq alerts don't
    actually fire yet.
  • On fire, only two outcomes exist: alert (writes an audit event, rule expires — currently goes nowhere
    user-visible, no Telegram message is sent) or swap (pre-approved bounded Jupiter sell, agent wallet only,
    otherwise downgraded to the same silent alert).

  Scheduled jobs (new scheduler, time-based only):
  • sweep-proposals — expires stale proposals. No user reaction.
  • snapshot-wallets — records portfolio state. Doesn't compare or react to changes.
  • sentinel-digest — stub slot, no content.

  Not reactive at all yet: everything the docs promise around wallet/token watching — new token appearing in a
  wallet, rug signals changing (LP removal, authority flips, holder dumps), large outflows,
  funding/news/trending. The scorer reads these statically on demand, but nothing watches them continuously.

  React to price — what else?

  In priority order, the reaction taxonomy I'd build toward:

  1. Price thresholds — have it.
  2. Wallet changes — new token in, large outflow, balance deltas. This just became cheap: we snapshot every 15
     min, so diffing snapshots gives us all of these nearly free.
  3. Token safety changes — rescore-on-diff: authority flip, LP drain, concentration shift on a held token.
  4. Position risk — liq distance (schema exists, needs the evaluator half), lending health later.
  5. Market/research signals — funding, news, trending, yield moves (digest step).
  6. Policy/time events — cap usage warnings, cooldown completions, proposal expiry (have the sweep, no
     notification).

  On your proposal: trigger → AI acts/notifies

  I agree with the direction but want to push back on one point: making the AI the decider for urgent protection
  breaks the core safety story. If SOL is crashing at 3am and the LLM is rate-limited, down, or slow, the
  pre-approved stop must still fire in seconds. "Money-moving logic never depends on the model's mood" is also
  the line judges will probe.

  The hybrid I'd implement instead — deterministic trigger, AI-handled reaction:

  • Every trigger becomes a first-class reaction event (rule fired, new token, rug signal, cap warning) instead
    of just an audit row.
  • Each rule/job carries a notify policy:
    • act_then_notify (default for pre-approved swaps) — worker executes immediately within caps, then enqueues
      an agent turn that explains what happened and what's next.
    • notify_first (default for alerts, new tokens, rug signals, digest items) — agent messages the user with
      context and an approve-to-act button; nothing moves without confirmation.
  • The agent turns go through the existing turn pipeline (queue + per-user lock + budget), so reactions can't
    interleave with the user's own chat or double-spend, and a trigger storm degrades to queued notifications
    instead of 1000 simultaneous LLM calls.

  This keeps your UX — the AI always narrates, and for non-urgent things it notifies before anything happens —
  without putting the 3am protection path behind an API call.

  If that hybrid sounds right, the build order is: reaction event envelope + emitter in worker/scheduler →
  notify_first path for alerts (needs the Telegram send path, which is the bot step anyway) → snapshot-diff
  reactions (new token, outflow) → act_then_notify for swaps. Want me to start with the event envelope + snapshot
  diffing, or do you want pure AI-decides for everything?