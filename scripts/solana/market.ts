// The BTC market on devnet. Safe to run again: it only does what is missing.
//   market.ts            create, delegate, crank, start
//   market.ts stop       stop (every open bet comes back), cancel the crank
//   market.ts status
import { createHash } from 'node:crypto';
import { addr, b58decode, concat, decodeMarket, P, realmIx, u64 } from '../../packages/realm/src/index.ts';
import { er, key, l1, send, sleep, until } from './lib.ts';
const admin = key('admin'), cmd = process.argv[2] ?? 'up', SEED = createHash('sha256').update(process.env.CRANK_SEED ?? 'cnc-market-1').digest(), crank = addr.marketCrank(SEED), INTERVAL = Number(process.env.INTERVAL ?? 85);
const M = async () => { const a = await er.account(addr.market()); return a && decodeMarket(a.data); };
/** ConfigPatch is 14 optional fields; market_crank is the seventh */
const patch = (i: number, v: Uint8Array) => concat(...Array.from({ length: 14 }, (_, n) => (n === i ? concat(Uint8Array.of(1), v) : Uint8Array.of(0))));
const show = async () => { const m = await M(); console.log(JSON.stringify({ ...m, rounds: m?.rounds.slice(0, 4), n: m?.rounds.length }, (_, v) => (typeof v === 'bigint' ? Number(v) : v))); };
if (cmd === 'stop') {
  await send(er, [realmIx('market_stop', { admin: admin.address })], [admin]).catch((e) => console.log('stop', e.code)); await send(er, [realmIx('market_crank_cancel', { admin: admin.address, crank })], [admin]).then(() => console.log('crank cancelled'), (e) => console.log('cancel', e.code, e.message)); await show(); process.exit(0);
}
if (cmd === 'up') {
  if (!(await l1.account(addr.market()))) { await send(l1, [realmIx('init_market', { admin: admin.address })], [admin]); console.log('market created', addr.market()); }
  if ((await l1.account(addr.market()))!.owner !== P.delegation) { await send(l1, [realmIx('delegate_market', { payer: admin.address })], [admin]); console.log('delegated'); }
  await until(M, 40_000, 500);
  const cfg = (await l1.account(addr.config()))!.data, want = b58decode(crank); const has = (() => { for (let i = 0; i + 32 <= cfg.length; i++) if (want.every((b, k) => cfg[i + k] === b)) return true; return false; })();
  if (!has) { await send(l1, [realmIx('set_config', { admin: admin.address }, patch(6, want))], [admin]); console.log('crank in Config', crank); await sleep(3000); }
  if (!(await M())!.enabled) { await send(er, [realmIx('market_start', { admin: admin.address })], [admin]); console.log('started'); }
  const t0 = (await M())!.crankTicks; await sleep(4000);
  if ((await M())!.crankTicks === t0) { await send(er, [realmIx('market_crank_create', { admin: admin.address, crank }, concat(SEED, u64(INTERVAL)))], [admin]); console.log('crank created'); const t = Date.now(); await until(async () => (await M())!.crankTicks > t0, 60_000, 300); console.log('first tick after', Date.now() - t, 'ms'); }
}
await show();
