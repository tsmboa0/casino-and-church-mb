import crypto from 'node:crypto';
import { L1, ER, key, A, ix, send, get, until, purseOf, playerOf, u32, stats, record, sleep, VRF, decode } from './lib.mjs';
import { newPlayer, buy, sync, me } from './10_money.mjs';
const N = Number(process.env.N ?? 200), admin = key('admin');
const p = await newPlayer(); const acc = { player: playerOf(p.owner.publicKey), purse: purseOf(p.owner.publicKey) };
await buy(p, 80); await until(async () => { await sync(p); return (await me(p)).chips > 0; }, 20_000);
let last = null, waiters = []; ER.onAccountChange(acc.player, (a) => { last = { ...decode('Player', a.data), at: Date.now() }; waiters.forEach((w) => w()); }, 'processed'); await sleep(1500);
const flip = (signer, withToken) => ix('flip', { signer: signer.publicKey, ...acc, ...(withToken ? { session_token: p.token } : {}) }, Buffer.concat([Buffer.from([crypto.randomInt(2)]), crypto.randomBytes(32)]));
const total = [], slots = [], ws = [], errs = {}; let refunds = 0, wins = 0, done = 0;
for (let i = 0; i < N; i++) {
  const seq = ((await me(p)).seq) + 1, t0 = Date.now();
  try { await send(ER, flip(p.session, true), [p.session], { label: 'flip' }); } catch (e) { const k = e.message.replace(/[1-9A-HJ-NP-Za-km-z]{60,}/, '').slice(0, 110); errs[k] = (errs[k] ?? 0) + 1; await sleep(500); continue; }
  const r = await until(async () => { const m = last && last.seq >= seq && last.pending === 0 ? last : await me(p); return m.seq === seq && m.pending === 0 ? m : null; }, 20_000, 60);
  if (!r) { errs.timeout = (errs.timeout ?? 0) + 1; await send(ER, ix('refund', { player: acc.player }), [p.session], { label: 'refund' }).catch(() => {}); refunds++; continue; }
  total.push(Date.now() - t0); slots.push(r.v.settled_slot - r.v.placed_slot); done++;
  if (i % 25 === 24) console.log(i + 1, 'done', done, JSON.stringify(stats(total)), JSON.stringify(errs));
}
const m = await me(p), h = await get(ER, 'House', A.house);
record('t05_vrf', { asked: N, done, errs, refunds, wins: m.wins, ms: stats(total), under2s: total.filter((x) => x < 2000).length / Math.max(1, total.length), slots: stats(slots), stale: h.stale, expectedChipsOk: m.chips === 80_000_000 - m.settled * 1_000_000 + m.wins * 2_000_000 });
// T6: how much compute may the callback use?
const cu = []; const find = async () => { for (const s of (await ER.getSignaturesForAddress(acc.player, { limit: 6 }))) { const t = await ER.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }); if (t?.meta?.logMessages?.some((l) => l.includes('SettleFlip'))) return { cu: t.meta.computeUnitsConsumed, err: t.meta.err, log: t.meta.logMessages.find((l) => /consumed \d+ of/.test(l)) }; } };
for (const burn of [0, 5000, 20000, 60000, 120000]) {
  await send(ER, ix('set_burn', { admin: admin.publicKey }, u32(burn)), [admin], { label: 'burn' }).catch((e) => console.log('burn', e.message.slice(0, 140)));
  const seq = (await me(p)).seq + 1; let ok = null; try { await send(ER, flip(p.session, true), [p.session]); ok = await until(async () => { const x = await me(p); return x.seq === seq && x.pending === 0 ? x : null; }, 12_000, 100); } catch (e) { cu.push({ burn, err: e.message.slice(0, 80) }); continue; }
  cu.push({ burn, settled: !!ok, ...(await find().catch(() => null)) }); if (!ok) await send(ER, ix('refund', { player: acc.player }), [p.session]).catch(() => {});
}
await send(ER, ix('set_burn', { admin: admin.publicKey }, u32(0)), [admin]).catch(() => {});
record('t06_callback_compute', { cu });
// negative: a stranger's key with somebody else's session token, and a stranger with no token
const strange = (await import('./lib.mjs')).Keypair.generate(); const neg = {};
for (const [n, tok] of [['strangerWithToken', true], ['strangerNoToken', false]]) { try { await send(ER, flip(strange, tok), [strange]); neg[n] = 'ACCEPTED (bad)'; } catch (e) { neg[n] = 'refused'; } }
try { await send(ER, ix('cash_out', { authority: p.session.publicKey, ...acc }, Buffer.alloc(8, 1)), [p.session]); neg.sessionCashOut = 'ACCEPTED (bad)'; } catch { neg.sessionCashOut = 'refused'; }
record('t05b_auth', neg); process.exit(0);
