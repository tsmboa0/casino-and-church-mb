// The hosts' decision log on L1, and a round trip: anchor on L1, then act on the rollup. Measures how soon the rollup sees it.
import crypto from 'node:crypto'; import { addr, concat, realmIx, u8, u16, u32 } from '../../packages/realm/src/index.ts'; import { er, key, l1, send, sleep } from './lib.ts';
const admin = key('admin'), F = key('fortuna'), N = key('nakamoto');
if (!(await l1.account(addr.decisions()))) { await send(l1, [realmIx('init_decisions', { admin: admin.address })], [admin]); console.log('decision log created', addr.decisions()); }
if (process.argv[2] === 'init') process.exit(0);
const str = (s: string) => { const b = new TextEncoder().encode(s); return concat(u32(b.length), b); };
// HostCall::None, by Father Nakamoto: the cheapest real round trip
const id = crypto.randomBytes(16), resp = new Uint8Array(32), call = new Uint8Array([0]), callBytes = new Uint8Array([0, ...new Uint8Array(12)]);
const hash = crypto.createHash('sha256').update(id).update(Uint8Array.of(1)).update(resp).update(callBytes).digest();
const proof = concat(id, u8(1), str('none'), str(''), str(''), new Uint8Array(65), new Uint8Array(20), new Uint8Array(32), resp);
const act = () => send(er, [realmIx('host_act', { host: N.address }, concat(u8(1), id, resp, call))], [N]);
await send(er, [realmIx('host_act', { host: F.address }, concat(u8(1), id, resp, call))], [F]).then(() => console.log('FAIL: Don acted as the Father'), (e) => console.log('Don as the Father:', e.code));
await act().then(() => console.log('FAIL: acted before anchoring'), (e) => console.log('before anchoring:', e.code));
const t = Date.now(); const sig = await send(l1, [realmIx('anchor_decision', { host: N.address }, concat(u8(1), hash, proof))], [N]); console.log('anchored on L1 in', Date.now() - t, 'ms', sig.slice(0, 12));
for (let i = 0; i < 120; i++) { try { await act(); console.log('acted on the rollup', Date.now() - t, 'ms after anchoring began'); break; } catch (e: any) { if (i % 10 === 0) console.log('  waiting', e.code); await sleep(500); } }
await act().then(() => console.log('FAIL: acted twice'), (e) => console.log('a second time:', e.code)); void u16; process.exit(0);
