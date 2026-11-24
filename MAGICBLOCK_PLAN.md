# The Casino & The Church on Solana, with MagicBlock

Implementation plan for `casino-and-church-mb`. Written 24 Nov 2026.

This repository is a clone of the NEAR version (`casino-and-church`, commit `1dddc4b`). The NEAR version stays live and
untouched. This one becomes a Solana game on MagicBlock Ephemeral Rollups, with Privy for login.

**How to read the claims in this file**

| Mark | Meaning |
|---|---|
| **[V]** | Verified: measured live on devnet, or read in source code, on 24 Nov 2026 |
| **[D]** | Stated in MagicBlock or Privy documentation; not tested by us |
| **[S]** | Assumption that the spike (M1) must prove before we build on it |

---

## Contents

1. [What we are building](#1-what-we-are-building)
2. [Decisions already made](#2-decisions-already-made)
3. [Which MagicBlock feature does what](#3-which-magicblock-feature-does-what)
4. [Architecture](#4-architecture)
5. [Accounts](#5-accounts)
6. [The cashier: buying and cashing out](#6-the-cashier-buying-and-cashing-out)
7. [Login, wallets and session keys](#7-login-wallets-and-session-keys)
8. [Games and VRF](#8-games-and-vrf)
9. [The BTC market and the crank](#9-the-btc-market-and-the-crank)
10. [Church, campaigns, plots and AI hosts](#10-church-campaigns-plots-and-ai-hosts)
11. [Instruction reference](#11-instruction-reference)
12. [The server](#12-the-server)
13. [The client](#13-the-client)
14. [Constants and units](#14-constants-and-units)
15. [Security rules](#15-security-rules)
16. [What can fail, and what happens](#16-what-can-fail-and-what-happens)
17. [Testing](#17-testing)
18. [Costs and funding](#18-costs-and-funding)
19. [Toolchain and versions](#19-toolchain-and-versions)
20. [Repository layout and clean-up](#20-repository-layout-and-clean-up)
21. [Deployment](#21-deployment)
22. [Milestones](#22-milestones)
23. [Risks](#23-risks)
24. [Open questions](#24-open-questions)
25. [Evidence](#25-evidence)

---

## 1. What we are building

The same game: the same world, art, sound, panels, rules, LUCK and FAITH, AI hosts and church. What changes is
everything underneath it.

| | NEAR version | This version |
|---|---|---|
| Contract | near-sdk contract, one state struct | Anchor program, separate accounts |
| Where play happens | NEAR testnet, 5 to 8 s a bet | MagicBlock Ephemeral Rollup, target under 1 s |
| Randomness | Our dealer's commit-reveal | MagicBlock VRF |
| BTC price | OutLayer TEE oracle | Pyth Lazer feed inside the rollup |
| BTC rounds | Start when somebody bets | Run non-stop, moved by a crank |
| Gas | Relayer pays (NEP-366) | Rollup transactions are free; we sponsor account setup |
| Login | Username and password | Email through Privy, then a username |
| Signing a bet | Browser key | Session key, no popup |
| Money | 1 chip = 0.01 NEAR | 1 chip = 0.001 SOL |

**Non-goals for the first release:** mainnet, USDC chips, private gameplay (PER), NFT deeds, mobile app.

---

## 2. Decisions already made

| # | Decision | Why |
|---|---|---|
| D1 | Separate repository; the NEAR one is a read-only remote | The two share little once login and chain code are replaced |
| D2 | SOL chips, 1 chip = 0.001 SOL (1,000,000 lamports) | No token accounts; fees stay small next to a 10-chip bet |
| D3 | Privy email login creates the main wallet | Judges use their own email; agents use Privy's test account |
| D4 | Session keys sign play; the main wallet signs setup, buying, cash-out and session renewal | Popups only where money moves between layers |
| D5 | Cashier uses running totals, not undelegate and redelegate | Cheaper, keeps play uninterrupted, safe to retry |
| D6 | BTC bets live in 8 reusable slots inside `Player` | No L1 account per bet; the bet and the chips always move together |
| D7 | BTC claims are automatic | Free; no claim button |
| D8 | The crank polls every 1 to 2 s and does nothing until a round is due | A strict 60 s crank drifts (section 9.3) |
| D9 | Trust MagicBlock VRF, but keep a refund timeout | A lost callback must never lock a stake |
| D10 | Rollup: devnet EU, `MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e` | Lowest latency measured; cranks firing there; our database is in EU West |
| D11 | Blackjack uses one VRF request per action | One result for the whole deck would expose future cards on chain |
| D12 | PER later, if at all | Our blackjack has no hole card, so nothing needs hiding |
| D13 | Stay on devnet | Real-money play raises gambling-law questions |

### 2.1 Corrections made while writing this plan

Three things said earlier in discussion turned out to be wrong or incomplete.

1. **"Anyone can call the BTC tick" is unsafe.** Betting is closed at the lock, but players in the *closing* round care
   about the exact moment. With a price every 50 ms and a 1 s window, a bettor could call the tick only when the price
   suits them. That edge could wipe out the house's 5%. The tick must be restricted (section 9.4).
2. **"Unclaimed bets refund after a week" is exploitable.** A loser would simply wait a week. An expired slot is a loss
   for the bettor, and three separate mechanisms make reaching expiry practically impossible (section 9.6).
3. **Setup cost is about 0.0125 SOL per player, not 0.007.** The earlier figure left out the session token and `Purse`
   (section 18).

---

## 3. Which MagicBlock feature does what

| Feature | Used for | Not used for |
|---|---|---|
| **Ephemeral Rollup** | All play: bets, tithes, candles, quests, plots, campaigns, BTC bets | Holding SOL |
| **Delegation** | `Player`, `House`, `Market`, `Plots`, `Board` | `Bank`, `Purse`, `Config`, `DecisionLog` |
| **VRF** (`DEFAULT_EPHEMERAL_QUEUE`) | Slots, coin, dice, roulette, wheel, Harmony, blackjack | BTC market |
| **Pyth Lazer oracle** | BTC round prices | The on-screen chart, which stays TradingView |
| **Crank** (Hydra) | Moving BTC rounds | Paying players |
| **Session keys** (V2) | Signing play without popups | Cash-out, buying |
| **Magic Actions** | Triggering the L1 payout after a cash-out commits | Anything that must happen atomically |
| **Commit and undelegate** | Cash-out, hourly checkpoints, rotating a delegation before the 10-commit cap | Buying chips |
| **PER** | Nothing in the first release | |
| **Ephemeral SPL tokens** | Nothing: chips are a ledger, not a token | |
| **Ephemeral accounts** | Nothing: they never reach L1, so they must not hold value | |

---

## 4. Architecture

```
                          BROWSER
        Phaser world + DOM panels (unchanged)
        SolanaBackend (new)  |  Privy island (new, React)
           |          |                    |
   session key     main wallet        email login
   (no popup)      (popup)
           |          |
           v          v
  +----------------------+        +-----------------------------+
  |  EPHEMERAL ROLLUP EU |        |  SOLANA DEVNET (L1)         |
  |  free transactions   |        |  real SOL                   |
  |                      |        |                             |
  |  House   (delegated) | reads  |  Bank         holds the SOL |
  |  Player  (delegated) |<-------|  Purse        deposit totals|
  |  Market  (delegated) |  L1    |  Config       roles, limits |
  |  Plots   (delegated) | copies |  DecisionLog  AI decisions  |
  |  Board x2(delegated) |        |                             |
  |                      | commit |                             |
  |  VRF queue           |------->|  Player (last committed)    |
  |  BTC price feed      | +Magic |     -> settle_payout        |
  |  Hydra crank         | Action |        pays from Bank       |
  +----------------------+        +-----------------------------+
           ^                                   ^
           |                                   |
           +--------------- SERVER ------------+
             sponsor (pays setup)      keeper (tidies up, no authority)
             names, history, SSE       AI hosts (NEAR AI Cloud)
             Church oracle             Postgres
```

### 4.1 Four rules that shape everything

1. **Only delegated accounts can be written on the rollup; every L1 account can be read there.** [D] Reading live was
   tested: two changing L1 accounts matched on EU, Asia and TEE within about one polling step. [V] Those were system
   accounts; our own program account is tested in M1. [S]
2. **An account lives on one rollup at a time.** One transaction cannot write to two. Everything delegates to EU.
3. **A commit is limited to accounts of 10,240 bytes**, and an account gets 10 commits per delegation unless a delegated
   fee payer is set up. [D]
4. **A Magic Action is not atomic with its commit.** If it fails, the commit still lands without it. [D] So nothing may
   depend on an action having run.

### 4.2 What is authoritative, where

| State | Authoritative on | Why |
|---|---|---|
| SOL | L1 `Bank` | Nobody can spend it from the rollup |
| How much a player deposited and was paid | L1 `Purse` | Survives any rollup problem |
| Chips, LUCK, FAITH, bets, rounds | Rollup, then L1 at each commit | Speed |
| Roles, limits, pause for money | L1 `Config` | Must not depend on the rollup |
| Usernames, bet history, chat | Postgres | Convenience; nothing of value |

---

## 5. Accounts

All PDAs of the `realm` program unless stated. Money is `u64` lamports, with `u128` in intermediate multiplication.
Time is `i64` unix seconds. Large accounts use Anchor `zero_copy` (the 4 KB stack frame will not hold them).

### 5.1 L1 only, never delegated

**`Config`** `["config"]`, about 400 B. Read by the rollup.

| Field | Type | Notes |
|---|---|---|
| `version` | u8 | |
| `admin`, `pending_admin` | Pubkey | Two-step transfer |
| `fortuna`, `nakamoto` | Pubkey | The AI hosts' signing keys |
| `church_oracle` | Pubkey | Co-signs campaign approvals and claims |
| `keeper` | Pubkey | May tick the market if the crank is down |
| `er_validator` | Pubkey | The only validator we delegate to |
| `btc_feed` | Pubkey | `71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr` |
| `market_crank` | Pubkey | The exact Hydra crank PDA allowed to tick |
| `deposits_paused`, `payouts_paused` | bool | L1 emergency stops |
| `min_deposit`, `max_deposit` | u64 | Lamports |
| `payout_cap_player_day` | u64 | Per player per UTC day |
| `payout_cap_global_hour` | u64 | Across all players |

**`Bank`** `["bank"]`, about 100 B plus the SOL.

| Field | Type | Notes |
|---|---|---|
| `bump` | u8 | |
| `hour_id`, `paid_this_hour` | u32, u64 | For the global cap |
| `total_deposited`, `total_paid` | u64 | Audit totals |

**`Purse`** `["purse", wallet]`, 120 B. **Never closed.**

| Field | Type | Notes |
|---|---|---|
| `owner` | Pubkey | The player's wallet |
| `deposited` | u64 | Only goes up |
| `paid_out` | u64 | Only goes up |
| `last_deposit_ts` | i64 | |
| `day_id`, `paid_today` | u32, u64 | For the daily cap |
| `bump` | u8 | |

**`HousePurse`** `["house_purse"]`, about 120 B: `deposited_vault`, `deposited_treasury`, `deposited_jackpot`,
`paid_out`. The same idea as `Purse`, for the house's own money.

**`DecisionLog`** `["decisions"]`, about 2.2 KB: `seq`, `chain_head` (sha256 of the previous head and the new decision),
and a ring of the last 64 decision hashes.

### 5.2 Delegated to the rollup

**`House`** `["house"]`, about 2 KB.

| Group | Fields |
|---|---|
| Pools | `vault`, `reserved`, `treasury`, `jackpot`, `machine_total`, `machine_reserved`, `escrow_total`, `chips_outstanding` |
| Bridge | `credited_vault`, `credited_treasury`, `credited_jackpot`, `total_credited`, `total_withdrawn`, `house_withdrawn` |
| Params | The 18 economy parameters from `params.rs` (section 14) |
| Caps | `welcome_paid`, `promo_day`, `promo_spent`, `blessing_day`, `blessing_spent`, `blessing_cap` |
| Hosts | 2 timed events, `last_start`, `events_today`, alms day and spend, top-up day and spend, cooldown stamps, `candle_faith_milli` |
| Other | `paused`, `total_players`, `used_decisions` ring (32 hashes, so one decision acts once) |

**`Player`** `["player", wallet]`, about 1.2 KB. **Never closed** (section 6.5).

| Group | Fields | Bytes |
|---|---|---|
| Identity | `authority`, `name[16]`, `avatar[24]`, `bump` | 73 |
| Money | `chips`, `credited`, `withdrawn` | 24 |
| Meters | `luck_milli`, `faith_milli`, `realm`, `last_update`, `last_realm_change`, `candle_at`, `harmony_at`, `last_alms` | 56 |
| Flags | `welcome_claimed`, `plot_gate`, `tour_flags`, `quests_claimed` | 8 |
| Stats | 7 counters, `wagered`, `tithed`, `converted_milli`, `faith_earned_milli` | 64 |
| Caps | `promo_day`, `promo_today`, `campaign_faith_day`, `campaign_faith_used` | 24 |
| Campaigns | `claimed` bitmap (256 campaigns), plays on 3 plots | 56 |
| Bet | `bet_seq`, one `PendingBet` | 80 |
| Blackjack | one `Hand` | 80 |
| BTC | 8 `BtcSlot` of 32 B | 256 |
| Results | the last 8, 40 B each | 320 |
| Spare | for later fields | 128 |

**`Market`** `["market"]`, about 5.8 KB.

| Field | Size | Notes |
|---|---|---|
| `enabled`, `epoch`, `round_s`, `grace_s`, `payout_bps`, `wagers[8]` | about 64 | |
| `open`, `live` | 2 x 72 | Full detail: times, prices, up and down totals, bet count |
| `rounds` ring | 240 x 12 = 2,880 | Lock price, close price, outcome: 4 hours |
| `archive` | 2,520 | 2 bits per round for 10,080 rounds: one week |

**`Plots`** `["plots"]`, about 700 B: 3 machines (owner, name, skin, bankroll, reserved, plays, earned).

**`Board`** `["board", i]` for i = 0, 1, about 6.5 KB each: 20 campaigns of 320 B.

Each is under 10,240 bytes. A test asserts it, so a later field cannot break commits silently.

### 5.3 Owned by other programs

| Account | Program | Use |
|---|---|---|
| `SessionTokenV2` | `KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5` | One per player session, at most 1 week |
| Delegation record, metadata, buffer | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` | Per delegated account |
| VRF queue `5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc` | `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz` | Randomness requests |
| BTC feed | `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd` | Prices |
| Crank | `eHyd5BU8QffvHi4GnXwxrK4WpS7pM2x9UGKHBWii7mf` | Market tick |

---

## 6. The cashier: buying and cashing out

### 6.1 The idea

The rollup cannot touch the SOL, but it can read L1. Each side keeps totals that only go up, and settles the difference.

- **Buying:** `Purse.deposited` (L1) minus `Player.credited` (rollup) is what is still owed to the player in chips.
- **Cashing out:** `Player.withdrawn` (rollup, then committed) minus `Purse.paid_out` (L1) is what is still owed in SOL.

### 6.2 Worked example

| Step | Where | What happens | Result |
|---|---|---|---|
| Buy 0.05 SOL | L1 | SOL to `Bank` | `deposited` = 0.05 |
| Sync | Rollup | 0.05 − 0 | +50 chips, `credited` = 0.05 |
| Sync again | Rollup | 0.05 − 0.05 | nothing |
| Buy 0.02 SOL, sync | Both | 0.07 − 0.05 | +20 chips, `credited` = 0.07 |
| Cash out 30 chips | Rollup | chips −30, then commit | `withdrawn` = 0.03 |
| Payout | L1 | 0.03 − 0 | 0.03 SOL sent, `paid_out` = 0.03 |
| Payout again | L1 | 0.03 − 0.03 | nothing |

### 6.3 Does syncing happen by itself?

**There are two steps, and only the first is automatic.**

1. **The rollup's copy of `Purse` updates itself.** The validator subscribes to L1 accounts it has loaded and refreshes
   them, reading at "confirmed". [V, source] We run nothing for this.
2. **Turning the difference into chips needs a transaction.** Programs never run on their own. Three things send it, and
   any one is enough:

| Trigger | When | Needed? |
|---|---|---|
| **The client** | Right after the buy confirms, signed by the session key | The normal path |
| **Built into every player action** | Each bet, tithe and so on reads `Purse` and syncs first | The safety net: credit can never be missed |
| **Server keeper** | Sees a deposit not credited after 15 s | Tidiness, for someone who closed the tab |

So **no bot is needed for correctness.** If our server is off, the player's next action credits them. The keeper only
makes balances look right sooner.

A crank cannot do this job: a crank's account list is fixed when it is created, so it cannot include a player who does
not exist yet.

### 6.4 Buying, in detail

```
Browser                    Server                 L1                    Rollup
   |  POST /buy/prepare      |                     |                      |
   |------------------------>| builds buy_chips,   |                      |
   |                         | sponsor = fee payer |                      |
   |<------------------------|                     |                      |
   |  Privy popup: sign      |                     |                      |
   |  send ---------------------------------------->| SOL -> Bank         |
   |                         |                     | deposited += n       |
   |                         |                     |---- copy refreshed ->|
   |  sync_deposit (session key) ----------------------------------------->| +chips
   |<------------------ account update over websocket --------------------|
```

`buy_chips(lamports)` checks: not paused; within the limits; a whole number of chips. The player's wallet signs the
transfer; the sponsor pays the transaction fee.

If `sync_deposit` runs before the rollup's copy has refreshed, it credits 0 and the client retries every second for 20 s.
That is harmless because it only ever credits the difference.

### 6.5 Cashing out, in detail

`cash_out(chips)` runs on the rollup and **must be signed by the main wallet**. A session key is refused.

1. Refuse if a VRF bet or blackjack hand is pending.
2. Sync, settle closed BTC slots, apply decay.
3. `chips -= n`, `withdrawn += n`, and the `House` totals.
4. Schedule a commit of `Player` with a Magic Action that calls `settle_payout`.

`settle_payout(wallet)` runs on L1. **Anyone may call it**, because the amount and destination are fixed:

1. The `Player` address must be the PDA of `["player", wallet]` under our program.
2. Its L1 owner must be the delegation program (delegated) or our program (not delegated).
3. Deserialize; `authority` must equal `wallet` and `Purse.owner`.
4. `due = withdrawn − paid_out`. If 0, return quietly.
5. Apply the per-player and global caps. Pay what fits; the rest waits for a later call.
6. `paid_out += paid` **before** moving lamports.

If the Magic Action fails, MagicBlock commits without it. The client, and the keeper as backup, then call `settle_payout`
directly.

**Commit cap.** A `Player` gets 10 commits per delegation. When 8 are used, `cash_out` uses commit-and-undelegate, and
the client or keeper calls `redelegate_player` (the sponsor pays about 0.003 SOL).

**If the player is undelegated**, `cash_out_l1` does the same thing directly on L1.

### 6.6 Why it cannot double spend

| Attack or accident | What happens |
|---|---|
| Sync sent twice, or twice at once | Both write the same `Player`, so they run in order; the second finds nothing |
| The rollup's copy is old | Credits less now and the rest later. Totals only go up, so never more |
| A fake `Purse` | The address is derived from our program and the wallet; owner and address are both checked |
| Writing `Purse` on the rollup | Impossible: it is never delegated, and no instruction delegates it |
| Payout called twice | `due` is 0 the second time |
| Payout to someone else | The destination is `Purse.owner` |
| The rollup falls back to an older state | `chips` and `credited` are in one account, so they go back together and sync re-credits |
| Cashing out, then the rollup falls back | The payout reads *committed* state, so the deduction is already permanent |
| **Closing and recreating `Player`** | **Would reset `credited` to 0 and credit every deposit again. No instruction closes `Player` or `Purse`, and `open_account` fails if either exists** |
| An L1 fork removes a confirmed deposit | Very unlikely. On mainnet, large deposits would wait for finality |

### 6.7 The house's own money

`fund_house(pool, lamports)` (admin, L1) raises a total in `HousePurse`; `sync_house` (anyone, rollup) credits the
difference to the vault, treasury or jackpot. `house_withdraw` works like a cash-out and is admin only.

### 6.8 Invariants, checked in tests and by the keeper

- **I1 (rollup):** all players' chips + vault + treasury + jackpot + machine bankrolls + campaign escrow
  = `total_credited` − `total_withdrawn`.
- **I2 (L1):** `Bank` lamports − rent ≥ `total_deposited` − `total_paid`.
- **I3 (both):** `total_credited` ≤ `total_deposited`, and `total_paid` ≤ `total_withdrawn`.

The keeper checks these every 5 minutes. A failure pauses payouts and raises an alert.

### 6.9 House and Player can be checkpointed at different times

`Player` commits at cash-out; `House` commits hourly. If the rollup restarted from L1, they could disagree by up to an
hour of play. What a devnet rollup restart actually does is unknown. [S] Mitigations:

- Cash-out commits `House` together with `Player` when the fee-payer path is available.
- Hourly checkpoint of `House`, `Market`, `Plots` and `Board`.
- L1 caps bound the damage.

---

## 7. Login, wallets and session keys

### 7.1 The three keys

| Key | Where | Can do | Popup |
|---|---|---|---|
| **Main wallet** | Privy embedded wallet | Setup, buy, cash out, renew session | Yes |
| **Session key** | Browser, encrypted in IndexedDB | Play only, for up to 1 week | No |
| **Sponsor** | Server | Pays rent and fees for setup and buying | n/a |

A stolen session key can gamble a player's chips. It cannot cash out, buy, or move SOL.

### 7.2 First-time flow

| Step | Screen | What happens |
|---|---|---|
| 1 | Title | **PLAY** |
| 2 | Email | Our own pixel form, using Privy's headless `useLoginWithEmail` [D] |
| 3 | Code | 6 digits; Privy creates the Solana wallet |
| 4 | Username | Unique name, checked with the server |
| 5 | Backstory, character, how to play | Unchanged |
| 6 | Setup | **One popup**: opens the account, delegates it, creates the session |
| 7 | World | The session key claims 30 welcome chips |

Returning on the same device with a live session goes straight to the world. A new device signs in by email and creates a
new session (one popup). An expired session asks for one popup.

### 7.3 The setup transaction

One L1 transaction, built by the server:

1. `open_account`: creates `Purse` and `Player`, delegates `Player` to `Config.er_validator`.
2. Session program `create_session_v2(top_up = false, valid_until = now + 7 days)`.

| Signer | Role |
|---|---|
| Sponsor | Fee payer and rent payer. `SessionTokenV2` has a separate `fee_payer` [V, source] |
| Main wallet | `authority` |
| Session key | Must sign its own session creation [V, source] |

The L1 limit is 1,232 bytes. Three signatures and about 20 accounts are close to it, so the fallback is a v0 transaction
with a lookup table, or two transactions shown as one step. [S]

### 7.4 Why V2 session tokens

Anyone can revoke a V1 token, which would let a stranger end players' sessions. V2 needs the owner's signature. The
official React hooks only make V1 tokens, so we build the V2 instruction ourselves. [D]

Use `Option<Account<SessionTokenV2>>` and `session_auth_or`, so the main wallet always works too. Our program checks the
token's authority, signer, target program and expiry on every session-enabled instruction.

### 7.5 Privy integration

- **A React island.** The game is Phaser and TypeScript, and Privy advises contacting them before using the plain
  JavaScript SDK. [D] We add React only for `src/wallet/`: it mounts `PrivyProvider`, renders nothing visible, and
  exposes a small bridge:

```ts
interface WalletBridge {
  ready(): Promise<void>;
  sendCode(email: string): Promise<void>;
  loginWithCode(code: string): Promise<{ address: string }>;
  address(): string | null;
  signTransaction(tx: Uint8Array, reason: string): Promise<Uint8Array>;   // shows Privy's popup
  accessToken(): Promise<string | null>;
  identityToken(): Promise<string | null>;
  logout(): Promise<void>;
}
```

- **Sign only, never sign-and-send.** We send to L1 or the rollup ourselves, so Privy needs no knowledge of the rollup.
- **Loaded lazily** after the title, so it does not slow the first screen.
- **Headless email form**, so the pixel look and the existing landscape-keyboard handling still work. Judges on phones
  make this matter.

### 7.6 Privy dashboard: what is set, and what to change

App `cmwuvir3900yw0gjg70uacpq8`, read from its public configuration on 24 Nov 2026. [V]

| Setting | Now | Needed |
|---|---|---|
| Email login | On | Keep |
| Wallet popups enforced | On | Keep: we want them |
| SMS, passkey, guest, Google | Off | Keep off |
| Allowed domains | `http://localhost:5173` (set 24 Nov) | Add the Vercel domain before launch |
| External wallet login | Still on for Ethereum, off for Solana | Harmless: the client only offers email. Turn off when convenient |
| Create Solana wallet on login | Off | We turn it on in code: `createOnLogin: 'users-without-wallets'` |
| Test accounts | Owner reports done; not visible publicly | Put the email and code in the README |
| Identity tokens | Owner reports done; not visible publicly | Confirmed by M1 test 12 |
| CAPTCHA | Off | Consider before launch, to protect the sponsor |

The app ID is public by design and belongs in the client. **The app secret must never enter this repository or the
client.** We verify tokens with the app's public key, so the server does not need the secret.

### 7.7 Server authentication

| Request | Proof |
|---|---|
| Setup, buy, faucet, name claim | Privy **access token** (ES256, `iss = privy.io`, `aud` = our app ID, not expired) |
| Which wallet belongs to the user | Privy **identity token** `linked_accounts` |
| Play | None: the transaction is signed by the session key and goes straight to the rollup |

### 7.8 Judges and agents

- **Human judges** use their own email.
- **Agents** use the Privy test account from the README. All agents share one account, so the README says chips may be
  low and offers the faucet and `?demo=1`.
- `?agent=1` keeps working: no splash, backstory or tours. The Privy popup is ordinary DOM, but may be in an iframe, so
  M2 includes a test that a browser agent can get through it. [S]

---

## 8. Games and VRF

### 8.1 The flow of one bet

```
place_bet  (session key, rollup)
   checks, stake -> vault, reserve the maximum payout, save PendingBet{seq}
   CPI: request randomness, callback = settle_bet, args = seq
        |
   VRF oracle computes the proof; the VRF program verifies it
        |
settle_bet (called by the VRF program, rollup)
   is PendingBet.seq == seq?  no -> return Ok, do nothing
   draws -> resolve -> pay -> LUCK -> result ring -> clear PendingBet -> emit event
```

One pending VRF bet per player. The client watches `Player` over a websocket and shows the result when it changes.

### 8.2 Rules for the callback

1. **It never returns an error for a stale bet.** An error could leave the request stuck in the queue and retried.
2. `#[vrf_callback]` on the account struct, with no hand-written `vrf_program_identity`. [D]
3. Match `seq` **and** that a bet is pending. A callback may arrive late, even after we refunded. [D]
4. Accounts are fixed: `player`, `house`, `plots`, all writable.
5. It clears `PendingBet` before paying, so a repeat finds nothing.

`caller_seed` = sha256(player, `bet_seq`, the client's 32 random bytes), so a player cannot choose it alone.

### 8.3 Randomness to results

The paytables do not change. `draws_of(h)` turns 32 bytes into eight `u32`, exactly as on NEAR, with the VRF output in
place of the reveal hash. So the **1,005 existing test vectors** still check slots, coin, dice, roulette, wheel and
Harmony: feed each vector's `h` as the VRF output.

`games.rs` (417 lines) is pure and ports almost unchanged: `u128` yocto becomes `u64` lamports, and strings become
enums.

### 8.4 When the cuts are taken

On NEAR the treasury (0.5%) and jackpot (0.25%) shares are taken when the bet is *placed*. Here they are taken when it
*settles*. The totals are the same, and a refund becomes an exact reversal.

| Moment | Movement |
|---|---|
| Place | player −wager; vault +wager; reserved +hold |
| Settle | reserved −hold; vault −treasury cut −jackpot cut −payout; player +payout; blessing from the treasury |
| Refund | reserved −hold; vault −wager; player +wager |

Machine bets use the machine's bankroll and a 1% protocol fee instead of the vault, as now.

### 8.5 Refund timeout

After **180 s** pending, anyone may call `refund_stale(player)`: the full stake returns and the meters spent on a wheel
are restored. VRF requests can be purged after about 121 s, and a late callback is ignored by rule 3. [D]

There is **no 10% penalty** as on NEAR. There it punished our own dealer for hiding a bad result; here the house cannot
withhold anything.

### 8.6 Can a player cancel after seeing a bad result?

The result and the payout are in the same transaction, so there is nothing to see first. We also block cash-out and
undelegation while a bet is pending, so a player cannot make the callback fail.

### 8.7 Blackjack

Rules stay: single deck, no hole card, dealer stands on all 17s, 3:2 naturals, double on two cards, no split.

| Action | VRF | What the callback draws |
|---|---|---|
| Deal | 1 | Player, dealer, player. A natural finishes here, with a dealer card if the upcard is an ace or ten |
| Hit | 1 | One card. On 21, the dealer plays in the same callback; on a bust it ends |
| Stand | 1 | The dealer draws to 17 |
| Double | 1 | One card, then the dealer |

- Cards come from domain-separated hashes: `sha256(vrf || k)` for k = 0, 1, 2…
- Dealt cards are a 52-bit mask, so every draw is without replacement, whatever the order.
- Nothing about future cards exists on chain, because their randomness has not been requested.
- A hand left idle for 120 s may be stood by anyone (`stand_idle`), which the keeper does.
- A hand with a stuck VRF refunds after 180 s: the original stake and any double.

### 8.8 Speed

VRF on the rollup is advertised under 50 ms, and free. [D] The real figure on EU is a measurement in M1. On 24 Nov the
last VRF activity on EU was 50 minutes old and 8 of the last 40 transactions had errors, while Asia was busy. [V] We do
not know whether those errors were the oracle's or other programs' callbacks.

**If EU fails the spike, Asia is the fallback**, at 368 ms instead of 167 ms from the development machine.

Bets travel from the player's browser to the validator, so **the player's distance matters, not our server's**.

---

## 9. The BTC market and the crank

### 9.1 Rounds

One price does three things at once, exactly as in the NEAR contract:

| Tick at | Closes | Locks | Opens |
|---|---|---|---|
| Start | | | Round 1 |
| Lock of 1 | | Round 1 | Round 2 |
| Lock of 2 | Round 1 | Round 2 | Round 3 |
| Lock of N | Round N−1 | Round N | Round N+1 |

UP if close > lock, DOWN if close < lock, refund on a tie. Prices are compared in cents, the same as the number on
screen. Pays 1.9x. Bets of 1, 2, 5 or 10 chips, one per player per round.

On NEAR an idle market sleeps. Here it runs all the time, because ticks are free.

### 9.2 Price

Read from the feed account in the same instruction. Checks, in order:

1. Address equals `Config.btc_feed` and owner is `PriCems5t…`.
2. Price (i64 at byte 73) is above zero.
3. Publish time (i64 at byte 93) is within 5 s of the rollup clock.
4. Use exponent −8 from the feed list. The account's own exponent field reads +8 and is wrong for this. [V]

The layout was read live: BTC was fresh to about 1 s on all four devnet rollups, within 0.1% of Coinbase. [V]

### 9.3 Why not a 60-second crank

Crank intervals are counted in **slots**, nominally 10 ms. The devnet rollups ran at **79 to 88 slots a second**, not 100.
[V] A nominal 60 s crank would fire about every 68 to 76 s, and one miss would lose a round. A 1 s crank that checks the
clock corrects itself.

### 9.4 Who may call `market_tick`

The first valid call fixes the price, so choosing the moment is worth money. Allowed:

1. **The crank.** The instruction before ours must be Hydra `Trigger` (program `eHyd5…`, discriminator 1) and its first
   account must equal `Config.market_crank`. Checked through the instructions sysvar. [D, pattern from Hydra's README]
2. **The keeper** (`Config.keeper`), a signer, as backup. This matches NEAR, where only the dealer or keeper could
   request a price.
3. **Anyone, but only after the grace period**, and then it can only **void**.

We create the crank directly on Hydra with a payer-bound address (`["crank", payer, seed]`), which proves who created it,
and with the infinite setting Hydra supports (`REMAINING_INFINITE`). [V, source] The older `ScheduleTask` path needs at
least 1 iteration and has no infinite setting. [V, source]

Crank facts that matter:

- Scheduled instructions cannot contain signers, and the account list is fixed. [V, source]
- Creation is accepted before it is scheduled, so confirm that it actually fires. [D]
- Cranks fire only while someone runs a cranker. EU has one, `8hwzNBBP…`, serving at least two programs; whether it will
  serve ours is the first thing M1 checks. [S]
- Mainnet and TEE run validator 1.1.1, where cranks work differently. Moving there means a second tick check. [D]

### 9.5 The tick

```rust
pub fn market_tick(ctx) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    if !market.enabled || house.paused || now < market.open.lock_ts { return Ok(()) }   // most calls end here

    let late = now > market.open.lock_ts + market.grace_s;                              // 20 s
    if late {
        void(live); void(open); open_round(epoch + 1, now);                             // anyone may do this
        return Ok(())
    }
    require!(caller_is_crank()? || caller_is_keeper()?, NotAllowed);
    let Some(price) = fresh_price(feed, now) else { return Ok(()) };                     // try again next second

    close(live, price);      // writes the ring and the archive
    lock(open, price);       // becomes live
    open_round(epoch + 1, now);
    Ok(())
}
```

It touches only `Market`, `House` (read, for `paused`) and the feed, so its cost does not grow with the number of bets.

### 9.6 Bets, slots and claims

`market_bet(epoch, side, wager)` requires the open epoch and `now < lock_ts`, then takes a free slot:

```rust
struct BtcSlot { epoch: u64, wager: u64, seq: u64, payout_bps: u16, blessing_bps: u16, side: u8, state: u8, _pad: [u8; 2] }  // 32 B
```

`market_claim(player)` settles every slot whose round has closed. **Anyone may call it; it only ever pays the bettor.**

| Round outcome | Player | House |
|---|---|---|
| Won | `wager x payout_bps`, plus blessing, plus LUCK | Releases the hold |
| Lost | LUCK | Releases the hold; treasury and jackpot take their share |
| Tie or void | Stake back | Releases the hold |

**Do we need a bot for automatic claims?** Not for players; yes, usefully, for the house.

| Trigger | Covers |
|---|---|
| **Client**, when the round closes | Anyone with the game open |
| **Any player action**, which settles slots first | Anyone who comes back |
| **Server keeper**, a few seconds after each close | Everyone else |

Players never lose a win without the keeper. The house does want it, because **losers have no reason to claim**. Until
someone claims, the vault keeps that money reserved and the church does not get its share. The keeper claims for
everyone. It has no special power: it signs with an ordinary key, pays nothing, and cannot redirect anything. If it
stops, everything still settles later.

**Expiry.** Outcomes are kept for a week. A slot older than that is a loss. It would take the keeper being down for a
week and the player never returning. An alert fires at 1 hour.

### 9.7 Admin

`market_start` opens round 1. `market_config` changes limits. `market_stop` voids open rounds. Crank creation and
cancellation are scripts in `scripts/`.

---

## 10. Church, campaigns, plots and AI hosts

### 10.1 Church

Tithe, offering LUCK, candles, quests, realm changes, tours and profile port one to one from `church.rs` (159 lines):
session-key instructions writing `Player`, and `House` when money moves. The formulas are unchanged. Decay is still
applied lazily from timestamps.

### 10.2 Campaigns

Stored in `Board` accounts created once by the admin, so a new campaign is a free rollup transaction with no new L1
account. 40 slots; closed ones are reused.

| NEAR | Here |
|---|---|
| The Church oracle signs a message; the contract checks ed25519 | The oracle **co-signs the transaction**, so the binding to player and campaign is automatic |
| Claims in a set `"id:who"` | A 256-bit map in `Player` (256 campaigns over the program's life; widen later) |
| Closing refunds the creator at once | The refund is recorded on the campaign and collected with `collect_refund`, because the creator's account may not be in the transaction |
| Machine plays in a map | 3 counters in `Player`, one per plot, tied to the machine's id |

The creator flow: client asks `/campaigns/approve`; the server moderates, builds the transaction, signs as oracle; the
session key signs and sends.

### 10.3 Plots and deeds

`machines.rs` ports directly into `Plots`. The NEAR deed was an NEP-245 token (`mt.rs`, 229 lines) whose owner could be
transferred. Here the owner is a field, with `transfer_deed`. A real NFT deed is a later option.

### 10.4 AI hosts

Don Fortuna and Father Nakamoto keep NEAR AI Cloud. It is only an inference provider, and its signed answers are one of
the game's strongest features. Personas change "on NEAR" to "on Solana".

On NEAR, a decision and its action are one call. Here they span two layers, so we keep the same guarantee another way:

1. `anchor_decision` (L1, host key) writes the decision hash to `DecisionLog` and emits the full proof. Costs about
   5,000 lamports.
2. `host_act(decision_hash, call)` (rollup, host key) requires that hash to be in `DecisionLog`, which the rollup can
   read, and not already in `House.used_decisions`.

**No host action can happen without an anchored, signed decision, and each decision acts once.** About 288 decisions a
day cost about 0.0015 SOL.

All limits stay in the program: step of at most 25%, cooldowns, event lengths, alms eligibility, daily caps.
`policy-check.ts` mirrors them as it does now.

---

## 11. Instruction reference

Signer: **W** main wallet, **S** session key or main wallet, **A** admin, **K** keeper, **H** AI host, **O** Church
oracle, **any** anyone, **VRF** the VRF program.

### 11.1 L1

| Instruction | Signer | Writes | Replaces on NEAR |
|---|---|---|---|
| `init_config`, `set_config`, `accept_admin` | A | Config | `new`, `set_roles` |
| `init_bank`, `init_house`, `init_market`, `init_plots`, `init_board` | A | each | `new` |
| `delegate_shared(kind)` | A | delegates | none |
| `fund_house(pool, lamports)` | A | Bank, HousePurse | `seed_vault`, `seed_treasury`, `seed_jackpot` |
| `open_account` | sponsor + W | Purse, Player | implicit account creation |
| `buy_chips(lamports)` | W | Bank, Purse | `deposit` |
| `settle_payout(wallet)` | any | Bank, Purse | `withdraw`, `on_withdraw` |
| `cash_out_l1(chips)` | W | Player, Bank, Purse | `withdraw` |
| `redelegate_player(wallet)` | any (payer) | delegates Player | none |
| `anchor_decision(proof)` | H | DecisionLog | `record_decision` |
| `pause_money(deposits, payouts)` | A | Config | `pause`, `unpause` |

### 11.2 Rollup: money

| Instruction | Signer | Writes | Replaces |
|---|---|---|---|
| `sync_deposit` | any | Player, House | `deposit` |
| `sync_house` | any | House | seeds |
| `claim_welcome` | S | Player, House | `claim_welcome` |
| `cash_out(chips)` | **W only** | Player, House | `withdraw` |
| `checkpoint` | K or A | commits shared accounts | none |
| `house_withdraw` | A | House | none |
| `grant_promo` | H (Fortuna) | Player, House | `grant_promo` |

### 11.3 Rollup: games

| Instruction | Signer | Writes | Replaces |
|---|---|---|---|
| `place_bet(game, wager, pick, plot, seed)` | S | Player, House, Plots, VRF queue | `place_bet` |
| `settle_bet(seq)` | VRF | Player, House, Plots | `reveal` |
| `bj_deal`, `bj_act(action)` | S | Player, House, VRF queue | `place_bet`, `blackjack_act` |
| `bj_settle(seq)` | VRF | Player, House | `blackjack_show` |
| `bj_stand_idle` | any, after 120 s | Player, VRF queue | `claim_timeout` |
| `refund_stale` | any, after 180 s | Player, House, Plots | `claim_timeout` |

### 11.4 Rollup: BTC market

| Instruction | Signer | Writes | Replaces |
|---|---|---|---|
| `market_start`, `market_config`, `market_stop` | A | Market | `market_configure` |
| `market_tick` | crank or K; any to void | Market | `market_tick`, `on_market_price` |
| `market_bet(epoch, side, wager)` | S | Player, House, Market | `market_bet` |
| `market_claim(player)` | any | Player, House | `market_settle` |

### 11.5 Rollup: church, plots, campaigns, hosts

| Instruction | Signer | Writes |
|---|---|---|
| `set_profile`, `enter_realm`, `complete_tour`, `offer_luck`, `light_candle` | S | Player |
| `tithe`, `claim_quest` | S | Player, House |
| `create_machine`, `fund_machine`, `withdraw_machine`, `transfer_deed` | S (`transfer_deed` W only) | Player, House, Plots |
| `release_plot`, `grant_plot_gate` | A | Player, House, Plots |
| `create_campaign` | S + O | Player, House, Board |
| `claim_campaign` | S + O (machine kind: S) | Player, House, Board |
| `close_campaign`, `collect_refund` | S or A | Player, House, Board |
| `seed_campaign` | A | House, Board |
| `host_act(decision_hash, call)` | H | House, sometimes Player |
| `set_paused` | A | House |

Every player instruction begins with the same `touch()`: sync the deposit, settle closed BTC slots when `Market` is
passed, apply decay.

### 11.6 Dropped

`commit_batch`, `reveal`, `blackjack_show` (VRF replaces them); `on_market_price` and all OutLayer code; the NEP-245
token; `migrate` (Solana upgrades keep accounts; `version` and spare bytes handle layout changes).

---

## 12. The server

### 12.1 File by file

| File | Lines | Action |
|---|---|---|
| `api/app.ts` | 608 | Adapt: remove `/relay`, `/rpc`, `/auth/*`, `/accounts`; add section 12.2 |
| `agent/*` (10 files) | 1,255 | Keep. Change `observe.ts` (reads) and `host.ts` (writes), and NEAR wording in `persona.ts` |
| `db/*` | 569 | Adapt to the new schema |
| `dealer/*` | 279 | **Delete** |
| `relayer/relay.ts` | 109 | **Delete**; its quota ideas move to the sponsor |
| `near/*` | 427 | **Delete**; replaced by `solana/` |
| `market/keeper.ts` | 281 | Rewrite as part of `keeper/` |
| `indexer/*` | 55 | Rewrite: follow program events on both layers |
| `oracle/*` | 5 | Replace: co-sign campaign transactions |
| `config.ts`, `index.ts` | 223 | Rewrite |

New: `solana/` (connections, transaction building, the generated client), `sponsor/`, `keeper/`, `privy/`.

### 12.2 Endpoints

| Endpoint | Does |
|---|---|
| `GET /healthz` | L1 and rollup slots, sponsor balance, crank last fired, VRF last answered, invariants, hosts |
| `POST /account/prepare` | Returns the setup transaction, signed by the sponsor |
| `POST /account/submit` | Checks it is the same transaction, sends it, waits |
| `POST /session/prepare` | Session renewal |
| `POST /buy/prepare` | A sponsored `buy_chips` |
| `POST /faucet` | Test SOL to the player's wallet, once a day |
| `GET /names/check`, `POST /names` | Usernames, with a Privy token |
| `GET /market` | Snapshot for first paint; live updates come from the rollup |
| `GET /events/:wallet` | SSE: results, host decisions |
| `GET /bets`, `/leaderboard`, `/stats/*`, `/agent/*`, `/campaigns/*` | As now |

### 12.3 The sponsor

It spends our SOL, so it is the part most likely to be attacked.

1. **The server builds every transaction it signs.** It never signs bytes from a client. On submit, the message must be
   byte-identical to the one it issued.
2. Only these programs may appear: ours, the session program, System, Compute Budget.
3. It never signs a transfer out of the sponsor, except the faucet, which the server sends itself.
4. A Privy token is required. One setup per Privy user and per wallet.
5. Quotas per IP and per day, plus a total, as now (`accountsTotal` 3,000).
6. Below 1 SOL it stops the faucet first; below 0.3 SOL it stops setup. Both show in `/healthz`.
7. `top_up = false` on sessions, so no SOL goes to session keys. They pay nothing on the rollup. [D]

### 12.4 The keeper

One loop with small, independent, repeatable jobs. **It holds no authority over money.** Every job calls an instruction
anyone may call, except the two marked.

| Job | Every | Does | If it stops |
|---|---|---|---|
| Deposit sweep | 15 s | `sync_deposit` where L1 is ahead | The next player action syncs |
| BTC claims | after each close | `market_claim` for every bettor | Settles later; the vault holds reserves longer |
| Payout sweep | 30 s | `settle_payout` where `withdrawn > paid_out` | The client retries |
| Stale bets | 30 s | `refund_stale`, `bj_stand_idle` | The player can call it |
| Redelegate | 30 s | `redelegate_player` | The client calls it |
| Tick watchdog * | 2 s | `market_tick` if the crank is over 4 s late | The round voids and refunds |
| Checkpoint * | 60 min | Commit the shared accounts | Older fallback state |
| Invariants | 5 min | Check I1, I2, I3; alert and pause payouts | No alert |

\* needs the keeper key.

The crank is primary, and the watchdog only steps in. If the spike shows no public cranker serves us, we run
`hydra-cranker` beside the server.

### 12.5 Database

A new Supabase project, not the NEAR one.

| Table | Key | Notes |
|---|---|---|
| `players` | wallet | `privy_did` unique, username, avatar, created |
| `usernames` | name_key | Same rules as now |
| `bets` | (wallet, seq) | Game, wager, payout, outcome, VRF output, rollup signature |
| `deposits`, `payouts` | L1 signature | Audit |
| `issued_tx` | message hash | What the sponsor signed, for the submit check |
| `quota`, `faucet_grants`, `deny_list` | as now | |
| `host_decisions`, `agent_attestations` | as now | Adds the L1 anchor signature |

Rollup transaction history may not be kept for long, so we store the VRF output and result ourselves. [S]

---

## 13. The client

### 13.1 What stays

The whole world (`world/`, 1,963 lines), panels and styles, sound, rules, controls, tours, the offline demo, and `?demo`,
`?agent`, `?play` and `window.cnc`. Panels talk to the `Backend` interface in `core/backend.ts`, which does not change
shape except for login.

### 13.2 What changes

| File | Action |
|---|---|
| `chain/*` (10 files, 1,415 lines) | Replace with `solana/*` |
| `wallet/*` | New: Privy island and bridge |
| `ui/onboarding.ts` | Login steps: email, code, username; remove password screens |
| `ui/games.ts` | Cashier, BTC footer, settings, explorer links, wording |
| `core/backend.ts` | `signIn`, `signUp` and `checkName` become the Privy flow; `CHIPS_PER_NEAR` becomes `CHIPS_PER_SOL` |
| `core/state.ts`, `core/rules.ts` | Units and wording |
| `chain/verify.ts` | Becomes VRF verification |

**NEAR wording to replace**, by matches per file (NEAR, testnet, nearblocks, OutLayer, NEP-366, commit-reveal): `ui/games.ts`
53, `core/backend.ts` 16, `public/llms.txt` 15, `world/tour.ts` 13, `styles.css` 6, `core/state.ts` 6,
`ui/onboarding.ts` 4, `WorldScene.ts` 3, `ui/aiverify.ts` 3, `layout.ts` 2, `hud.ts` 2, `howto.ts` 2, and 1 each in
`games.css`, `main.ts`, `rules.ts`. Mentions of NEAR AI Cloud stay, because they are true.

### 13.3 `solana/` modules

| Module | Job |
|---|---|
| `connections.ts` | L1 and rollup RPC and websockets, reconnect |
| `client/` | Generated from the program's IDL |
| `session.ts` | Create, store (AES-GCM in IndexedDB), load, expire |
| `solanaBackend.ts` | Implements `Backend` |
| `accounts.ts` | Decode and watch `Player`, `House`, `Market` |
| `cashier.ts` | Buy, sync, cash out, retry payout |
| `errors.ts` | Program errors to the existing player messages |
| `explorer.ts` | L1 and rollup links |

### 13.4 Live data

The client subscribes to `Player`, `House` and `Market` on the rollup. This removes most polling: chips, meters, bet
results and BTC rounds all arrive as account updates. Fall back to polling if the websocket drops.

### 13.5 The bet, on screen

1. Press SPIN. Reels start at once.
2. Send `place_bet`. On failure, stop and explain.
3. `Player` updates with the result; the reels land on it.
4. No result in 5 s: "Waiting for the randomness oracle". After 180 s: "Refunded".

The animation should last at least as long as it does now. A result in 300 ms must not skip the fun.

### 13.6 Cashier screens

| Before | After |
|---|---|
| WALLET TEST NEAR | WALLET TEST SOL |
| 1 NEAR = 100 CHIPS | 1 SOL = 1,000 CHIPS |
| 1 NEAR, 5 NEAR | 0.05 SOL, 0.1 SOL |
| GET FREE TEST NEAR | GET FREE TEST SOL |
| FUND WALLET | Same, with the Solana address |
| Cash out | Same, with progress: "Chips locked in", "Committing to Solana", "Paid" |

Cash-out takes longer than a bet, because it waits for an L1 commit. Show the steps, and let the player close the panel.

### 13.7 Verify panel

1. The VRF output and proof transaction, with a rollup explorer link.
2. Recompute the result from that output with `rules.ts`, as now.
3. Say it plainly: "The house cannot see or choose this number. MagicBlock's oracle proves it on chain."

### 13.8 Phones

The UX bar stands: the whole world always on screen, crisp text, tested on several viewports. New things to test: the
Privy popup in landscape on a small phone, and the code field with the keyboard strip.

---

## 14. Constants and units

| Name | Value | NEAR value |
|---|---|---|
| `CHIP_LAMPORTS` | 1,000,000 (0.001 SOL) | 10^22 yocto (0.01 NEAR) |
| Treasury, jackpot, protocol cut | 50, 25, 100 bps | same |
| `allowed_wagers`, `max_bet_chips` | [10], 10 | same (live values) |
| `luck_per_chip_milli`, per-bet cap | 80, 8,000 | same |
| `decay_per_min_milli`, window | 500, 900 s | same |
| `offer_ratio_bps` | 8,000 | same |
| `candle_cooldown_s`, `harmony_cooldown_s` | 15, 120 | same |
| `harmony_cost_milli` | 20,000 | same |
| `welcome_grant_chips`, total cap | 30, 25,000 | same |
| `blessing_day_cap_bps` | 500 | same |
| `promo_day_cap`, `promo_player_cap` | 1,000, 200 | same |
| `bet_timeout_s` | 180 | 60 blocks |
| `bj_idle_s` | 120 | 60 blocks |
| BTC `round_s`, `grace_s`, `payout_bps`, wagers | 60, 20, 19,000, [1, 2, 5, 10] | 60, 45, same, same |
| BTC price max age | 5 s | 15 s |
| Payout cap per player per day | 5 SOL | none |
| Payout cap, all players, per hour | 10 SOL | none |
| Faucet | 0.05 SOL a day | 0.5 NEAR |

**Vault size and the table limit.** A bet may be at most 1/200 of the free vault, so a 10-chip table needs 2,000 free
chips (2 SOL). One slots bet reserves 1,000 chips (1 SOL). A 5 SOL vault supports a few at once, which is fine when a bet
settles in about a second. This matches NEAR, where the vault holds 5,690 chips.

---

## 15. Security rules

**Money**
1. No instruction closes `Player`, `Purse`, `Bank` or `House`.
2. `Purse` totals only go up. `checked_add` and `checked_sub` everywhere; overflow checks on in release.
3. State changes before lamports move.
4. `settle_payout` takes no amount and no destination from the caller.
5. Caps and `payouts_paused` live on L1, out of the rollup's reach.

**Authority**
6. `cash_out`, `buy_chips` and `transfer_deed` accept only the main wallet.
7. Session tokens: V2 type, our program, right authority and signer, not expired.
8. Delegate only to `Config.er_validator`.
9. Admin is two-step. Upgrade authority moves to a multisig before any mainnet step.

**Randomness and prices**
10. `#[vrf_callback]` everywhere, `seq` check, never an error on stale.
11. Feed address, owner, positive price, freshness, fixed exponent.
12. `market_tick` restricted as in section 9.4.

**Accounts**
13. Every account is checked by seeds or address. No unchecked account is written.
14. Duplicate accounts rejected where two of the same type are passed.
15. `Board` and `Plots` writes check ownership.

**Server**
16. Sponsor rules, section 12.3. Keys only in Railway variables.
17. Separate keys for sponsor, keeper, each host, oracle, admin. None reused from NEAR.
18. CSP allowing only Privy, our RPCs, TradingView and NEAR AI proof hosts.

**Repository**
19. `.env*` stays ignored. No NEAR secrets were copied here. [V]
20. The licensed art is ignored in git and must never be committed. [V]

**Trust we accept, and should say so in the README**
- MagicBlock operates the rollup validator and the VRF oracle. A dishonest operator could commit a false state or
  withhold randomness; caps and refunds limit that.
- Bets are not on Solana L1 until the next commit.

---

## 16. What can fail, and what happens

| Failure | Player sees | Recovery |
|---|---|---|
| VRF answer lost | "Waiting", then "Refunded" | `refund_stale` after 180 s |
| VRF answer late, after refund | Nothing | Ignored by `seq` |
| Crank stops | Nothing for up to 4 s | Keeper ticks |
| Crank and keeper both stop | Round voided, stake back | Anyone can void after 20 s |
| Price feed stale | Round waits, then voids | Next round |
| Payout action dropped | "Paying out" a little longer | Client or keeper calls `settle_payout` |
| Rollup copy of `Purse` late | Chips arrive a few seconds later | Retry, or the next action |
| Session expired | One popup | Renew |
| Session key lost (cleared browser) | One popup | New session |
| Commit cap reached | Nothing | Rotate delegation at 8 |
| Rollup down | Games closed, clear message, demo still works | Wait. Chips are safe at the last commit |
| Rollup restarted | Possible fallback to the last commit | Section 6.9; measured in M1 |
| Our server down | Play continues; no new accounts, names or host chat | Restart |
| Privy down | Existing sessions keep playing; no login or cash-out | Wait |
| Sponsor empty | "The faucet is dry", then no new accounts | Top up; `/healthz` warns first |
| L1 congested | Slow buy and cash-out | Priority fee, retry |
| Solana RPC rate limit | Slow buy | Paid RPC key, server proxy |

A rollup that never comes back is the worst case: delegated accounts need the validator to release them. MagicBlock has
base-layer undelegation requests in its validator configuration; what they guarantee is a question for their team. [S]

---

## 17. Testing

| Layer | Tool | Covers |
|---|---|---|
| Pure rules | `cargo test` | Paytables, the 1,005 vectors, blackjack totals, decay, blessing tiers |
| Program | LiteSVM or MagicSVM 0.3.0 | Every instruction and every refusal, the delegate, commit and VRF paths [D] |
| Money | Property tests | Random deposits, syncs, bets, cash-outs, payouts, replays, rollbacks; I1 to I3 after every step |
| Local stack | `mb-stack --vrf --vrf-er --cranker` (validator 2.0) | End to end without devnet |
| Server | Existing `node:test` suites, adapted | Sponsor refusals, quotas, names, hosts, campaigns |
| Devnet | `scripts/e2e.mjs`, rewritten | A real account through every place |
| Load | `scripts/load.mjs` | 30 players at once: latency, VRF, `House` contention |
| Browser | Manual plus an agent pass | Desktop, small laptop, two phones in landscape |

MagicSVM models the 1.1.1 scheduler, not Hydra, so crank tests need the local stack or devnet. [D]

**Attack tests that must exist:** double sync; sync with another player's `Purse`; payout replay; payout to another
wallet; recreate `Player`; session key cash-out; expired session; V1 session; spoofed VRF callback; duplicate callback;
late callback after refund; tick by a stranger before and after grace; tick with a fake feed; tick with a fake Hydra
crank; claim for another player (allowed, pays them); host action without an anchored decision; the same decision twice;
sponsor asked to sign a modified transaction.

---

## 18. Costs and funding

Devnet SOL is free but the faucets are limited. The CLI wallet held **22.34 devnet SOL** on 24 Nov. [V] Live rent: 5,080
lamports per byte with 128 bytes of overhead. [V]

### 18.1 Per player, once

| Item | Lamports | Comes back? |
|---|---|---|
| `Player` rent (1,184 B) | 6,665,000 | No: never closed |
| `Purse` rent (120 B) | 1,260,000 | No: never closed |
| Delegation deposit | about 3,146,000 | Almost none |
| Session token rent (144 B) | 1,382,000 | Yes, when closed |
| Fees, 3 signatures | about 15,000 | No |
| **Total** | **about 12,470,000 = 0.0125 SOL** | |

### 18.2 Running

| Item | Cost |
|---|---|
| A bet, BTC bet, tithe, claim, sync | Free [D] |
| VRF on the rollup | Free [D] |
| Crank tick | Free [D]. A Hydra tip may be needed on our own crank [S] |
| Cash-out | L1 fee and commit charges from the deposit; every 8 cash-outs, about 0.003 SOL to redelegate |
| Session renewal | About 0.0014 SOL rent, refundable, plus the fee |
| AI decisions | About 0.0015 SOL a day |
| Hourly checkpoint | Up to 0.001 SOL per account per commit after the free ones: about 0.1 SOL a day if all 5 shared accounts commit hourly. Start with `House` hourly and the rest every 6 hours: about 0.04 SOL a day |

### 18.3 Budget for launch

| Item | SOL |
|---|---|
| Program deploy (size about 600 to 700 KB, rent) | 3 to 3.6 |
| Upgrade buffer headroom (refunded each time) | 3.6 |
| Shared accounts: rent and delegation | 0.2 |
| House seed: vault 5, treasury 0.25, jackpot 0.2 | 5.45 |
| Sponsor: about 200 players | 2.5 |
| Faucet: about 80 grants | 4 |
| **Total** | **about 19 to 19.4** |

That fits in 22.3, without much spare. If it gets tight, seed 3 SOL and cut the faucet to 0.03.

---

## 19. Toolchain and versions

| Tool | Use | On this machine |
|---|---|---|
| Solana CLI | 3.1.9 | Installed [V] |
| Rust | 1.89.0 | Installed [V] |
| Anchor | **1.0.2** | 0.29.0 installed: `avm install 1.0.2` |
| `ephemeral-rollups-sdk` (Rust) | **0.18.0 exactly**, features `anchor`, `vrf`, `crank` | |
| `session-keys` (Rust) | 3.1.1, `no-entrypoint` | |
| Node, pnpm | 24, 10 | Installed [V] |
| `@privy-io/react-auth` | 3.52.1 (latest seen) | |
| `@solana/kit` | Privy's peer dependency; pin the version it asks for | |
| `@magicblock-labs/ephemeral-rollups-sdk` (JS) | 0.18.0, to match | |

**Do not use Rust SDK 0.20.0.** Its VRF macro does not compile, and it only reads validator 2.0 commit logs. [D] An
unpinned `cargo add` installs it.

**Validators differ.** Devnet EU, Asia and US report 2.0.4; devnet TEE and all mainnet report 1.1.1. [V] The public docs
still say EU and Asia run 1.1.1. SDK 0.18 supports both. [D]

Install MagicBlock's agent skill for development: `npx skills add https://github.com/magicblock-labs/magicblock-dev-skill`.
Their copy of the facts is more current than the docs site.

---

## 20. Repository layout and clean-up

### 20.1 State now

- Clone of the NEAR repository with history. `pnpm install`, typecheck, 30 of 30 TypeScript tests and the client build all
  pass here. [V] (The NEAR Rust tests were not run in this copy.)
- Remotes `near` (GitHub) and `near-local` (the folder), **push disabled on both**.
- Licensed art copied locally and ignored by git. [V]
- No `.env.local`, so no secrets.

### 20.2 Target layout

```
casino-and-church-mb/
  MAGICBLOCK_PLAN.md
  onchain/                      Anchor workspace
    Anchor.toml
    programs/realm/src/
      lib.rs  state/  instructions/  games/  vrf.rs  session.rs  errors.rs  events.rs
    tests/
  apps/
    client/src/ solana/ wallet/ core/ ui/ world/
    server/src/ solana/ sponsor/ keeper/ privy/ agent/ api/ db/ indexer/
  packages/
    shared/   names, errors, hosts, campaigns, constants, generated client
    sim/      unchanged rules and vectors
  scripts/    deploy, init, seed, crank, e2e, load
  docs/near/  archived NEAR documents
  contracts/  removed once the port is done (M4)
```

### 20.3 Clean-up checklist

- [ ] Move `PLAN.md`, `BACKEND_PLAN.md`, `HANDOFF_QUESTIONS.md` to `docs/near/`
- [ ] Rewrite `AGENTS.md` **early**: coding agents load it automatically and it still describes the NEAR game
- [ ] Rewrite `README.md`, `AGENT_README.md`, `DEPLOY.md`, `public/llms.txt`
- [ ] Replace `.env.example`
- [ ] Rename the package and manifest
- [ ] Replace `.github/workflows/backend.yml` (NEAR contract and wasm size jobs)
- [ ] Delete `contracts/realm` after M4; keep `vectors.json`
- [ ] Delete NEAR scripts: `add-host-keys`, `host-keys`, `admin-call`, `church-setup`, `deploy.sh`, `seed.sh`
- [ ] Remove `borsh.ts` and `codec.ts` from `shared`

### 20.4 Environment variables

| Client (public) | Server (secret unless noted) |
|---|---|
| `VITE_BACKEND=solana` | `SPONSOR_KEY`, `KEEPER_KEY`, `FORTUNA_KEY`, `NAKAMOTO_KEY`, `CHURCH_ORACLE_KEY` |
| `VITE_API_URL` | `DATABASE_URL` (new project) |
| `VITE_PRIVY_APP_ID=cmwuvir3900yw0gjg70uacpq8` | `PRIVY_APP_ID` and `PRIVY_VERIFICATION_KEY` (both public) |
| `VITE_REALM_PROGRAM` | `REALM_PROGRAM`, `L1_RPC_URL`, `ER_RPC_URL` |
| `VITE_L1_RPC`, `VITE_ER_RPC` | `NEARAI_API_KEY`, `NEARAI_MODEL`, `NEARAI_DAILY_TOKEN_CAP` |

The admin key stays on your machine, never on the server.

---

## 21. Deployment

| Piece | Where |
|---|---|
| Program | Solana devnet |
| Client | A new Vercel project |
| Server | A new Railway service, **EU West**, near the rollup and database |
| Database | A new Supabase project, EU West, port 5432 (the single-keeper lock needs session mode) |

**Order for a fresh launch**

1. `anchor build`, then deploy; record the program ID.
2. `init_config`, `init_bank`, `init_house`, `init_market`, `init_plots`, `init_board` x 2.
3. `fund_house` for vault, treasury and jackpot.
4. `delegate_shared` for the 5 shared accounts; confirm with the router's `getDelegationStatus`.
5. `sync_house`; check the pools.
6. `market_start`; create the crank; put its address in `Config`; confirm it fires.
7. Seed the Church's campaigns.
8. Start the server; check `/healthz`.
9. Deploy the client; add its domain in Privy.
10. Run `scripts/e2e.mjs` twice.

**Upgrading.** Programs are cloned by the rollup and updated after an L1 upgrade. [D] Never change the layout of a
delegated account without using its spare bytes and `version`. Pause first, upgrade, check, unpause.

---

## 22. Milestones

Each ends with something that works and can be shown. Do not start one before the previous one's checks pass.

### M0. Project set-up

- [x] Clone, remotes, art, baseline build and tests
- [x] This plan
- [x] GitHub repository: `tsmboa0/casino-and-church-mb-` (private)
- [x] Privy dashboard changes (section 7.6)
- [ ] Anchor 1.0.2; empty `onchain/` workspace that builds
- [ ] `AGENTS.md` rewritten

### M1. The spike: prove the risky parts

A throwaway program on devnet EU. Each line is a yes or no with numbers.

| # | Test | Pass means |
|---|---|---|
| 1 | Our L1 `Purse` changes; a rollup instruction reads the new value | Under 5 s, 20 of 20 |
| 2 | Cash-out: commit, Magic Action, SOL arrives | Under 30 s, 10 of 10 |
| 3 | The same with a payout that fails | Commit lands, retry pays exactly once |
| 4 | Reading a delegated `Player` on L1 after a commit | Correct data and owner |
| 5 | VRF coin flip signed by a session key | 95% under 2 s over 200 flips; any errors explained |
| 6 | VRF callback compute limit | Enough for `settle_bet` with room to spare |
| 7 | Session key with 0 SOL as the fee payer on the rollup | Works |
| 8 | Hydra crank, payer-bound, infinite, 1 s | Runs 1 hour with no gap over 5 s |
| 9 | `market_tick` recognises its crank and rejects a stranger's | Both |
| 10 | BTC rounds for 1 hour | 55 or more closed, none wrong |
| 11 | Setup in one transaction, three signers | Under 1,232 bytes, or the fallback chosen |
| 12 | Privy: email, wallet, sign a transaction, from Vite | Works on desktop and phone |
| 13 | 11 commits on one account | The cap behaves as documented |
| 14 | Rollup clock against real time | Within 2 s for an hour |

**If it fails:** 1 → undelegate and redelegate for buying. 5 → Asia, then TEE. 8 → run our own cranker; if that fails,
the keeper ticks. 11 → two transactions. 12 → Privy's plain SDK after asking them.

Output: `docs/spike.md` with the numbers.

### M2. Money and login

- [ ] `Config`, `Bank`, `Purse`, `House`, `Player`; delegation
- [ ] Buy, sync, cash-out, payout, redelegate, caps, pause
- [ ] Property tests and the money attack tests
- [ ] Sponsor and Privy on the server
- [ ] Privy island, email, code, username, setup, session
- [ ] Cashier panel against devnet

**Check:** a new email becomes a player with 30 chips, buys, cashes out, and receives SOL. An agent does the same with
the test account.

### M3. First game

- [ ] VRF module, `place_bet`, `settle_bet`, `refund_stale`
- [ ] Coin flip end to end with the real panel, verify panel and history

**Check:** 500 flips on devnet, I1 to I3 hold, median under 1.5 s on screen.

### M4. The rest of the casino

- [ ] Slots, dice, roulette, Wheel of Fortune, Harmony
- [ ] Blackjack
- [ ] All 1,005 vectors
- [ ] Remove `contracts/realm`

**Check:** every game playable; simulated return matches `packages/sim`.

### M5. BTC market

- [ ] `Market`, tick, crank, bets, slots, claims, archive
- [ ] Panel on live subscriptions
- [ ] Keeper: claims and watchdog

**Check:** 24 hours non-stop, under 1% voided, no slot unsettled for over a minute.

### M6. Church and plots

- [ ] Tithe, altar, candles, quests, realms, tours, confession, alms
- [ ] Founders' Row; machine slots
- [ ] Campaigns and the oracle co-signing

### M7. AI hosts

- [ ] `anchor_decision`, `host_act`, the server's host loop
- [ ] Verify panel: signed decision and L1 anchor
- [ ] Personas reworded

### M8. Polish and proof

- [ ] NEAR wording gone; explorer links right on both layers
- [ ] Phones and small laptops
- [ ] Load test with 30 players
- [ ] Security pass against section 15; an independent review of the program
- [ ] `/healthz` complete; alerts

### M9. Launch

- [ ] Fresh devnet deployment, section 21
- [ ] README, AGENTS.md, AGENT_README.md, llms.txt, DEPLOY.md
- [ ] Privy test account in the README
- [ ] Two clean e2e runs
- [ ] Vercel and Railway live

### After launch, if wanted

Phantom and Backpack login; the Confessional on PER; NFT deeds; a mainnet study.

---

## 23. Risks

| Risk | Chance | Impact | Plan |
|---|---|---|---|
| VRF unreliable on EU | Medium | High | M1 test 5; Asia fallback |
| No public cranker for us | Medium | Medium | Our own cranker; keeper as backup |
| MagicBlock changes under us (2.0 is days old) | High | Medium | Pin versions; `getVersion` at boot; warn on change |
| Devnet rollup reset | Medium | Medium | Checkpoints; L1 caps; devnet only |
| Privy popup blocks agents or phones | Medium | Medium | M1 test 12; test early in M2 |
| Privy email code slow to arrive for judges | Low | Medium | Clear "check spam" text; `?demo=1` |
| Sponsor drained | Medium | Medium | Section 12.3; CAPTCHA ready |
| Setup transaction too large | Medium | Low | Lookup table or two transactions |
| `House` written by every bet | Low | Medium | Rollup slots are about 10 ms; load test in M8 |
| Devnet SOL runs out | Medium | Low | Section 18.3 |
| Player layout needs a change after launch | Medium | Medium | 128 spare bytes, `version` |

---

## 24. Open questions

| # | Question | Default if unanswered |
|---|---|---|
| Q1 | Deadline or hackathon? | **Answered: none.** Build M0 to M9 in order |
| Q2 | GitHub repository | **Answered:** `https://github.com/tsmboa0/casino-and-church-mb-` (private) |
| Q3 | Privy dashboard changes | **Done 24 Nov**; add the Vercel domain before launch |
| Q4 | Keep NEAR AI Cloud for the hosts? | Yes |
| Q5 | Use the CLI wallet's 22 devnet SOL? | **Answered: yes**, with separate keys funded from it |
| Q6 | Ask MagicBlock: EU VRF, the public cranker, what a rollup restart does, forced undelegation | Their Telegram, linked in the docs |

---

## 25. Evidence

Collected 24 Nov 2026, all read-only.

| Fact | Value | How |
|---|---|---|
| Validator versions | Devnet EU, AS, US: 2.0.4. Devnet TEE and mainnet EU, AS, US, TEE: 1.1.1 | `getVersion` |
| Round trip from the development machine | EU 167, US 226, TEE 303, AS 368 ms | Median of 5, kept-alive connection |
| Slot rate | EU 88, TEE 84, AS 79 per second | Two `getSlot` calls 3 s apart |
| BTC feed | `71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr`, live on 8 rollups, about 1 s old; $59,877 against Coinbase $59,849 | Account read |
| Feed layout | Price at byte 73, exponent at 89 (reads +8), publish time at 93 | Account read |
| Cranks firing | EU and AS within 1 s; US none for 2.6 days; TEE no Hydra | Hydra program signatures |
| EU cranker | `8hwzNBBP…`, at least 2 programs | 40 sampled transactions |
| VRF activity | AS 1 s; TEE 30 s; EU 50 min (8 of 40 errors); US 9 h (33 of 40 errors) | VRF program signatures |
| Rollup copies of L1 accounts | Two changing accounts: 42 of 42 reads each within one poll on EU, AS and TEE. One changing every poll could not be compared | 14 polls each |
| Rollup reads L1 at | "confirmed" | Validator source, `leader.rs` |
| Infinite cranks | Hydra `REMAINING_INFINITE`; `ScheduleTask` needs at least 1 iteration | Source |
| Session V2 | Separate `fee_payer`; session signer must sign; 7 days at most | Source |
| L1 rent | 5,080 lamports per byte, 128 overhead | `getMinimumBalanceForRentExemption` |
| Privy app | Email on; no allowed domains; popups enforced | Public app configuration |
| CLI wallet | 22.34 devnet SOL | `solana balance` |
| Baseline | Typecheck clean; 30 of 30 TypeScript tests; build passes | Run in this repository |

**Sources**

- Fees and commits: https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/fees-and-commit-economics
- Runtime limits: https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/runtime-limits
- Magic Actions: https://docs.magicblock.gg/pages/ephemeral-rollups-ers/magic-actions/troubleshooting
- Cranks: https://docs.magicblock.gg/pages/tools/crank/implementation
- Hydra: https://github.com/magicblock-labs/hydra
- VRF: https://docs.magicblock.gg/pages/verifiable-randomness-functions-vrfs/introduction/security
- Price feeds: https://docs.magicblock.gg/pages/tools/oracle/implementation
- Session keys: https://docs.magicblock.gg/pages/tools/session-keys/security
- Dev skill: https://github.com/magicblock-labs/magicblock-dev-skill
- Validator: https://github.com/magicblock-labs/magicblock-validator
- Examples: https://github.com/magicblock-labs/magicblock-engine-examples
- Privy on Solana: https://docs.privy.io/wallets/using-wallets/solana/sign-a-transaction
- Privy email login: https://docs.privy.io/authentication/user-authentication/login-methods/email
- Privy test accounts: https://docs.privy.io/recipes/using-test-accounts
- Privy identity tokens: https://docs.privy.io/user-management/users/identity-tokens
