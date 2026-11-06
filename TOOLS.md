# Moonsta Tools

Two surfaces: **agent tools** (called by the LLM during a turn) and **operator CLIs** (scripts for humans). Chains supported today: `solana`. Adding a chain = new `@sentinel/chain-<id>` package + one registration line; no tool changes.

## Agent tools

Read + propose only. No tool signs, sends, approves, or rejects anything — execution and approvals live in the worker/policy paths and chat buttons. Every tool takes `chain` (required, except the aggregating reads where it is optional) and resolves it through the adapter registry; unknown chains fail with the supported list. All wallet tools are ownership-scoped: the address must be registered to the caller's Telegram id or the call fails with "use register_wallet first".

Token inputs accept a mint address or a known symbol (`SOL`, `USDC`, `USDT` on Solana). Amounts come in two forms: `amountRaw` (base units, works standalone) and `amountUi` (human units, needs a wallet for decimals) — exactly one per call.

Turn limits: max 30 tool steps (`AGENT_MAX_TOOL_STEPS`), 8000 output tokens (`AGENT_MAX_OUTPUT_TOKENS`), 40 messages of history (`TURN_HISTORY_LIMIT`), 20 turns/min; `muse-spark-1.3` primary with one failover to `FALLBACK_*` on 429/5xx/timeout.

### register_wallet

Register one of the user's wallet addresses for tracking. Writes an audit entry.

| Param | Required | Type | Meaning |
|---|---|---|---|
| chain | yes | string | e.g. `solana` |
| address | yes | string | Wallet address (format-validated per chain) |
| label | no | string | Friendly label, e.g. `main vault` |

Returns `{ walletId, chain, address }`.

### list_wallets

List the caller's registered wallets.

| Param | Required | Type | Meaning |
|---|---|---|---|
| chain | no | string | Filter to one chain |

Returns `[{ chain, address, label }]`. Empty array when nothing is registered.

### get_portfolio

Portfolio across one wallet, one chain, or everything tracked. Omit both `chain` and `address` to aggregate all registered wallets (per-wallet failures degrade to `{ error }` entries, never fail the whole call).

| Param | Required | Type | Meaning |
|---|---|---|---|
| chain | no* | string | Filter to one chain |
| address | no* | string | One wallet (requires `chain`) |

Returns `{ totalUsd, change24h, wallets: [{ chain, address, report }] }`, where each report holds holdings, values, allocation, risk flags, active guards, and unprotected holdings (≥$10 with no rule). PnL is "since tracking started".

### get_positions

Open positions across one wallet, one chain, or everything tracked. Same aggregation rules as `get_portfolio`.

| Param | Required | Type | Meaning |
|---|---|---|---|
| chain | no* | string | Filter to one chain |
| address | no* | string | One wallet (requires `chain`) |

Returns `{ wallets: [{ chain, address, onchain, tracked }] }`: on-chain protocol positions plus agent-tracked trades.

### score_token

Deterministic risk score 0 (safest) to 100 (riskiest) with grade (`low`/`medium`/`high`/`extreme`), per-factor breakdown (authorities, concentration, liquidity, age, volatility, third-party audit via RugCheck), and a suggested trailing-stop width. Read-only; the model explains the numbers but never sets them. No wallet needed.

| Param | Required | Type | Meaning |
|---|---|---|---|
| chain | yes | string | |
| mint | yes | string | Token mint or symbol |

### manage_guards

Guard-rule lifecycle. `suggest` and `list` are read-only; `apply`/`create` write one rule; `pause`/`resume` flip status.

| Param | Required | Type | Meaning |
|---|---|---|---|
| chain | yes | string | |
| address | yes | string | Must be registered to the caller |
| action | yes | enum | `suggest` \| `apply` \| `create` \| `list` \| `pause` \| `resume` |
| mint | for suggest/apply/create | string | Token mint or symbol |
| ruleId | for pause/resume | string | Rule id |
| kind | for create | enum | `price_drop` \| `trailing_stop` |
| thresholdPct | for create | number | Drop percent that fires (ranges enforced by schema) |
| alertOnly | no | boolean | Notify only, never swap (create, default true) |
| maxSizePct | for create+swap | number | Max % to swap when firing (default 30) |
| toMint | for create+swap | string | Swap destination mint or symbol (default first stable) |

`apply` re-scores the token, skips when already guarded, creates a `trailing_stop` (auto-swap sized 50/30/15% by grade, alert-only for `extreme` risk and stablecoins), and audits with `via: 'chat'`. `create` builds a custom rule from the user's own threshold (baseline = current price on first sight); stablecoins are always forced alert-only. Auto-swaps still need the user's explicit yes in conversation before the agent calls `apply` or `create` with `alertOnly: false`.

### swap

Swaps. `quote` compares venues without moving anything (omit `protocol` to quote all supported); `execute` pre-checks balance and policy, then creates an approval the user must tap — it never sends from chat. Real execution happens only in the approve/worker paths with server-side-verified authorization.

