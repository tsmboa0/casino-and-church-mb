import fs from 'node:fs'; import os from 'node:os';
import { L1, ER, key, Keypair, SystemProgram, A, ix, send, get, until, purseOf, playerOf, createSessionV2, u64, stats, record, sleep, DLP, PROGRAM } from './lib.mjs';
const admin = key('admin'), sponsor = key('sponsor');
const N = Number(process.env.N ?? 20), PAY = Number(process.env.PAY ?? 8);
export async function newPlayer() {
  const owner = Keypair.generate(), session = Keypair.generate();
  const s = createSessionV2({ authority: owner.publicKey, sessionSigner: session.publicKey, feePayer: sponsor.publicKey, validUntil: Math.floor(Date.now() / 1000) + 6 * 86400 });
  const open = ix('open_account', { payer: sponsor.publicKey, owner: owner.publicKey, purse: purseOf(owner.publicKey), player: playerOf(owner.publicKey) });
  const before = await L1.getBalance(sponsor.publicKey);
  const r = await send(L1, [open, s.ix], [sponsor, owner, session], { label: 'setup' });
  const after = await L1.getBalance(sponsor.publicKey);
  await send(L1, SystemProgram.transfer({ fromPubkey: sponsor.publicKey, toPubkey: owner.publicKey, lamports: 130_000_000 }), [sponsor], { label: 'fund' });
  const seen = await until(() => get(ER, 'Player', playerOf(owner.publicKey)), 20_000);
  return { owner, session, token: s.token, setup: { bytes: r.size, ms: r.ms, cost: before - after, onRollupMs: seen?.ms ?? null } };
}
const acc = (p) => ({ player: playerOf(p.owner.publicKey), purse: purseOf(p.owner.publicKey) });
export const buy = (p, chips) => send(L1, ix('buy', { owner: p.owner.publicKey, purse: acc(p).purse }, u64(chips * 1_000_000)), [sponsor, p.owner], { feePayer: sponsor.publicKey, label: 'buy' });
export const sync = (p) => send(ER, ix('sync_deposit', acc(p)), [p.session], { label: 'sync' });
export const me = (p, c = ER) => get(c, 'Player', acc(p).player);
if (import.meta.url === `file://${process.argv[1]}`) {
  const p = await newPlayer(); record('t11_setup', p.setup);
  fs.writeFileSync(os.homedir() + '/.config/casino-mb/devnet/spike-player.json', JSON.stringify({ owner: [...p.owner.secretKey], session: [...p.session.secretKey] }), { mode: 0o600 });
  // T1 + T7: L1 deposit -> rollup credit, sync signed and "paid" by a session key with 0 SOL
  const lat = []; let bad = 0, total = 0;
  for (let i = 0; i < N; i++) {
    await buy(p, 2); total += 2_000_000; const t0 = Date.now();
    let ok = null; while (Date.now() - t0 < 20_000) { try { await sync(p); } catch (e) { console.log('sync err', e.message.slice(0, 120)); } const m = await me(p); if (m.credited === total) { ok = Date.now() - t0; break; } await sleep(250); }
    if (ok == null) bad++; else lat.push(ok);
  }
  await sync(p); await sync(p); const m = await me(p);
  record('t01_deposit', { ...stats(lat), failed: bad, credited: m.credited, expected: total, chips: m.chips, noDouble: m.credited === total && m.chips === total, sessionKeyLamportsL1: await L1.getBalance(p.session.publicKey) });
  // T2 + T4: cash out -> commit -> Magic Action -> SOL
  const payMs = []; let paid = 0, missed = 0; const bal0 = await L1.getBalance(p.owner.publicKey);
  for (let i = 0; i < PAY; i++) {
    await send(ER, ix('cash_out', { authority: p.owner.publicKey, ...acc(p) }, u64(1)), [p.owner], { label: 'cash_out' }); paid += 1_000_000;
    const r = await until(async () => { const q = await get(L1, 'Purse', acc(p).purse); return q.paid_out === paid ? q : null; }, 60_000, 800);
    if (r) payMs.push(r.ms); else missed++;
  }
  const l1p = await me(p, L1), q = await get(L1, 'Purse', acc(p).purse);
  record('t02_cashout', { ...stats(payMs), missed, walletGained: (await L1.getBalance(p.owner.publicKey)) - bal0, paid_out: q.paid_out, withdrawn: l1p.withdrawn });
  record('t04_read_delegated_on_l1', { owner: l1p._owner === DLP.toBase58() ? 'delegation program' : l1p._owner === PROGRAM.toBase58() ? 'our program' : l1p._owner, withdrawnMatches: l1p.withdrawn === (await me(p)).withdrawn, authorityMatches: l1p.authority === p.owner.publicKey.toBase58() });
}
