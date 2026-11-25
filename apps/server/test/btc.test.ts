import test from 'node:test'; import assert from 'node:assert/strict';
import { addr, MARKET_HEAD, newSigner, P, REALM, RING } from '@cnc/realm'; import { IDL } from '../../../packages/realm/src/idl.ts';
import { MarketKeeper } from '../src/solana/market.ts'; import { marketRow } from '../src/solana/indexer.ts'; import { FileStore } from '../src/solana/store.ts';
/** a Market account with these header numbers and rounds */
function market(o: { epoch: number; lockTs: number; live?: number; commits?: number; rounds?: [number, number][] }) {
  const d = new Uint8Array(MARKET_HEAD + RING * 28 + 2520), v = new DataView(d.buffer); d.set(IDL.accounts.Market as readonly number[]); const u64 = (at: number, n: number) => v.setBigUint64(at, BigInt(n), true);
  u64(8, o.epoch); u64(16, o.lockTs - 60); u64(24, o.lockTs); u64(64, o.live ?? 0); v.setUint32(132, o.commits ?? 0, true); u64(200, o.lockTs - 1); d[224] = 1; (o.rounds ?? []).forEach(([e, outcome]) => { const at = MARKET_HEAD + (e % RING) * 28; v.setUint32(at, e, true); v.setUint32(at + 12, 1000 + e, true); d[at + 26] = outcome; }); return d;
}
function rig(state: () => Uint8Array, owner: string = P.delegation) {
  const sent: string[] = []; const names = new Map(IDL.instructions.map((i) => [i.d.join(), i.n]));
  const rpc = (kind: 'l1' | 'er') => ({ blockhash: async () => '11111111111111111111111111111111', account: async () => ({ data: state(), owner, lamports: 1 }), call: async (m: string) => (m === 'getAccountInfo' ? { value: { data: [Buffer.from(state().subarray(0, MARKET_HEAD)).toString('base64')] } } : []), send: async (w: Uint8Array) => { for (const [d, n] of names) { const k = d.split(',').map(Number); for (let i = 0; i + 8 <= w.length; i++) if (k.every((b, j) => w[i + j] === b)) { sent.push(`${kind}:${n}`); return 'sig'; } } sent.push(kind); return 'sig'; } }) as any;
  const store = new FileStore(null); let now = 1_000; return { sent, store, at: (n: number) => { now = n; }, k: new MarketKeeper(rpc('l1'), rpc('er'), newSigner(), store, () => now) };
}
test('the keeper prices a round only when the crank is late, and not before', async () => {
  const r = rig(() => market({ epoch: 5, lockTs: 2_000 })); r.at(1_900); await r.k.tick(); r.at(2_003); await r.k.tick(); assert.ok(!r.sent.includes('er:market_tick')); r.at(2_005); await r.k.tick(); assert.equal(r.sent.filter((s) => s === 'er:market_tick').length, 1);
});
test('when a round ends, everybody who was in it is settled, and its result is kept', async () => {
  let m = market({ epoch: 7, lockTs: 2_000, live: 6, rounds: [[5, 1]] }); const r = rig(() => m); r.at(1_950); await r.k.tick(); r.sent.length = 0; const a = newSigner().address, b = newSigner().address;
  await r.store.addCall({ wallet: a, seq: '1', epoch: 6, side: 'up', chips: 1 }); await r.store.addCall({ wallet: b, seq: '1', epoch: 7, side: 'up', chips: 1 });
  m = market({ epoch: 8, lockTs: 2_060, live: 7, rounds: [[5, 1], [6, 2]] }); r.at(2_001); await r.k.tick(); await new Promise((x) => setTimeout(x, 20)); assert.equal(r.sent.filter((s) => s === 'er:market_claim').length, 1, 'round 7 is still running');
  const [x] = await r.store.rounds(null, 1); assert.equal(x.epoch, 6); assert.equal(x.outcome, 'down'); assert.deepEqual([r.k.isOver(6n), r.k.isOver(7n), r.k.isOver(8n)], [true, false, false]);
});
test('a market found on L1 goes back to the rollup', async () => { const r = rig(() => market({ epoch: 5, lockTs: 2_000 }), REALM); assert.equal(await r.k.back(), true); assert.deepEqual(r.sent, ['l1:delegate_market']); const q = rig(() => market({ epoch: 5, lockTs: 2_000 })); assert.equal(await q.k.back(), false); assert.equal(q.sent.length, 0); });
test('finished pages are written to L1 once, unfinished ones never', async () => { const rounds = Array.from({ length: 130 }, (_, i): [number, number] => [i + 1, 1]); const r = rig(() => market({ epoch: 132, lockTs: 2_000, live: 131, rounds })); await r.k.record(); assert.equal(r.sent.filter((s) => s === 'l1:log_rounds').length, 2, 'rounds 1-59 and 60-119; 120-130 is not finished'); await r.k.record(); assert.equal(r.sent.length, 2); assert.equal((await r.store.rounds(null, 5)).length, 0); });
test('a round keeps its link, whichever arrives first', async () => { const s = new FileStore(null), r = { epoch: 9, outcome: 'up', lock: 1, close: 2, closedAt: 3, up: 4, down: 5, bets: 6, page: null }; await s.addRound({ ...r, tx: null }); await s.addRound({ ...r, tx: 'T' }); await s.addRound({ ...r, tx: null }); assert.equal((await s.rounds(null, 1))[0].tx, 'T'); await s.setPage(0, 'L'); assert.equal((await s.rounds(10, 1))[0].page, 'L'); assert.equal((await s.rounds(9, 1)).length, 0); });
test('history text', () => { const e = { wallet: 'w', seq: 4n, epoch: 90n, side: 1, outcome: 1, wager: 1_000_000n, payout: 1_900_000n, blessing: 0n, luckGainMilli: 80, lockC: 5902725, closeC: 5903010 }; assert.equal(marketRow(e, 't', 1).detail, 'UP #90 $59027.25 to $59030.10'); assert.equal(marketRow({ ...e, outcome: 4 }, 't', 1).detail, 'UP #90 VOID'); assert.equal(marketRow(e, 't', 1).payout, 1.9); assert.ok(addr.market()); });
