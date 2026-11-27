// M8 load test: PLAYERS players (default 30) flip coins at the same time, FLIPS each (default 15). Every bet goes through
// the shared House account, so this is where a crowd would hurt. Measures how long a bet takes to settle, counts errors,
// checks every player's chips add up, and that the books balance afterwards. The API is read at the same time.
// Test wallets are saved (testKey); run sweep.ts afterwards to bring the money home.
import { randomBytes } from 'node:crypto';
import { addr, buildTx, CHIP, compileMessage, decodeBank, decodeHouse, decodePlayer, ix, type Signer } from '../../packages/realm/src/index.ts';
import { cli, er, key, l1, send, sleep, until, testKey as newSigner } from './lib.ts';
const N = Number(process.env.PLAYERS ?? 30), FLIPS = Number(process.env.FLIPS ?? 15), API = process.env.API_URL ?? 'http://localhost:8787', sponsor = key('sponsor');
type A = { w: Signer; s: Signer };
const Pl = async (w: string) => decodePlayer((await er.account(addr.player(w)))!.data)!;
const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
async function open(): Promise<A> {
  const w = newSigner(), s = newSigner(), lam = 200n * CHIP;
  await l1.send(buildTx(compileMessage(sponsor.address, [ix.openAccount(sponsor.address, w.address), ix.delegatePlayer(sponsor.address, w.address), ix.createSession(w.address, s.address, sponsor.address, Math.floor(Date.now() / 1000) + 86400)], await l1.blockhash()), [sponsor, w, s]));
  await until(() => Pl(w.address), 90_000, 800);
  await send(l1, [ix.transfer(cli().address, w.address, lam + 5_000_000n)], [cli()]); await send(l1, [ix.buyChips(w.address, lam)], [w]);
  await until(async () => { await send(er, [ix.syncDeposit(w.address)], [s]).catch(() => {}); return (await Pl(w.address)).chips >= lam; }, 90_000, 1000);
  return { w, s };
}
const t0 = Date.now(); const players: A[] = [];
for (let i = 0; i < N; i += 10) { const got = await Promise.allSettled(Array.from({ length: Math.min(10, N - i) }, open)); for (const g of got) if (g.status === 'fulfilled') players.push(g.value); else console.log('open failed:', (g.reason as any)?.code ?? (g.reason as any)?.message); console.log(`${players.length} players ready`); }
console.log(`opened ${players.length} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
const ms: number[] = [], errs: Record<string, number> = {}; let bets = 0, mismatched = 0; const err = (e: any) => { const k = e?.code ?? String(e?.message ?? e).slice(0, 60); errs[k] = (errs[k] ?? 0) + 1; };
// the API under the same crowd: what the panels poll
const api: number[] = []; let apiErr = 0, stop = false;
const poller = (async () => { while (!stop) { await Promise.all(['/floor', '/leaderboard', '/market/crowd', '/agent/feed?limit=5'].map(async (p) => { const t = Date.now(); try { const r = await fetch(API + p); if (!r.ok) apiErr++; api.push(Date.now() - t); } catch { apiErr++; } })); await sleep(250); } })();
const play = async (a: A) => {
  for (let k = 0; k < FLIPS; k++) {
    try {
      const before = await Pl(a.w.address), t = Date.now();
      await send(er, [ix.placeBet(a.w.address, a.s.address, 1, 10, k % 2, randomBytes(32))], [a.s]);
      const p = await until(async () => { const x = await Pl(a.w.address); return x.betSeq > before.betSeq && !x.pending ? x : null; }, 60_000, 80);
      ms.push(Date.now() - t); bets++;
      const r = p.recent.find((z) => z.seq === p.betSeq); if (!r || p.chips !== before.chips - r.wager + r.payout) mismatched++;
    } catch (e) { err(e); }
  }
};
const t1 = Date.now(); await Promise.all(players.map(play)); const secs = (Date.now() - t1) / 1000; stop = true; await poller;
const h = decodeHouse((await er.account(addr.house()))!.data)!, b = (await l1.account(addr.bank()))!, bk = decodeBank(b.data)!;
const owed = h.chipsOutstanding + h.vault + h.treasury + h.jackpot + h.machineTotal + h.escrowTotal, books = owed === h.totalCredited - h.totalWithdrawn && BigInt(b.lamports) >= bk.totalDeposited - bk.totalPaid;
const out = { players: players.length, bets, seconds: Math.round(secs), betsPerSecond: +(bets / secs).toFixed(2), settle_ms: { p50: q(ms, 0.5), p95: q(ms, 0.95), max: Math.max(...ms) }, errors: errs, chipsMismatched: mismatched, booksBalance: books, api_ms: { calls: api.length, p50: q(api, 0.5), p95: q(api, 0.95), errors: apiErr } };
console.log(JSON.stringify(out, null, 1));
const pass = players.length === N && bets >= N * FLIPS * 0.98 && mismatched === 0 && books && q(ms, 0.95) < 10_000;
console.log(pass ? 'LOAD PASSED' : 'LOAD FAILED'); process.exit(pass ? 0 : 1);
