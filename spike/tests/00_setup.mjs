import fs from 'node:fs'; import os from 'node:os';
import { L1, ER, key, Keypair, SystemProgram, A, ix, send, get, FEED, VALIDATOR, PROGRAM, PK, until, REGION } from './lib.mjs';
const cli = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(os.homedir() + '/.config/solana/id.json'))));
const admin = key('admin'), keeper = key('keeper'), sponsor = key('sponsor');
const want = [[admin, 0.6], [sponsor, 0.8], [keeper, 0.05]];
for (const [k, sol] of want) { const have = await L1.getBalance(k.publicKey); const need = Math.round(sol * 1e9) - have; if (need > 0) console.log('fund', k.publicKey.toBase58().slice(0, 6), sol, (await send(L1, SystemProgram.transfer({ fromPubkey: cli.publicKey, toPubkey: k.publicKey, lamports: need }), [cli])).sig.slice(0, 12)); }
if (!(await L1.getAccountInfo(A.config))) console.log('init', (await send(L1, ix('init', { admin: admin.publicKey }, Buffer.concat([keeper.publicKey.toBuffer(), FEED.toBuffer(), PK(VALIDATOR).toBuffer()])), [admin], { label: 'init' })).sig);
// the House sponsors the crank on the rollup: give it lamports before delegating
const h = await L1.getAccountInfo(A.house);
if (h.owner.equals(PROGRAM)) {
  await send(L1, SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: A.house, lamports: 5_000_000 }), [admin], { label: 'house lamports' });
  for (const n of ['house', 'market']) console.log('delegate', n, (await send(L1, ix('delegate_' + n, { admin: admin.publicKey }), [admin], { label: 'delegate ' + n })).sig.slice(0, 12));
}
for (const [n, t] of [['house', 'House'], ['market', 'Market']]) { const r = await until(() => get(ER, t, A[n]), 20_000); console.log(n, 'on rollup', REGION, r ? `after ${r.ms} ms, owner ${r.v._owner.slice(0, 6)}, lamports ${r.v._lamports}` : 'NOT VISIBLE'); }
