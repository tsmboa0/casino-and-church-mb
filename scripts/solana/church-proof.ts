// A fresh player does the Church's small acts once, for the README's proof table: flips a coin until it has LUCK,
// walks to the Church, lights a candle and offers LUCK at the altar. Prints the signatures. Run sweep.ts afterwards.
import { randomBytes } from 'node:crypto';
import { addr, buildTx, CHIP, compileMessage, decodePlayer, ix } from '../../packages/realm/src/index.ts';
import { cli, er, key, l1, send, sleep, until, testKey as newSigner } from './lib.ts';
const sponsor = key('sponsor'), w = newSigner(), s = newSigner(), P = async () => decodePlayer((await er.account(addr.player(w.address)))!.data)!;
await l1.send(buildTx(compileMessage(sponsor.address, [ix.openAccount(sponsor.address, w.address), ix.delegatePlayer(sponsor.address, w.address), ix.createSession(w.address, s.address, sponsor.address, Math.floor(Date.now() / 1000) + 86400)], await l1.blockhash()), [sponsor, w, s]));
await until(() => P(), 90_000, 800);
const lam = 200n * CHIP; await send(l1, [ix.transfer(cli().address, w.address, lam + 5_000_000n)], [cli()]); await send(l1, [ix.buyChips(w.address, lam)], [w]);
await until(async () => { await send(er, [ix.syncDeposit(w.address)], [s]).catch(() => {}); return (await P()).chips >= lam; }, 90_000, 1000);
await send(er, [ix.enterRealm(w.address, s.address, 1)], [s]).catch(() => {});
for (let k = 0; k < 15 && (await P()).luckMilli < 1_500; k++) { const b = (await P()).betSeq; await send(er, [ix.placeBet(w.address, s.address, 1, 10, k % 2, randomBytes(32))], [s]); await until(async () => { const p = await P(); return p.betSeq > b && !p.pending; }, 60_000, 100); }
await sleep(3500); await send(er, [ix.enterRealm(w.address, s.address, 2)], [s]);
const candle = await send(er, [ix.lightCandle(w.address, s.address)], [s]);
const altar = await send(er, [ix.offerLuck(w.address, s.address, 1_000)], [s]);
console.log(JSON.stringify({ wallet: w.address, LightCandle: candle, OfferLuck: altar, luckLeft: (await P()).luckMilli / 1000 }));
process.exit(0);
