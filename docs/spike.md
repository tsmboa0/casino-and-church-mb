# M1 spike: results

Devnet, EU rollup (`MEUGGrYP…`, validator 2.0.4), 25 Nov 2026. Program `55dcwejoNy2ggstgmeCrYPQfKwenYK1wrokuTSyZTSkp`
(throwaway). Code in `spike/`, raw numbers in `spike/results/`. Times are measured from the development machine.

| # | Test | Pass means | Result | |
|---|---|---|---|---|
| 1 | L1 deposit credited on the rollup | Under 5 s, 20 of 20 | 20 of 20, median 0.69 s, worst 2.5 s; repeat syncs credit nothing | **Pass** |
| 2 | Cash-out to SOL in the wallet | Under 30 s, 10 of 10 | 8 of 8 (plus 1 in the smoke test), 1.2 s every time | **Pass** (8, not 10, to stay under the commit cap) |
| 3 | The payout fails | Commit lands; pays once | Commit landed in 2.6 s, nothing paid; three retries paid exactly once | **Pass** |
| 4 | Read a delegated `Player` on L1 | Correct | Owner is the delegation program; data matches | **Pass** |
| 5 | VRF flip with a session key | 95% under 2 s of 200 | 200 of 200; median 0.51 s, p95 0.89 s, worst 1.6 s. The oracle answers in 1 to 2 rollup slots | **Pass** |
| 5b | Authority | All refused | Stranger with a stolen token, stranger without one, and a session-key cash-out: refused | **Pass** |
| 6 | VRF callback compute | Enough | About 264k to 274k available; a simple settle used 7k | **Pass** |
| 7 | Session key with 0 SOL pays rollup fees | Works | Works | **Pass** |
| 8 | Crank for an hour | No gap over 5 s | 1 tick a second. One 77 s gap: **the whole EU rollup stopped** (price feed silent 71 s, every project's cranks too) | **Not met as written**; our crank itself was steady |
| 9 | Who may tick | Crank and keeper only | Strangers refused when due; keeper works; anyone can void a late round. A second, faster Hydra crank ran 1,930 times: moved nothing, 13 due attempts refused | **Pass** |
| 10 | BTC rounds for an hour | 55 or more, none wrong | 59 closed, 0 s late, prices at most 1 s old, every round starts at the last one's close. 2 voided by the outage, as designed | **Pass** |
| 11 | Setup in one transaction | Under 1,232 bytes | 729 bytes with three signers, 1.1 s; on the rollup 0.5 s later | **Pass** |
| 12 | Privy login and signing | Desktop and phone | Desktop, by a person: sign-in, automatic wallet, L1 signing, access token (right issuer and app, 1 hour) and CONTINUE after a refresh all work. Rollup signing hit the 2.0.5 upgrade and needs one retry. No identity token, so we do not depend on it. Login fits 844x390 and 667x375; a real phone is still to do | **Pass on desktop**, retry and phone open |
| 13 | Commit cap | As documented | 10 commits, then refused. Commit-and-undelegate took 1.8 s; redelegating reset the count | **Pass** |
| 14 | Rollup clock | Within 2 s | Indirect: the last tick's rollup time stayed within 2 s (p95) of real time, apart from the outage | **Pass** |

## What we learned

1. **SDK 0.18.0 `#[vrf_callback]` cannot be used.** It derives the identity at runtime and spends the whole budget. Check
   the same scoped identity against a `const` (see `VRF_IDENTITY` in `spike/programs/spike/src/lib.rs`).
2. **A crank must start at the current slot.** `start_slot = 0` fires almost every slot (85 to 90 a second).
3. **Crank intervals are in slots, at about 85 to 95 a second.** 85 slots is about 0.9 to 1 s.
4. **The House PDA can own the crank**, so its address proves who made it; cancelling works at once.
5. **The rollup can stop for over a minute.** Rounds void and refund by themselves; the keeper cannot help, because
   nothing is being processed. The interface needs a "market paused" state.
6. **Upgrades reach the rollup a little after L1.** Pause, upgrade, check the rollup's copy, then resume.
7. **Program upgrades need head-room.** Extending needs a minimum size; allocate extra at first deploy.
8. **The public devnet RPC rate-limits deploys.** `https://rpc.magicblock.app/devnet` works.
9. **Pin every `anchor-*` crate to 1.0.2.** Cargo resolves the helper crates to 1.2.2 and the build fails.
10. **Privy:** its popup crashes without `config.solana.rpcs` for `solana:devnet`; it creates wallets automatically only
    with its own login form; Vite needs `@solana-program/memo`, `system` and `token` installed.

## The rollup was upgraded while we tested

At about 11:38 to 11:46 (WAT) EU refused every connection, and the devnet router answered 521. It came back as **2.0.5**
(`380360a`; it had been 2.0.4). So this was an upgrade, not a crash. The 77 s stall at 11:01 may have been too; unknown.

- **All state survived**, including state that had never been committed to L1: market epoch 66 and 62 closed rounds (L1 had
  0), House 219 settled bets (L1 had 0), and the player's chips. The player could act straight away.
- **Accounts cannot move to another region while theirs is down.** Asia, US and TEE were all up, and it would not have
  helped: our accounts are delegated to EU.
- `spike/tests/uptime.mjs` is recording all four regions (`spike/results/uptime.jsonl`) so the region choice rests on data.

## Decision

Go ahead on EU with the plan as written. Nothing needed a fallback. Test 8's limit should read "no gap over 5 s while the
rollup itself is running".
