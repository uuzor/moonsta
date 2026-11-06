# Final submission — copy pack (Encode x Solana, Best Consumer App)

## Description (submission field)

**Moonsta — your Solana money copilot.** A sharp friend who lives in the
market 24/7, inside Telegram where you already are. It does three jobs:
protects what you have, finds what you're missing, and acts when you say go.

**Problem:** retail is always late and always anxious. Dumps and liquidations
strike while you sleep; yields move, tokens run, and news breaks while you're
living your life. Today's options are dashboards that demand vigilance or
trading bots that demand expertise and scary key handoffs. Ordinary holders
stay exposed, miss everything, and hope.

**What it does:** paste your wallet address — that's the whole signup, thirty
seconds, no seed phrase, no extension. **Protect:** arm stop-losses with one
tap; when one triggers at 3am it moves you to safety and texts you the
receipt. **Find:** ask anything — full portfolio reports, per-token risk
scores, quotes across venues — and get briefings with concrete proposals.
**Schedule:** tell it "warn me if SOL drops 12%", "in 1 minute check if my
deposit arrived", or "brief me on my SOL exposure in an hour" — custom
price alerts, reminders, balance checks, and research briefs, all armed from
plain chat and delivered as AI-composed messages with a suggested next step.
**Act:** approve swaps and trades inline; money can never leave to an outside
address without your tap. You set the leash (caps, allowlists); the copilot
flies within it.

**Who it's for:** the Solana mainstream — holders with $500–$50k who want to
grow and protect without living on charts. Not pro traders (they have
terminals), not whales — the millions in between who check prices
compulsively and dread waking up rekt. Free to start, nothing to install,
useful from the first minute.

**How Solana powers it:** live balance/SPL/price reads for every report and
guard tick; Jupiter V2 for quoted, simulated, quote-verified protective swaps;
Drift account reads for perp monitoring; on-chain mint authorities, holder
concentration, and liquidity depth feeding the risk scorer; a policy engine
that allowlists programs and structurally verifies every transaction before it
can send.

**What works:** Telegram bot (onboarding, chat, /pause, audit), Mini App
dashboard (wallet, guards, approvals, schedules), guard engine with
dry-run/live execution, policy + approvals, action schedule (custom price
alerts, one-shot reminders, balance checks, research briefs via a
due-actions job + AI-composed delivery), scheduler, 96-test suite,
deployed on a VPS.

**What's next:** scheduled research digest content, Drift execution,
owner-verified wallets, NEAR Chain Signatures sessions + Intents leg for
cross-chain custody.

## Links checklist

- [ ] Code: public GitHub repo URL (make sure `.env`, keys, `.local/` stay out)
- [ ] Presentation: slide deck link (outline in PITCH_DECK.md)
- [ ] Live demo: https://t.me/Clawbuns_bot (+ Mini App URL once deployed)
- [ ] Demo video: 2–4 min YouTube/Loom (script in DEMO_VIDEO.md)
