// first-time set-up of the program on devnet (safe to run again)
import { addr, b58decode, CHIP, concat, decodeHouse, ix, P, realmIx, u64, u8 } from '../../packages/realm/src/index.ts';
import { BTC_FEED, cli, er, EU, key, l1, send, until } from './lib.ts';
const admin = key('admin'), SOL = 1_000_000_000n;
const need = 7n * SOL, have = await l1.balance(admin.address); if (have < need) { await send(l1, [ix.transfer(cli().address, admin.address, need - have)], [cli()]); console.log('funded admin'); }
if (!(await l1.account(addr.config()))) { const k = (n: string) => b58decode(key(n).address); await send(l1, [realmIx('init', { admin: admin.address }, concat(k('fortuna'), k('nakamoto'), k('oracle'), k('keeper'), b58decode(EU), b58decode(BTC_FEED), u64(10n * CHIP), u64(5n * SOL), u64(5n * SOL), u64(10n * SOL)))], [admin]); console.log('init done'); }
const hp = await l1.account(addr.housePurse()); if (hp && new DataView(hp.data.buffer, hp.data.byteOffset).getBigUint64(8, true) === 0n) { for (const [pool, lamports] of [[0, 5n * SOL], [1, SOL / 4n], [2, SOL / 5n]] as [number, bigint][]) await send(l1, [realmIx('fund_house', { admin: admin.address }, concat(u8(pool), u64(lamports)))], [admin]); console.log('house funded'); }
if ((await l1.account(addr.house()))!.owner !== P.delegation) { await send(l1, [realmIx('delegate_house', { admin: admin.address })], [admin]); console.log('house delegated'); }
const h = await until(async () => { const a = await er.account(addr.house()); return a && decodeHouse(a.data); }); if (h.vault === 0n) await send(er, [ix.syncHouse()], [admin]);
const f = decodeHouse((await er.account(addr.house()))!.data)!; console.log('house on rollup', JSON.stringify(f, (_, v) => (typeof v === 'bigint' ? String(v) : v))); console.log('admin left', Number(await l1.balance(admin.address)) / 1e9);
