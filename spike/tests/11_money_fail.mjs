import { L1, ER, key, A, ix, send, get, until, purseOf, playerOf, u64, record, sleep } from './lib.mjs';
import { newPlayer, buy, sync, me } from './10_money.mjs';
const admin = key('admin'); const p = await newPlayer(); const acc = { player: playerOf(p.owner.publicKey), purse: purseOf(p.owner.publicKey) };
await buy(p, 20); await until(async () => { await sync(p); return (await me(p)).chips === 20_000_000; }, 20_000);
// T3: the payout action fails; the commit must still land, and a retry must pay exactly once
await send(L1, ix('set_fail', { admin: admin.publicKey }, Buffer.from([1])), [admin], { label: 'set_fail' });
await send(ER, ix('cash_out', { authority: p.owner.publicKey, ...acc }, u64(5)), [p.owner], { label: 'cash_out' });
const landed = await until(async () => (await me(p, L1)).withdrawn === 5_000_000, 90_000, 1000);
await sleep(8000); const q1 = await get(L1, 'Purse', acc.purse);
await send(L1, ix('set_fail', { admin: admin.publicKey }, Buffer.from([0])), [admin], { label: 'unset_fail' });
const b0 = await L1.getBalance(p.owner.publicKey); const settle = () => send(L1, ix('settle_payout', { ...acc, wallet: p.owner.publicKey }), [key('keeper')], { label: 'settle' });
await settle(); await settle(); await settle();
const q2 = await get(L1, 'Purse', acc.purse);
record('t03_failed_action', { commitLandedMs: landed?.ms ?? null, paidWhileFailing: q1.paid_out, paidAfterRetries: q2.paid_out, payouts: q2.payouts, walletGained: (await L1.getBalance(p.owner.publicKey)) - b0, exactlyOnce: q2.paid_out === 5_000_000 && q2.payouts === 1 });
// T13: the commit cap, then leave through commit-and-undelegate and come back
const res = []; for (let i = 0; i < 13; i++) { try { await send(ER, ix('commit_only', { payer: p.owner.publicKey, player: acc.player }), [p.owner], { label: 'commit' }); res.push('ok'); } catch (e) { res.push(e.message.slice(0, 110)); } await sleep(2500); }
let und; try { await send(ER, ix('undelegate_player', { payer: p.owner.publicKey, player: acc.player }), [p.owner], { label: 'undelegate' }); und = await until(async () => { const a = await me(p, L1); return a && a._owner === (await import('./lib.mjs')).PROGRAM.toBase58() ? a : null; }, 60_000, 1000); } catch (e) { und = { error: e.message }; }
let re; try { await send(L1, ix('redelegate', { payer: key('sponsor').publicKey, owner: p.owner.publicKey, player: acc.player }), [key('sponsor')], { label: 'redelegate' }); await sleep(3000); await send(ER, ix('commit_only', { payer: p.owner.publicKey, player: acc.player }), [p.owner], { label: 'commit after' }); re = 'ok'; } catch (e) { re = e.message.slice(0, 160); }
record('t13_commit_cap', { afterOneCashOut: res, undelegatedMs: und?.ms ?? und, redelegateAndCommit: re });