| Param | Required | Type | Meaning |
|---|---|---|---|
| chain | yes | string | |
| type | yes | enum | `quote` \| `execute` |
| baseToken | yes | string | Token to sell: mint or symbol |
| outToken | yes | string | Token to buy: mint or symbol |
| amountRaw | one of raw/ui | string | Input amount in base units |
| amountUi | one of raw/ui | number | Human-readable input amount (needs `address`) |
| protocol | no | string | One venue, or all supported when omitted |
| slippageBps | no | number | Max slippage 1..300 (default 50) |
| address | for execute | string | Must be registered to the caller |
| reason | no | string | Why this swap (stored on the proposal) |

Quote returns `{ base, out, amountRaw, quotes: [{ protocol, outAmount }], best }`. Execute returns `{ proposalId, expires }`. Solana venues today: `jupiter`.

### perp

Perpetuals. `positions` reviews open perps (live); `preview` is gated (needs an L2 feed — the public DLOB endpoint is dead, subscriber-based L2 is Phase 2 work); `open`/`close` are schema-stable but return `{ supported: false }` until Phase 2 (drift execution).

| Param | Required | Type | Meaning |
|---|---|---|---|
| chain | yes | string | |
| address | yes | string | Must be registered to the caller |
| action | yes | enum | `positions` \| `preview` \| `open` \| `close` |
| market | for preview/open/close | string | e.g. `SOL-PERP` |
| side | for preview/open | enum | `long` \| `short` |
| sizeUi | for preview/open | number | Position size, human units |
| leverage | no | number | Desired leverage |

### request_withdrawal

Propose a withdrawal. Destination must be allowlisted, unrevoked, and past the 24h cooldown; policy caps pre-checked. Always needs explicit user approval, even for trusted addresses. Deliberately propose-only — there is no execute mode.

| Param | Required | Type | Meaning |
|---|---|---|---|
| chain | yes | string | |
| address | yes | string | Must be registered to the caller (source wallet) |
| mint | yes | string | Token mint or symbol |
| amountUi | yes | number | Human-readable amount, e.g. `1.5` |
| toAddress | yes | string | Destination (allowlisted + cooled down) |

There is intentionally no add-address tool: allowlist changes stay a deliberate operator/user action outside the LLM's reach. Returns `{ proposalId, expires }`.

### get_proposals

List pending approvals (swaps and withdrawals) with payloads and expiry times. The agent explains them; it cannot approve — approvals come only from chat buttons.

| Param | Required | Type | Meaning |
|---|---|---|---|
| chain | yes | string | |
| address | yes | string | Must be registered to the caller |

### schedule

One-shot scheduled actions, delivered as a chat notification when the `due-actions` job fires them (every minute). `reminder` says something later; `balance_check` snapshots a wallet now and reports any deposit/withdrawal at fire time; `research` runs an on-chain research turn at fire time (prices, portfolio, risk, quotes — no web/news feed yet).

| Param | Required | Type | Meaning |
|---|---|---|---|
| action | yes | enum | `create` \| `list` \| `cancel` |
| kind | for create | enum | `reminder` \| `balance_check` \| `research` |
| inMinutes | for create | number | Minutes from now, integer 1..43200 (agent converts "in 3 hours" → 180) |
| message | for create | string | Reminder text, check label, or research question (max 500 chars) |
| chain | for balance_check | string | Wallet chain when ambiguous |
| address | for balance_check | string | Must be registered to the caller; inferred when the user has exactly one wallet |
| actionId | for cancel | string | Scheduled action id (ownership enforced) |

## Deliberately not tools

- **approve / reject proposals** — Telegram buttons only. If the model could approve, a prompt injection could move funds.
- **Allowlist add / revoke, cap changes, pause** — operator CLI (and later, privileged bot commands), never LLM-callable.
- **Anything that signs or sends** — worker/policy paths only.

## Operator CLIs

| Command | What it does |
|---|---|
| `npm run agent -- ask <telegram-id> "<msg>"` | One-shot agent turn (manual testing, demos) |
| `npm run report -- <WALLET> [--json] [--no-db] [--rpc URL]` | Portfolio report for any address |
| `npm run guard -- suggest <WALLET> [--mint M] [--apply] [--yes] [--json] [--no-db]` | Risk scores + suggested guards; `--apply` saves rules |
| `npm run guard -- list <WALLET>` | Active guard rules |
| `npm run worker -- [--once] [--live] [--interval-ms N]` | Guard evaluator; dry-run default, `--live` sends |
| `npm run policy -- limits <WALLET> [--daily USD] [--per-tx USD]` | Show/set caps |
| `npm run policy -- pause <WALLET>` / `resume <WALLET>` | Kill-switch |
| `npm run policy -- addr add <WALLET> <ADDR> [--label L]` / `list` / `revoke` | Withdrawal allowlist (24h cooldown) |
| `npm run policy -- withdraw request <WALLET> SOL <AMT> <TO>` | Create withdrawal proposal |
| `npm run policy -- swap-propose <WALLET> <IN> <OUT> <RAW> [--slippage BPS] [--reason R]` | Create swap proposal |
| `npm run policy -- proposals <WALLET>` | Pending proposals |
| `npm run policy -- approve <ID> [--dry-run]` / `reject <ID>` | Resolve a proposal |
| `npm run keygen` | Fresh agent keypair (`ADDRESS=` + `AGENT_SECRET_KEY=`) |
