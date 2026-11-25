// A second, real Hydra crank at a different address calls the same tick. It must count for nothing and move no round.
import crypto from 'node:crypto'; import { ER, A, key, ix, send, get, pda, HYDRA, record, sleep, u64 } from './lib.mjs';
const admin = key('admin'), seed = crypto.createHash('sha256').update('fake-' + Date.now()).digest(), fake = pda(['crank', A.house, seed], HYDRA); const M = () => get(ER, 'Market', A.market);
// much faster than the real one (every ~10 slots) so it reaches nearly every due moment first
await send(ER, ix('crank_create', { admin: admin.publicKey, crank: fake }, Buffer.concat([seed, u64(10), u64(0)])), [admin], { label: 'fake crank' });
const a = await M(), t0 = Date.now(); await sleep(190_000); const b = await M(), dt = (Date.now() - t0) / 1000;
let before, sigs = []; for (let i = 0; i < 3; i++) { const s = await ER.getSignaturesForAddress(fake, { limit: 1000, before }); if (!s.length) break; sigs.push(...s); before = s.at(-1).signature; }
const ok = sigs.filter((s) => !s.err).length, bad = sigs.filter((s) => s.err); const codes = {}; bad.forEach((s) => { const k = JSON.stringify(s.err); codes[k] = (codes[k] ?? 0) + 1; });
await send(ER, ix('crank_cancel', { admin: admin.publicKey, crank: fake }), [admin], { label: 'cancel fake' });
record('t09b_fake_crank', { seconds: Math.round(dt), realCallsPerS: +((b.calls - a.calls) / dt).toFixed(2), roundsMoved: b.epoch - a.epoch, byCrankMoved: b.by_crank - a.by_crank, byKeeperMoved: b.by_keeper - a.by_keeper, voidedMoved: b.voided - a.voided, fakeTicksHarmless: ok, fakeTicksRefused: bad.length, codes }); process.exit(0);
