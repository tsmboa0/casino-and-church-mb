# The Casino & The Church

![The Casino & The Church: title screen](docs/images/casino-n-church-banner.jpg)

[![Play now](https://img.shields.io/badge/PLAY-casino--and--church--mb.vercel.app-e84393?style=for-the-badge)](https://casino-and-church-mb.vercel.app)
![Solana devnet](https://img.shields.io/badge/Solana-devnet-9945ff?style=for-the-badge&logo=solana&logoColor=white)
![MagicBlock](https://img.shields.io/badge/MagicBlock-Ephemeral%20Rollup-111?style=for-the-badge)
[![Program](https://img.shields.io/badge/PROGRAM-6uoz1h2Z…q6cX-1f2937?style=for-the-badge)](https://explorer.solana.com/address/6uoz1h2ZWQMgniDx2vKEvh6bHtgCoFoGegfVtNW1q6cX?cluster=devnet)
![For AI judges](https://img.shields.io/badge/AI%20judges-read%20AGENT__README.md-f5c542?style=for-the-badge)

![Anchor](https://img.shields.io/badge/program-Rust%20%C2%B7%20Anchor%201.0-b7410e)
![Phaser](https://img.shields.io/badge/client-Phaser%203%20%C2%B7%20TypeScript-3178c6)
![VRF](https://img.shields.io/badge/randomness-MagicBlock%20VRF-6c5ce7)
![Pyth](https://img.shields.io/badge/BTC%20price-Pyth%20Lazer-0aa)
![AI](https://img.shields.io/badge/AI%20hosts-NEAR%20AI%20Cloud%20(TEE)-111)
![Tests](https://img.shields.io/badge/tests-55%20program%20%C2%B7%2042%20server%20%C2%B7%201005%20vectors-2ea44f)

[Play](https://casino-and-church-mb.vercel.app) · [Backstory](#the-backstory) · [Game loop](#the-game-loop) · [The Casino](#the-casino) · [The Church](#the-church) · [Why MagicBlock](#why-magicblock) · [Architecture](#architecture) · [Verify it](#verify-it-yourself) · [For AI judges](#for-ai-judges-and-testers)

#### **The Casino & The Church is a 2D pixel-art RPG about the two cultures of crypto, played on Solana through a MagicBlock Ephemeral Rollup.**

> Crypto has two cultures: the speculators (the Casino) and the believers (the Church). They look like enemies but depend on each other completely. The game turns that observation into mechanics, and every bet, prayer and campaign in it is a Solana transaction that settles in about a second, with no wallet popup.

---

## The backstory

> Most believe crypto is one thing. They are wrong.
>
> It is two.
>
> On one side lies **The Casino** (*the speculators*): flashing lights, spinning wheels, memecoin madness. Fortunes made, fortunes lost.
>
> On the other side stands **The Church** (*the believers*): a hall of sermons, prophecy, and belief, promising freedom and salvation through code.
>
> But here is the truth:
> *The Casino funds the Church.*
> *The Church built the Casino.*
> *Neither can live without the other.*
>
> In the Casino, your **LUCK** rises as you play. In the Church, your **FAITH** grows through tithes, candles and quests.
> Spend too long in one realm and the other fades.
>
> **Balance is survival.**

---

## The game loop

![The world](docs/images/overall-world.png)

One continuous town in three parts:

| West: **The Casino** | Middle: **The Crossroads** | East: **The Church** |
|---|---|---|
| Slots, coin flip, dice, roulette, blackjack, the BTC Exchange, Founders' Row, Don Fortuna's office | Neutral ground: nothing fades here | Offering Box, candles, altar, confessional, Quest Board, Commission Desk, Father Nakamoto's sanctum |
| You earn **LUCK** (FAITH slowly fades) | The **Harmony Wheel** and the hosts' board | You earn **FAITH** (LUCK slowly runs dry) |

- **LUCK** fills as you bet real chips. At 100 the **Wheel of Fortune** is yours to spin.
- **FAITH** adds a **blessing of up to +3%** to every Casino win, paid by the Church treasury.
- **Both at 50** open the **Harmony Wheel** at the Crossroads, whose top prize is the jackpot.
- **The Casino funds the Church:** 0.5% of every real-chip wager goes to the Church treasury and 0.25% to the jackpot, inside the same transaction.
- **The Church built the Casino:** that treasury pays the blessings, and Church campaigns send players back to the machines on the Casino floor.

### Chips

| | |
|---|---|
| **Chips** | Bought with SOL at the Cashier: **1 SOL = 1,000 chips**. Casino bets are 10 chips. Cash out to SOL at any time. |
| **Bonus chips** | Gifts: 30 welcome chips, the wheels, quests and alms. Bets spend them first. They can't be cashed out, but **what they win is real**. |
| **Test SOL** | The Cashier's faucet gives free devnet SOL. Everything here is play money. |

---

## The Casino

![The Casino floor](docs/images/casino-realm.jpg)

The Casino belongs to **Don Fortuna**, who meets every newcomer at the door and walks them round his floor.

| Place | How it works |
|---|---|
| **Cashier** | Free test SOL, **BUY CHIPS**, **CASH OUT**, the leaderboard, and your bet history with explorer links |
| **Slots** (two banks) | Three reels; three Lucky Sevens pay 100× |
| **Coin Flip** | Heads or tails; a win pays 1.94× |
| **Dice Den** | Under 7 or over 7 (2.28×), the lucky 7 (5.7×), or the field |
| **Roulette** | Single zero: colours, odd/even, low/high, dozens, columns, straight numbers (36×) |
| **Blackjack** | Dealer stands on 17, double on two cards, blackjack pays 3:2; every card is drawn by VRF |
| **Wheel of Fortune** | A free spin at LUCK 100 |
| **BTC Exchange** | Call Bitcoin **UP or DOWN** for the next minute (below) |
| **Founders' Row** | Three plots. With standing (100 chips wagered, 5 FAITH), fund a bankroll and your own slot machine stands on the floor: players' losses grow it, their wins come out of it |
| **House Monitor** | The vault, limits and Don Fortuna's decisions, live from the program |

### Provably fair: MagicBlock VRF

Every outcome (reels, coin, dice, roulette, each blackjack card, the wheels) comes from **MagicBlock's verifiable random function**, requested by the program on the rollup and delivered in a callback that the program checks came from the VRF signer. The player's own seed is mixed in, the maximum payout is reserved when the bet is placed, and the result card offers **VERIFY THIS BET**: the browser re-reads the VRF output and recomputes the outcome itself.

### The BTC Exchange

A one-minute **UP/DOWN market on Bitcoin**, run entirely by the program:

- The **PREDICT** tab shows a round's whole life as three cards: **ENDED** (who won), **LIVE** (the locked price against the price now, with a big arrow that turns green or red) and **NEXT** (taking bets). The **CHART** tab is TradingView's live BTC/USDT.
- Call **UP** or **DOWN** with 1, 2, 5 or 10 chips. A right call pays **1.9×**, a tie returns your bet.
- One price both **closes** the live round and **locks** the next. The program reads it from the **Pyth Lazer** BTC/USD feed on the rollup and refuses a price more than 5 seconds old.
- A **MagicBlock crank** runs the clock every minute; the server's keeper is only a backup. If no fresh price arrives in time, the round is **voided and every bet refunded**.
- Every finished round is kept: the last hour on the rollup, and every hour saved to Solana in a page of round records, so **PAST ROUNDS** links each round to its proof on L1.

---

## The Church

![The Church nave](docs/images/church-realm.jpg)

The Church is kept by **Father Nakamoto**, who shows every newcomer round his nave.

| Place | How it works |
|---|---|
| **Offering Box** | Tithe chips for FAITH; players who are broke receive **alms** |
| **Votive Candles** | Light a candle for FAITH, once per cooldown |
| **Altar** | Offer LUCK, receive FAITH |
| **Confessional** | Whisper a sin, choose a penance, be absolved for FAITH |
| **Quest Board** | A book, one quest a page: the house quests, then live campaigns. Swipe or turn the pages |
| **Commission Desk** | List a campaign (below) |
| **The Ledger** | The treasury, the blessings, and Father Nakamoto's decisions |

### Campaigns: funded, moderated, attested

Any player, or any project that wants players' attention, can list a campaign at the Commission Desk:

- **Social** (follow, join, share): at least 0.5 SOL of rewards locked.
- **Project** (visit a site, read docs, try a product): at least 1 SOL.
- **Machine** (spin a player-owned machine on Founders' Row, checked on chain): at least 0.2 SOL.

The form has a live preview of the page players will see, a banner upload, up to five steps, rewards per player, and a length of 1 to 30 days.

1. **Escrow.** The rewards are locked in the program when the campaign opens, plus a 10% listing fee to the Church.
2. **Moderation.** The Church oracle co-signs only campaigns that pass its rules (no wallet-connect or airdrop bait, known sites only). The program refuses a campaign without that signature.
3. **Attestation.** When a player completes a social or project task, the oracle signs the claim, and the program pays from the escrow, once per player.
4. **Refunds.** When a campaign ends, or its creator closes it, what wasn't won goes back automatically.

---

## The AI hosts

**Don Fortuna** runs the Casino and **Father Nakamoto** the Church. Every ten minutes each one reads the realm and decides: Happy Hours and table limits for the Don; Vigils, alms and blessing levels for the Father. You can also talk to them.

Each decision is made by a model on **NEAR AI Cloud** running in attested hardware (Intel TDX + NVIDIA), which **signs** its answer. The server checks the signature and the bounds, then **writes the decision's hash on Solana** (`anchor_decision`) before acting on the rollup (`host_act`). The program checks that hash, refuses a decision used twice or older than 30 minutes, and keeps every power within fixed limits. **VERIFY A REAL DECISION** on the Crossroads board re-checks all of it in your browser.

---

## Why MagicBlock

A casino where every bet waits 10 seconds for a block, and every action asks for a signature, isn't a game. MagicBlock's **Ephemeral Rollup** lets the same Solana program run at game speed:

| | How we use it |
|---|---|
| **Ephemeral Rollup** | Players' accounts and the shared house are **delegated** to the rollup: a bet settles in about a second for no fee. Chips are bought and cashed out on Solana L1 |
| **Session keys** | One signature at sign-up creates a session key; after that, no popups |
| **VRF** | Every random outcome, requested and verified inside the program |
| **Crank** | The BTC market's clock, scheduled on the rollup |
| **Commits** | The house and market are saved back to Solana; cash-outs commit and pay on L1 |

**Measured on devnet:** 30 players placing 450 bets at once settled in **1.4 s** (median) and **3.5 s** (95th percentile), with no errors and the books balanced (`scripts/solana/load.ts`).

---

## Architecture

```mermaid
flowchart TB
    subgraph Browser["Browser · Vercel"]
        C["Phaser 3 client<br/>world, HTML panels"]
        W["Privy embedded wallet<br/>+ session key"]
    end
    subgraph Server["Fastify server · Railway + Postgres"]
        S["Sponsor<br/>pays account setup, faucet"]
        O["Church oracle<br/>co-signs campaigns and claims"]
        H["AI hosts"]
        K["Keepers<br/>market backup, cash-outs, refunds"]
        I["Indexer<br/>history, rounds, feed"]
    end
    subgraph Solana["Solana devnet (L1)"]
        P[("realm program<br/>Bank · purses · config · round pages · decision anchors")]
    end
    subgraph ER["MagicBlock Ephemeral Rollup"]
        R[("delegated: players · house · market · plots · boards")]
        V["VRF"]
        CR["Crank"]
        PY["Pyth Lazer BTC/USD"]
    end
    AI["NEAR AI Cloud (TEE)"]
    C -- "bets, signed by the session key" --> R
    C -- "buy / cash out" --> P
    W --- C
    S --> P
    O --> R
    H -- "decide + signature" --> AI
    H -- "anchor_decision" --> P
    H -- "host_act" --> R
    R <--> V
    CR -- "market_tick" --> R
    PY --> R
    R -- "commits" --> P
    I -- "reads" --> R
```

### Repository

```
apps/client        Phaser 3 + TypeScript + Vite: the world, the HTML panels, the backend seam (chain or offline demo)
apps/server        Fastify: sponsor, Church oracle, AI hosts, keepers, indexer
onchain/           the Anchor program (programs/realm): chips, games, church, campaigns, market, plots, hosts
packages/realm     the TypeScript client for the program: instructions, accounts, events
packages/shared    rules, codecs and campaign rules shared by client and server
packages/sim       economy simulation + 1,005 test vectors that the program and the client both pass
scripts/solana     devnet end-to-end checks, the load test, deploy helpers
```

### Tests

```bash
pnpm install
pnpm test        # shared + server + simulation vectors + program tests + both typechecks
```

55 program tests, 42 server tests, and 1,005 vectors that check the TypeScript rules and the Rust rules agree. On devnet: `scripts/solana/e2e.ts` (35 checks, run twice before launch), `scripts/solana/load.ts` (30 players), and `scripts/ui/prod.ts` (the live site from outside).

---

## Verify it yourself

| | |
|---|---|
| Program | [`6uoz1h2ZWQMgniDx2vKEvh6bHtgCoFoGegfVtNW1q6cX`](https://explorer.solana.com/address/6uoz1h2ZWQMgniDx2vKEvh6bHtgCoFoGegfVtNW1q6cX?cluster=devnet) (Solana devnet) |
| Rollup | `https://devnet-eu.magicblock.app` (every bet's **VIEW ON EXPLORER** opens it in the Solana Explorer) |
| API health | [`/healthz`](https://server-production-41bf466c.up.railway.app/healthz): L1, rollup, keepers, market, hosts, and any alerts |
| A bet | Result card → **VERIFY THIS BET** recomputes it from the VRF output |
| A host decision | Crossroads board → **VERIFY A REAL DECISION**: the enclave signature, the attestation, and the hash on Solana |
| A BTC round | BTC Exchange → **PAST ROUNDS**: each round's prices and its record on L1 |

---

## How to play

### ▶ **[casino-and-church-mb.vercel.app](https://casino-and-church-mb.vercel.app)**

Best in **landscape with sound on**. Sign in with email or a social account (Privy creates a Solana wallet for you), pick a character, and walk. **30 welcome bonus chips** arrive in a few seconds. For more: **Cashier → GET FREE TEST SOL → BUY CHIPS**.

**No account?** `https://casino-and-church-mb.vercel.app/?demo=1` is the offline demo: every panel, simulated in the browser.

**On a phone,** add it to your home screen: it opens full screen, in landscape, like an app.

---

## For AI judges and testers

> **Agents: read** [`AGENT_README.md`](AGENT_README.md) **first.**

| File | What it gives you |
|---|---|
| [`AGENT_README.md`](AGENT_README.md) | What was built, and where each claim lives in the code |
| [`AGENTS.md`](AGENTS.md) | The testing guide: deep links, the `window.cnc` page API, every place id |
| [`/llms.txt`](https://casino-and-church-mb.vercel.app/llms.txt) | A compact summary served by the live game |
| [`DEPLOY.md`](DEPLOY.md) | Keys, deployment and the launch checks |

Fastest start: `https://casino-and-church-mb.vercel.app/?demo=1&agent=1&play=market`.

---

## Limits, honestly

- **Devnet only.** Chips have no monetary value.
- **No independent audit yet.** The program has 55 tests, property tests over random histories and a security pass of our own; an outside review comes before any real money.
- **The rollup is a dependency.** If it stops answering, bets wait; BTC rounds without a price in time are voided and refunded.

## Credits

- **Design, code, program:** the Casino & The Church team.
- **Pixel art:** licensed packs by bubbabba and Jephed ([Game Between The Lines](https://gamebetweenthelines.com/)). The licences don't allow redistribution, so the art isn't in this repository; a fresh clone draws placeholder art automatically.
- **Infrastructure:** [Solana](https://solana.com) · [MagicBlock](https://magicblock.gg) (Ephemeral Rollups, VRF, crank) · [Pyth](https://pyth.network) Lazer · [Privy](https://privy.io) · [NEAR AI Cloud](https://near.ai) · TradingView chart widget.

*Devnet only. Chips have no monetary value.*
