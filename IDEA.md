i am thinking of an agent for solana hackathon or near ai hackathon, the goal is a messaging based conversational operation agent, what it does is 1. monitor and guard user tokens , (users lose most times because they sleep and a crypto dump occurs ) 2. schuled research and suggest account action eg trades, swaps or inviest based on what user is interested in and what is tranding (users cant get all info at once agents can ) 3. execute trades on user approval all from chats (be it perp, or prediction etc and monitor them)

This is a strong idea, and the pain point is real. People get liquidated or rugged while asleep, and a chat-native agent that watches for them fits both hackathons. Here’s how I’d shape it.

Name and pitch (placeholder): Moonsta. “Your money copilot that never sleeps, living in your Telegram/WhatsApp.”

The core architecture

1. Guard layer (the strongest demo)

Watches wallet balances, token prices, perp positions (liquidation distance), and pool/liquidity health.
Rules the user sets in plain chat: “If SOL drops 12% in an hour, move half to USDC.” “Alert me if my perp is within 8% of liquidation.”
Two modes: alert only and pre-approved action (user authorizes a bounded action in advance, e.g. “you may sell up to 30% of X if the stop triggers”). This solves the sleeping problem, since waiting for approval at 3am defeats the purpose.
Rug signals: sudden liquidity removal, top-holder dumps, mint authority changes.

2. Research layer

Scheduled jobs (cron) that pull trending tokens, funding rates, news, on-chain flows, and prediction market moves, filtered by the user’s stated interests.
Outputs short digests with a concrete proposal: “SOL/USDC LP yield is 14% vs 9% last week. Want me to move 100 USDC?”
Each suggestion carries its reasoning and risk, with sources.

3. Execution layer

Every action is a proposal with inline Approve / Reject buttons.
Venues: Jupiter (swaps), Drift (perps), prediction markets (e.g. Polymarket-style on Solana), lending/staking.
After execution, the agent registers the position and monitors it automatically (this feeds back into the guard layer).
Safety design (what judges will probe)

Custody is the hard part. Options, ranked:

Session keys / delegated authority with limits (best): the agent can only trade within caps, an allowlist of programs, and an expiry. The user’s main key never leaves them.
Smart wallet with policy (e.g. a Squads-style multisig where the agent is one limited signer).
Agent-held hot wallet with a small funded balance (easiest for a hackathon, weakest story).

Also: a transaction simulation before every action, slippage caps, a daily loss limit, a kill switch (“/pause”), and an audit log the user can read in chat. Treat all fetched web and token data as untrusted input, since prompt injection via token names or news is a real attack on trading agents.

Which hackathon?
Solana: best for a fast, cheap, execution-heavy product. Jupiter, Drift, and Pyth give you the real tooling for prices, swaps, and perps. Low fees make frequent guard actions viable.
NEAR AI: best if you lean into the “agent” angle: verifiable/private inference, NEAR’s chain abstraction and intents for cross-chain swaps, and agent-native infrastructure. A stronger story if you want the agent’s decisions to be trustworthy or private.

My lean: build on Solana for the product, and check whether NEAR’s track rewards the verifiable-agent angle enough to justify the switch. I’d check each hackathon’s current prize tracks and rules before committing, since they change.

Suggested MVP for a hackathon (about a week)
Telegram bot with natural-language rule setting.
Price and liquidation monitoring with alerts.
One pre-approved protective action (auto-swap to stablecoin on a threshold).
One scheduled research digest with an approve-to-swap button.
Demo: simulate a crash live, and show the agent protecting the position while the “user” is asleep. That is your winning moment.

Cut for the MVP: prediction markets, multi-chain, and social features. Add them as the roadmap slide.

Things to decide early
Messaging channel: Telegram is the fastest to build.
LLM’s role: use it for intent parsing and research synthesis, but keep the guard triggers deterministic (plain code, not LLM judgment). Money-moving logic should never depend on a model’s mood.

If you’d like, I can next (a) draft a detailed build plan with a day-by-day schedule, (b) scaffold the project (bot, rules engine, Jupiter swap flow), or (c) research the current Solana and NEAR hackathon tracks and deadlines. Which would help most?