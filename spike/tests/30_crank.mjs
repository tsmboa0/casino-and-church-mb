import crypto from 'node:crypto';
import { ER, L1, key, A, ix, send, get, until, pda, HYDRA, record, sleep, u64, Keypair } from './lib.mjs';
const admin = key('admin'), keeper = key('keeper'), stranger = Keypair.generate(); const seed = crypto.createHash('sha256').update(process.env.SEED ?? 'market-1').digest();
const crank = pda(['crank', A.house, seed], HYDRA); const tick = (signer) => ix('market_tick', signer ? { keeper: signer.publicKey } : {});
const M = () => get(ER, 'Market', A.market); const attempt = async (f) => { try { await f(); return 'accepted'; } catch (e) { return /6004|NotAllowed|"Custom":6004/.test(e.message) ? 'refused NotAllowed' : 'refused ' + e.message.slice(0, 90); } };
if (!process.env.SKIP_AUTH) {
  await send(ER, ix('market_start', { admin: admin.publicKey }), [admin], { label: 'start' }); let m = await M(); const out = {};
  out.strangerEarly = await attempt(() => send(ER, tick(), [stranger])); out.earlyChangedNothing = (await M()).epoch === m.epoch;
  console.log('waiting for lock'); while (Date.now() / 1000 < m.open_lock_ts + 3) await sleep(500);
  out.strangerWhenDue = await attempt(() => send(ER, tick(), [stranger])); out.strangerAsKeeper = await attempt(() => send(ER, tick(stranger), [stranger]));
  out.keeperWhenDue = await attempt(() => send(ER, tick(keeper), [keeper])); m = await M(); out.keeperMoved = m.epoch === 2 && m.live_epoch === 1; out.lockPrice = m.live_lock_c / 100;
  console.log('waiting past grace'); while (Date.now() / 1000 < m.open_lock_ts + 23) await sleep(500);
  out.strangerVoidAfterGrace = await attempt(() => send(ER, tick(), [stranger])); const m2 = await M(); out.voided = m2.voided; out.afterVoid = { epoch: m2.epoch, live: m2.live_epoch };
  record('t09_tick_auth', out);
}
await send(L1, ix('set_crank', { admin: admin.publicKey }, crank.toBuffer()), [admin], { label: 'set_crank' }); await sleep(3000);
await send(ER, ix('market_start', { admin: admin.publicKey }), [admin], { label: 'start' });
try { const r = await send(ER, ix('crank_create', { admin: admin.publicKey, crank }, Buffer.concat([seed, u64(process.env.INTERVAL ?? 85), u64(process.env.TIP ?? 0)])), [admin], { label: 'crank_create' }); console.log('crank created', crank.toBase58(), r.sig); } catch (e) { console.log('crank_create', e.message, JSON.stringify(e.logs ?? '').slice(0, 900)); }
const first = await until(async () => { const m = await M(); return m.calls > 0 ? m : null; }, 60_000, 500); record('t08_crank_first', { firedAfterMs: first?.ms ?? null, calls: first?.v.calls ?? 0, crank: crank.toBase58() }); process.exit(0);
