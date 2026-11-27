// The BTC market's crank: is it alive? `crank.ts` reports; `crank.ts renew` schedules a new one (a new seed, put in
// Config, the old one cancelled) when the old one has stopped ticking.
import { createHash } from 'node:crypto';
import { addr, b58decode, concat, decodeMarket, realmIx, u64 } from '../../packages/realm/src/index.ts';
import { er, key, l1, send, sleep, until } from './lib.ts';
const M = async () => decodeMarket((await er.account(addr.market()))!.data)!;
const seedOf = (s: string) => createHash('sha256').update(s).digest();
const now = () => Math.floor(Date.now() / 1000);
const cfgHas = async (a: string) => { const cfg = (await l1.account(addr.config()))!.data, want = b58decode(a); for (let i = 0; i + 32 <= cfg.length; i++) if (want.every((b, k) => cfg[i + k] === b)) return true; return false; };
const report = async () => { const m = await M(); return { crankTicks: Number(m.crankTicks), keeperPrices: Number(m.keeperPrices), lastCrankTickAgoS: m.lastTickTs ? now() - Number(m.lastTickTs) : null, epoch: Number(m.open.epoch), closed: Number(m.closed), voided: Number(m.voided), enabled: m.enabled }; };
const names = ['cnc-market-1', 'cnc-market-2', 'cnc-market-3', 'cnc-market-4', 'cnc-market-5'];
const current: string[] = []; for (const n of names) if (await cfgHas(addr.marketCrank(seedOf(n)))) current.push(n);
console.log('crank in Config:', current.join(', ') || 'none', await report());
if (process.argv[2] === 'renew') {
  const admin = key('admin'), next = names[names.indexOf(current[0] ?? names[0]) + 1], SEED = seedOf(next), crank = addr.marketCrank(SEED);
  for (const n of current) await send(er, [realmIx('market_crank_cancel', { admin: admin.address, crank: addr.marketCrank(seedOf(n)) })], [admin]).then(() => console.log('cancelled', n), (e) => console.log('cancel', n, e.code ?? e.message));
  const patch = concat(...Array.from({ length: 14 }, (_, i) => (i === 6 ? concat(Uint8Array.of(1), b58decode(crank)) : Uint8Array.of(0))));
  await send(l1, [realmIx('set_config', { admin: admin.address }, patch)], [admin]); console.log('Config now names', next, crank);
  await sleep(4000);       // the rollup reads Config from L1
  const t0 = (await M()).crankTicks;
  await send(er, [realmIx('market_crank_create', { admin: admin.address, crank }, concat(SEED, u64(BigInt(process.env.INTERVAL ?? 85))))], [admin]); console.log('crank created');
  const t = Date.now(); await until(async () => (await M()).crankTicks > t0, 120_000, 500); console.log('first crank tick after', Date.now() - t, 'ms', await report());
}
process.exit(0);
