# Moonsta — your money copilot that never sleeps

Chat-native Solana guardian agent living in Telegram: it watches your wallets,
warns you before damage happens, and acts within limits you set — even at 3am.
Portfolio guard, scheduled research, and approve-to-execute trading from chat.

**Try it live:** message [@Clawbuns_bot](https://t.me/Clawbuns_bot) on Telegram,
send `/start`, then paste any Solana wallet address.

Things to try in chat:

```text
what is my total value?                    # full portfolio report
warn me if SOL drops 12%                   # custom price alert
in 1 minute check if my deposit arrived    # one-shot balance check
brief me on my SOL exposure in an hour     # one-shot research brief
suggest stop-losses for my tokens          # risk scores + one-tap guards
```

## Setup

Prerequisites: Node 22+, Docker.

```bash
cp .env.example .env   # fill in: MODEL_API_KEY, TELEGRAM_BOT_TOKEN, RPC_URL
docker compose up -d   # Postgres + Redis
npm install
npm run typecheck
npm run test           # 96 tests, node:test via tsx

# One-time: agent signing key + live services
npm run keygen                  # fresh agent keypair -> AGENT_SECRET_KEY in .env
npm run bot         # Telegram interface (long polling)
npm run scheduler   # cron: proposal sweep, snapshots, due-actions, reaction drain, digest
npm run worker -- --interval-ms 15000   # guard loop (dry-run; add --live to send)
```

The Mini App dashboard:

```bash
npm run web:build   # build the React client once
npm run web         # serve client + JSON API on :3000
```

## How Solana powers Moonsta

Solana isn't a wallet-connect button here — it's the product surface:

- **Reads:** every balance, SPL holding, USD price (Jupiter Price API), and
  open Drift perp position is read live from Solana for reports, risk scores,
  and guard evaluation.
- **Guards:** price-drop and trailing-stop rules evaluate against live prices
  each tick; pre-authorized protective swaps execute through **Jupiter V2**
  (`/swap` with quote-echo verification), simulated before send.
- **Risk:** the deterministic scorer reads mint/freeze authorities, holder
  concentration, and liquidity depth on-chain, plus RugCheck verdicts.
- **Safety:** the policy engine caps spend, allowlists programs, verifies
  simulated transactions structurally (outputs must land in user accounts),
  and forces explicit approval for every withdrawal.
- **Custody path:** agent hot wallet today; SPL delegations → Squads →
  NEAR Chain Signatures sessions next (see [Custody.md](./Custody.md)).

## CLI tour

```bash
# Full portfolio report for any Solana wallet:
npm run report -- <WALLET_ADDRESS> [--json]

# Risk scores + suggested stop-loss guards (add --apply to save as rules):
npm run guard -- suggest <WALLET_ADDRESS>
npm run guard -- list <WALLET_ADDRESS>

# Agent: one-shot turn, or full pipeline (queue + lock + budget + history):
npm run agent -- ask <TELEGRAM_ID> "track wallet <ADDRESS> on solana"
npm run agent -- chat <TELEGRAM_ID> "what is my total value?"
npm run agent -- probe [--users N] [--live]   # concurrency probe
npm run agent -- eval                          # quality eval: grounding, memory, honesty

# Scheduler: jobs, single fires, run history:
npm run scheduler -- --list
npm run scheduler -- --once <job>
npm run scheduler -- runs [--limit N]

# Policy: caps, kill-switch, withdrawal allowlist, approval proposals:
npm run policy -- limits <WALLET> [--daily USD] [--per-tx USD]
npm run policy -- pause <WALLET>   # resume to unpause
npm run policy -- addr add <WALLET> <ADDRESS>   # 24h cooldown before usable
npm run policy -- withdraw request <WALLET> SOL <AMOUNT> <TO>
npm run policy -- approve <PROPOSAL_ID> [--dry-run]   # reject to decline
```

## Layout

```text
apps/bot         Telegram interface (grammY): chat, commands, approve buttons
apps/web         Mini App dashboard (React + Hono): wallet, guards, approvals, schedules
apps/worker      Guard evaluator + executor (dry-run default, --live to send)
apps/scheduler   Cron daemon: proposal sweep, snapshots, due-actions, reaction drain, digest
apps/research    Research digest content (reserved)
packages/agent      Muse Spark + fallback router, tools, turn runner
packages/chain      Chain adapter interface + registry (chain-agnostic)
packages/chain-solana Solana adapter, Jupiter executor, Drift read-only
packages/db       Postgres schema access (pg)
packages/jobs     Job registry + monitored runner (memory/cron + BullMQ)
packages/policy   Caps, pause, allowlists, proposals, quote/structural verify
packages/portfolio  Report builder + text formatter
packages/queue    Turn queue, locks, counters (memory + Redis drivers)
packages/risk     Deterministic 6-factor token scorer
packages/rules    Guard rule schema + validation
db/init.sql       Schema (auto-applied by Compose on first start)
```

## Docs

- [plan.md](./plan.md) — build plan and phase checklists
- [TOOLS.md](./TOOLS.md) — agent tool reference
- [Custody.md](./Custody.md) — custody architecture and session model
- [DEPLOY.md](./DEPLOY.md) — production deploy notes (Vultr)

## Environment notes

- Tests run on Node's built-in runner (`tsx --test`).
- RPC: the default public endpoint rate-limits heavy calls. Set `RPC_URL` to a
  Helius (or other dedicated) endpoint for guard workloads.
