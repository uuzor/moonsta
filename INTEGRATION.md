which platforms are doing this?

for automation what do you think i should use, because its mostly needs ai to configure it at ask time , n8n or zapier?

Weighing KeeperHub as a possible option
Thought for 6s

Comparing n8n and Zapier for dynamic rules.

Weighing KeeperHub as a possible option.

My pick is a small custom rules engine for the guard layer, with n8n as optional glue for the research side. I’d skip Zapier.

Why not Zapier
Latency: most triggers poll on a schedule, which is too slow when a dump is happening.
Per-user rules: your agent has to create a new rule whenever a user says “if SOL drops 12%, sell half.” Programmatically generating Zaps per user is awkward, and per-task pricing gets expensive with many users and constant price checks.
No on-chain primitives: no native Solana wallet, simulation, or signing story.
Hackathon optics: judges want to see your agent, not a no-code workflow.
Why n8n is better, but still not ideal for the guard
It’s self-hostable and webhook-friendly. It also has an API for creating and activating workflows, so an LLM can generate a workflow at ask time.
It handles scheduled research well: cron, fetch trending data, LLM summary, Telegram message with approve buttons.
For the guard, having an LLM generate a workflow per user rule makes money-moving logic non-deterministic and hard to test. That’s the part you least want to be flexible.
What I’d build instead
The “AI configures at ask time” part doesn’t need a workflow tool. It needs a schema:

The user says: “If my SOL perp is within 8% of liquidation, close half.”
The LLM translates this into a structured rule, for example {asset, condition, threshold, action, max_size, expires}.
Your code validates the JSON against a strict schema and the user’s spending limits, then shows it back for confirmation.
It saves to a Postgres table.
A plain worker subscribes to price and position streams (Pyth plus a Helius webhook or websocket) and evaluates the stored rules. When one fires, it simulates the transaction and executes it within the pre-authorized limits.
This is faster, cheaper, testable, and secure. The LLM only handles language to rule, and code handles rule to action.

Suggested split
Piece	Tool
Chat parsing, rule creation	LLM and a strict JSON schema
Guard triggers and execution	Custom worker (Node/TS or Python)
Scheduled research digests	n8n, or just a cron job in your own code
Telegram interface	grammY or python-telegram-bot
For a one-week hackathon, I’d even skip n8n and write the research job as a cron script, so there’s one codebase to demo. Use n8n only if you want the research pipeline editable without redeploying.

One more option: I have a web3 workflow automation integration (KeeperHub) available in this session. I haven’t looked at it yet, but it may fit if you’d rather not build the execution plumbing yourself. I can check what it offers and whether it supports spending limits and on-chain triggers. Want me to?

if we use a worker , 1. how do we scale because this is a saas and for automations that doesnt use api eg perp positions and prediction market trades , how do we do it

Comparing on-chain and off-chain automation options
Scaling is mostly about not polling per user, and the “no API” problem mostly disappears once you read chain state directly.

1. Scaling the worker
Don’t run a loop per user. Invert it: watch markets and accounts, then fan out to the rules they affect.

Index rules by what they depend on. Store each rule with its dependency (e.g. SOL price, Drift account X, mint Y liquidity). A thousand users watching SOL means one price subscription, not a thousand.
Price rules: keep one Pyth stream per asset. On each tick, query “rules for asset X where threshold crossed.” Sorted or indexed thresholds make that a cheap range lookup instead of a full scan.
Account and position rules: subscribe to the accounts via Helius/Triton webhooks or Yellowstone gRPC, so the chain pushes changes to you.
Safety-net sweep: run a slower periodic reconciliation over all positions (every 30-60s) in case a push event is missed.
Architecture that scales:

Streams (Pyth, webhooks, gRPC)
   → ingest service (normalizes events)
   → queue (Redis Streams / BullMQ / NATS)
   → evaluator workers (stateless, horizontally scaled)
   → executor workers (simulate → sign → send → confirm)
   → Postgres (rules, positions, audit log)
Key details:

Stateless evaluators let you add workers freely. Shard by user ID or asset.
Idempotency: give each trigger a unique key so a retry or duplicate event never sells twice. This is the most important correctness rule.
Separate the executor and rate-limit it per user and per RPC provider. Trigger storms (a market-wide dump fires thousands of rules at once) are the real load spike, so queue them with priority for protective actions.
Priority fees and Jito bundles for urgent exits, since during a crash everyone is competing for block space.
Backpressure and degraded mode: if RPC or the queue is struggling, protective sells go first and research digests wait.
Start simple: one Node/TS service plus Redis plus Postgres handles thousands of users. Don’t build Kubernetes for the hackathon.
2. Automations without an API
Most of these have no REST API but are still fully readable and executable on-chain, which is better.

Perp positions (e.g. Drift)

Read: the position, collateral, and margin ratio live in on-chain accounts. Use the protocol’s SDK or decode the account with its IDL, and subscribe to that account for changes. Compute your own liquidation distance from the margin math and oracle price.
Act: build the instruction with the SDK (reduce-only close, add collateral, partial close), simulate it, then sign and send. You never need a hosted API.
Same pattern works for lending health factors.
Prediction markets

On-chain markets: read market and position accounts, build buy/sell/redeem instructions from the program’s IDL or SDK.
Off-chain order book markets (Polymarket-style): these usually have a trading API and websocket, which is different from “no API.” Check each venue’s docs, since this varies and I haven’t verified the current options.
Settlement events (market resolved, redeem available) can be caught by account-change subscriptions.
If a venue truly has no API and no usable on-chain interface

Wrap it in your own adapter interface (getPositions, getRisk, close) so the rest of the system doesn’t care how each venue is accessed.
Browser automation is the last resort. It’s fragile, hard to run safely at scale, and a security risk with credentials. For a hackathon, I’d simply not support a venue that needs it.
Design pattern worth adopting
Define a venue adapter for each protocol:

Adapter { watch(account), getRisk(position), buildExitTx(position, params), simulate(tx) }
Jupiter, Drift, and each prediction market become plugins. For the MVP, ship two adapters and show a third as “adding a venue = one file,” which also makes a good roadmap point.

Things to decide next
Custody model: scaling depends on how you sign. Delegated session keys scale cleanly, because the worker signs within limits. Per-user hot wallets mean you’re managing keys at scale, which is a much bigger security burden.
RPC budget: webhooks and gRPC cost money per user. Estimate that early.
I can sketch the data model (rules, positions, triggers, audit tables) and the adapter interface in TypeScript if you’d like a starting scaffold.