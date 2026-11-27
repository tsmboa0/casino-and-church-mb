# AGENTS.md: testing The Casino & The Church

A guide for AI agents (Claude Code, Codex, browser agents) and anyone automating a test pass.

- **Live game:** https://casino-and-church-mb.vercel.app (Solana **devnet**, play money)
- **Program:** `6uoz1h2ZWQMgniDx2vKEvh6bHtgCoFoGegfVtNW1q6cX` ([explorer](https://explorer.solana.com/address/6uoz1h2ZWQMgniDx2vKEvh6bHtgCoFoGegfVtNW1q6cX?cluster=devnet)); bets run on the MagicBlock rollup `https://devnet-eu.magicblock.app`
- **API server:** https://server-production-41bf466c.up.railway.app (`/healthz` reports L1, the rollup, the keepers, the BTC market, the AI hosts and any alerts)
- **Machine-readable summary:** https://casino-and-church-mb.vercel.app/llms.txt
- **Overview for judges** (what was built, and where each claim lives in code): [`AGENT_README.md`](AGENT_README.md)

---

## 1. The fastest paths

| You want to | Open |
|---|---|
| Try every panel offline (no account, nothing on chain) | `https://casino-and-church-mb.vercel.app/?demo=1&agent=1` |
| Jump straight to one place in the demo | `.../?demo=1&agent=1&play=roulette` |
| Test the real on-chain game | `.../?agent=1`, then sign in (section 3) |
| Open a place once signed in | add `&play=<place>` (section 2) |

**URL parameters**

- `agent=1`: no tap-to-start screen, no backstory, no guided tours, no music.
- `demo=1`: the offline demo. Same rules, simulated in the browser, with a simulated BTC price.
- `play=<place>`: once in the world, go to that place and open it.

## 2. Moving around without the canvas

The world is a canvas, but **every panel is plain HTML**. You never need to click the canvas:

- **Places button:** the folded-map icon in the top-right HUD, `#btn-places`.
- **Escape** closes any panel. The red **X** (`[data-close]`) does too.
- **The chips pill** (`#hud-chips`) opens "Your chips, LUCK and FAITH", a short explanation of the meters.
- **`window.cnc`:** a small test API in the page:

```js
cnc.state()        // { mode: 'chain'|'mock', signedIn, profile, realm, chips, bonus, luck, faith, testSol, panelOpen, panelTitle }
cnc.places()       // [{ id, kind, label, realm }, ...]  every location
cnc.go('roulette') // go there and open it (true if found)
cnc.close()        // close the open panel
```

**Place ids:** `cashier`, `slots-west`, `slots-east`, `wheel`, `market`, `blackjack`, `roulette`, `coinflip`, `dice`,
`plot-1` to `plot-3`, `monitor`, `npc-owner` (Don Fortuna), `harmony`, `board`, `altar`, `missions`, `candles`,
`offering`, `confessional`, `ledger`, `commission`, `npc-priest` (Father Nakamoto).

**Aliases:** `btc` = `market`, `don` = `npc-owner`, `priest` = `npc-priest`, `desk` = `commission`, `quests` = `missions`.

Panels are `#modal .gm[role=dialog]`, with the title in `.gm-title span`. Results appear in `#res[role=status]`
("YOU WIN!", "YOU LOSE", "BET RETURNED", with **VIEW ON EXPLORER** and **VERIFY THIS BET** on the live game). Toasts
are in `#toasts[role=log]`.

## 3. A real account on devnet (live game)

1. Open `https://casino-and-church-mb.vercel.app/?agent=1` and press **PLAY**.
2. Sign in with **Privy** (email with a one-time code, or a social account). Privy creates a Solana wallet for you.
3. Choose a name and a character. **One signature** sets the account up: the server pays for it, and a session key is created so that nothing asks you to sign again while you play.
4. You are in the world. **30 welcome bonus chips** arrive within a few seconds.

**Chips:** 1 chip = 0.001 SOL (1 SOL = 1,000 chips). Casino bets are 10 chips. For more: **Cashier → GET FREE TEST SOL**
(from our faucet, once a day), then **BUY CHIPS**. **CASH OUT** sends chips back to your wallet as SOL. Bonus chips
(welcome, wheels, quests, alms) are spent first and can't be cashed out, but what they win is real.

A bet settles on the rollup in about a second. Every outcome comes from MagicBlock VRF.

## 4. What to test, place by place

**Casino** (LUCK rises with every real-chip bet; FAITH slowly fades while you stay)

| Place | What to do |
|---|---|
| `cashier` | free test SOL, buy chips, cash out, the leaderboard, MY BETS with explorer links |
| `slots-west`, `slots-east`, `coinflip`, `dice`, `roulette`, `blackjack` | pick a bet, then SPIN / FLIP / ROLL / DEAL; then VERIFY THIS BET |
| `wheel` | Wheel of Fortune, free to spin once LUCK reaches 100 |
| `market` | **BTC Exchange.** PREDICT tab: ENDED, LIVE and NEXT cards; call UP or DOWN on NEXT (1, 2, 5 or 10 chips, pays 1.9×). The price is locked when betting closes and the result comes a minute later. CHART tab: TradingView BTC/USDT. PAST ROUNDS: every round with its proof |
| `monitor` | the House Monitor: vault, limits, Don Fortuna's decisions |
| `npc-owner` | chat with **Don Fortuna** (AI host on NEAR AI Cloud) |
| `plot-1` to `plot-3` | Founders' Row: own a slot machine (needs 100 chips wagered and 5 FAITH) |

**Crossroads** (nothing fades here)

| Place | What to do |
|---|---|
| `harmony` | Harmony Wheel: costs LUCK 50 and FAITH 50 |
| `board` | both AI hosts' decisions, with **VERIFY A REAL DECISION** (the model's signature, the attestation and the hash on Solana, checked in the browser) |

**Church** (FAITH grows; LUCK slowly runs dry)

| Place | What to do |
|---|---|
| `offering` | tithe chips for FAITH; claim alms if you are broke |
| `candles` | light a candle (short cooldown) |
| `altar` | offer LUCK, receive FAITH |
| `missions` | **Quest Board:** a book, one quest per page (swipe, the arrows, or the arrow keys). House quests first, then campaigns. Each page: what each player gets, spots left, time left, the steps, a DO button and CLAIM |
| `commission` | **Commission Desk:** list a campaign with a banner and a live preview. Rewards are locked up front: at least 500 chips (social), 1,000 (project) or 200 (machine), plus 10% to the Church. Runs 1 to 30 days; what isn't won comes back |
| `confessional` | whisper a sin, choose a penance, be absolved for FAITH |
| `ledger` | the treasury and Father Nakamoto's decisions |
| `npc-priest` | chat with **Father Nakamoto** |

**Settings** (gear icon, `#btn-menu`): how to play, the chips guide, the backstory, the two tours, sound, your wallet address, sign out.

## 5. Verify it on chain

- Every result card links to its rollup transaction in the Solana Explorer.
- **VERIFY THIS BET** recomputes the outcome from the VRF output in the browser.
- AI host decisions: `GET /agent/feed`, then `GET /agent/decision/<id>/proof` for the signed model output and `anchorTx`, its hash on Solana.
- BTC rounds: `GET /market/rounds`; each links its settling transaction on the rollup and its hourly page on L1 (`log_rounds`).
- Server health: `GET /healthz` (`alerts` lists anything wrong).

## 6. Run it from a clone

Requirements: Node 22+, pnpm 10. Rust 1.89 and Anchor 1.0.2 only for the program tests.

```bash
pnpm install
pnpm dev                 # http://localhost:5173: the offline demo, ready to play
pnpm test                # shared + server + simulation + program tests, and both typechecks
```

- **Art:** the original art comes from licensed packs that may not be redistributed, so it is not in the repository. `pnpm dev` and `pnpm build` draw **placeholder art** automatically. The real look is on the live site.
- **On-chain mode locally** needs the server's keys (see `DEPLOY.md`). To test the real chain, use the live site.

**Layout:** `apps/client` (Phaser 3 + TypeScript), `apps/server` (Fastify: sponsor, Church oracle, AI hosts, keepers, indexer), `onchain/programs/realm` (Anchor), `packages/realm` (the program's TypeScript client), `packages/shared` (rules, codecs), `packages/sim` (economy simulation and test vectors).

## 7. Good to know

- **Use landscape.** On a phone held upright the game asks you to rotate.
- **Timing:** BTC rounds are one minute; the AI hosts decide every 10 minutes; a campaign claim opens 20 seconds after you open its task.
- **A late BTC price never costs you:** the round is voided and every bet refunded.
- **Devnet only.** Chips have no value.
