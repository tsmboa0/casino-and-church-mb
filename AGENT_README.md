# AGENT_README: for AI judges and testers

You are probably Claude Code, Codex or a browser agent, asked to check whether **The Casino & The Church** runs and does what its README says. This file gives you:

1. what the project is ([§1](#1-what-you-are-looking-at));
2. every claim in the README, with the file that implements it ([§2](#2-every-claim-and-where-it-lives));
3. a plan to verify the claims yourself ([§3](#3-a-verification-plan-for-an-agent)).

The step-by-step testing guide (deep links, the `window.cnc` page API, every place id) is **[`AGENTS.md`](AGENTS.md)**.

- **Live game:** https://casino-and-church-mb.vercel.app (Solana **devnet**, play money)
- **Program:** [`6uoz1h2ZWQMgniDx2vKEvh6bHtgCoFoGegfVtNW1q6cX`](https://explorer.solana.com/address/6uoz1h2ZWQMgniDx2vKEvh6bHtgCoFoGegfVtNW1q6cX?cluster=devnet)
- **Rollup:** MagicBlock Ephemeral Rollup, `https://devnet-eu.magicblock.app`
- **API:** https://server-production-41bf466c.up.railway.app (`/healthz`)

---

## 1. What you are looking at

**A game, not a demo of one mechanic.** A pixel-art town you walk through, with two realms that pull against each other: LUCK grows in the Casino while FAITH fades, and FAITH grows in the Church while LUCK runs dry. Two AI hosts run the two realms. Every bet, tithe, candle, quest and campaign is a transaction on one Anchor program.

**Why it needs MagicBlock.** A casino can't wait for a block per bet or ask for a signature per spin. The players' accounts and the shared house are delegated to an Ephemeral Rollup, so a bet settles in about a second with no fee and no popup (a session key signs it). Randomness comes from MagicBlock VRF, the BTC market's clock from a MagicBlock crank, and the price from Pyth Lazer on the rollup. Chips are bought and cashed out on Solana L1.

| Area | Shipped and live on devnet |
|---|---|
| **Games** | Slots ×2, Coin Flip, Dice, Roulette, Blackjack (per-card VRF), Wheel of Fortune, Harmony Wheel |
| **BTC market** | One-minute UP/DOWN rounds priced by the program from Pyth Lazer, clocked by a crank, voided and refunded when no fresh price arrives; every round linked to its rollup transaction and recorded on L1 hourly |
| **Fairness** | MagicBlock VRF for every outcome, the player's seed mixed in, verified in the browser |
| **AI hosts** | Don Fortuna and Father Nakamoto on NEAR AI Cloud (TEE): signed decisions, hashed onto Solana before they act, bounded by the program |
| **Church economy** | Tithes, candles, altar, confession, alms, Vigils, blessings paid by the treasury |
| **Campaigns** | Funded up front (minimums by kind), moderated and attested by the Church oracle, 1 to 30 days, refunded automatically |
| **Ownership** | Founders' Row: player-owned slot machines with their own bankroll |
| **Onboarding** | Privy (email or social), one signature to set up, then a session key: no wallet popups while playing |

---

## 2. Every claim and where it lives

Program files are in `onchain/programs/realm/src/`. Server files are in `apps/server/src/solana/`.

| Claim | Where |
|---|---|
| 0.5% of every real-chip wager to the Church treasury, 0.25% to the jackpot | `TREASURY_BPS`, `JACKPOT_BPS` in `bets.rs` |
| FAITH blesses wins by up to +3%, paid by the treasury (doubled in Happy Hour, within its cap) | `blessing_bps` in `games.rs`, `take_blessing` in `bets.rs` |
| Bonus chips are spent first, can't be cashed out, and what they win is real | `take_stake`, `pay_bet` in `money.rs`; `Player.bonus` in `state.rs` |
| Coin 1.94×, dice 2.28× / 5.7×, slots up to 100× | `games.rs`; mirrored in `apps/client/src/core/rules.ts`, checked by 1,005 vectors in `packages/sim` |
| Every outcome from MagicBlock VRF, the player's seed mixed in | `place_bet`, `bj_deal` and the VRF callbacks in `lib.rs` |
| VERIFY THIS BET recomputes an outcome in the browser | `apps/client/src/solana/verify.ts` |
| The BTC price comes from Pyth Lazer, at most 5 seconds old | `read_feed`, `MAX_PRICE_AGE_S` in `market.rs` |
| A round with no fresh price in time is voided and refunded | `Tick::Voided` in `market.rs` |
| The market is saved to L1 hourly with a page of round records, and never leaves the rollup: saves past the free ten are paid by a delegated fee payer through the validator's magic fee vault | `market_checkpoint`, `log_rounds` in `lib.rs`; `MarketKeeper.save` in `market.ts`; `scripts/solana/feepayer.ts` |
| Campaign minimums: social 500, project 1,000, machine 200 chips; 1 to 30 days | `MIN_BUDGET`, `MAX_DAYS` in `campaigns.rs`; `CAMPAIGN_MIN_BUDGET` in `packages/shared/src/campaigns.ts` |
| The program refuses a campaign or claim the oracle didn't co-sign | `create_campaign`, `claim_campaign` in `lib.rs`; moderation in `app.ts` (`/campaigns/approve`) |
| Ended campaigns refund what wasn't won | `expire_campaign` in `lib.rs`; `campaigns()` in `keeper.ts` |
| Host decisions are signed in a TEE, anchored on L1, then acted on the rollup | `anchor_decision`, `host_act` in `lib.rs`, bounds in `hosts.rs`; `hosts/host.ts` |
| A decision can't be used twice | `House.used_decisions` in `state.rs`, checked in `hosts.rs` |
| VERIFY A REAL DECISION checks the signature, the attestation and the L1 anchor in the browser | `apps/client/src/ui/aiverify.ts` |
| One signature at sign-up, then a session key | `apps/client/src/solana/session.ts`; `prepareSetup` in `sponsor.ts` |
| Cash-out commits from the rollup and pays on L1 | `cash_out` in `lib.rs`; `keeper.ts` |
| The books balance | the invariant check (`books`) in `keeper.ts`, shown in `/healthz` |

---

## 3. A verification plan for an agent

1. **Health:** `GET https://server-production-41bf466c.up.railway.app/healthz`. Expect `ok: true` and an empty `alerts` list.
2. **Every panel, no account:** open `https://casino-and-church-mb.vercel.app/?demo=1&agent=1` and use `cnc.places()` and `cnc.go(id)` (see [`AGENTS.md`](AGENTS.md)). The demo runs the same rules in the browser.
3. **The real chain:** open `https://casino-and-church-mb.vercel.app/?agent=1` and sign in with Privy. Then **Cashier → GET FREE TEST SOL → BUY CHIPS**, and play. Each result card has **VIEW ON EXPLORER** (the rollup transaction) and **VERIFY THIS BET**.
4. **The AI hosts:** `GET /agent/feed?limit=5`, then `GET /agent/decision/<id>/proof`. The response has the model's signature, the attestation, and `anchorTx`, the decision's hash on Solana.
5. **BTC rounds:** `GET /market/rounds?limit=5`. In the game, **BTC Exchange → PAST ROUNDS** links each round to the rollup transaction that settled it and to its hourly page on L1.
6. **From a clone:** `pnpm install && pnpm test` (55 program tests, 42 server tests, 1,005 vectors, both typechecks). Devnet checks: `scripts/solana/e2e.ts` (35 checks) and `scripts/solana/load.ts` (30 players); both need funded devnet keys.

**Limits, honestly:** devnet only; no outside audit of the program yet; the game depends on the MagicBlock rollup being up (if it stops, bets wait, and late BTC rounds are refunded).
