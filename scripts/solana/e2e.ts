// the real program on devnet: a new player from nothing, money both ways, and everything that must be refused
import fs from 'node:fs';
import { addr, buildTx, CHIP, compileMessage, decodeBank, decodeHouse, decodePlayer, decodePurse, ix, parseTx, realmIx, u64, u8, type Signer } from '../../packages/realm/src/index.ts';
import { cli, er, key, l1, send, sleep, until, testKey as newSigner } from './lib.ts';
const sponsor = key('sponsor'), admin = key('admin'), keeper = key('keeper'); const out: Record<string, unknown> = {}; let failed = 0;
const check = (n: string, pass: boolean, info: unknown = '') => { out[n] = { pass, info }; if (!pass) failed++; console.log(pass ? 'ok  ' : 'FAIL', n, typeof info === 'string' ? info : JSON.stringify(info, (_, v) => (typeof v === 'bigint' ? String(v) : v))); };
const refused = async (n: string, f: () => Promise<unknown>, want?: string) => { try { await f(); check(n, false, 'ACCEPTED'); } catch (e: any) { check(n, !want || e.code === want, e.code + (want && e.code !== want ? ` (wanted ${want}) ${e.message}` : '')); } };
const ms = async <T>(f: () => Promise<T>): Promise<[T, number]> => { const t = Date.now(); const v = await f(); return [v, Date.now() - t]; };
const P = async (w: string, c = er) => decodePlayer((await c.account(addr.player(w)))!.data)!; const Pu = async (w: string) => decodePurse((await l1.account(addr.purse(w)))!.data)!;
async function open() { const w = newSigner(), s = newSigner(); const before = await l1.balance(sponsor.address); const wire = buildTx(compileMessage(sponsor.address, [ix.openAccount(sponsor.address, w.address), ix.delegatePlayer(sponsor.address, w.address), ix.createSession(w.address, s.address, sponsor.address, Math.floor(Date.now() / 1000) + 6 * 86400)], await l1.blockhash()), [sponsor, w, s]); const [, t] = await ms(() => l1.send(wire)); const cost = before - await l1.balance(sponsor.address); const [, seen] = await ms(() => until(() => P(w.address))); return { w, s, bytes: wire.length, t, cost, seen }; }
const fund = (w: Signer, sol: number) => send(l1, [ix.transfer(cli().address, w.address, BigInt(sol * 1e9))], [cli()]);
if (await l1.balance(sponsor.address) < 400_000_000n) await fund(sponsor, 0.5);

// ---- a player whose wallet never holds any SOL
const a = await open(); check('setup in one transaction', a.bytes <= 1232, { bytes: a.bytes, ms: a.t, onRollupMs: a.seen, sponsorLamports: a.cost });
await send(er, [ix.claimWelcome(a.w.address, a.s.address)], [a.s]); check('welcome chips with the session key', (await P(a.w.address)).chips === 30n * CHIP);
await refused('welcome twice', () => send(er, [ix.claimWelcome(a.w.address, a.s.address)], [a.s]), 'AlreadyClaimed');
await send(er, [ix.setProfile(a.w.address, a.s.address, 'Magpie 77', 'm_jester')], [a.s]); await send(er, [ix.enterRealm(a.w.address, a.s.address, 1)], [a.s]); const pa = await P(a.w.address); check('profile and realm', pa.name === 'Magpie 77' && pa.avatar === 'm_jester' && pa.realm === 1);
await refused('realm change too soon', () => send(er, [ix.enterRealm(a.w.address, a.s.address, 2)], [a.s]), 'Cooldown');
check('wallet holds no SOL', await l1.balance(a.w.address) === 0n);
try { await send(er, [ix.cashOut(a.w.address, 10)], [a.w]); const [, t] = await ms(() => until(async () => (await Pu(a.w.address)).paidOut === 10n * CHIP, 45_000, 500)); check('a wallet with 0 SOL cashes out', await l1.balance(a.w.address) === 10n * CHIP, { ms: t }); } catch (e: any) { check('a wallet with 0 SOL cashes out', false, e.message); }

// ---- a player with money
const b = await open(); await fund(b.w, 0.4); const buy = (n: number) => send(l1, [ix.buyChips(b.w.address, BigInt(n) * CHIP)], [b.w]);
await buy(50); const [, credit] = await ms(() => until(async () => { await send(er, [ix.syncDeposit(b.w.address)], [b.s]); return (await P(b.w.address)).chips === 50n * CHIP; })); check('buy 50 chips, credited', true, { ms: credit });
await send(er, [ix.syncDeposit(b.w.address)], [b.s]); check('syncing again credits nothing', (await P(b.w.address)).chips === 50n * CHIP);
await buy(20); await sleep(4000); await send(er, [ix.enterRealm(b.w.address, b.s.address, 2)], [b.s]); check('any action credits a deposit (no sync sent)', (await P(b.w.address)).chips === 70n * CHIP);
await send(er, [ix.cashOut(b.w.address, 30)], [b.w]); await until(async () => (await Pu(b.w.address)).paidOut === 30n * CHIP, 45_000, 500); await send(l1, [ix.settlePayout(b.w.address)], [keeper]); check('cash out 30, and settling again pays nothing', (await Pu(b.w.address)).paidOut === 30n * CHIP && (await P(b.w.address)).chips === 40n * CHIP);

// ---- what must be refused
await refused('session key cashes out', () => send(er, [realmIx('cash_out', { authority: b.s.address, player: addr.player(b.w.address), purse: addr.purse(b.w.address) }, u64(1))], [b.s]));
await refused('too many chips', () => send(er, [ix.cashOut(b.w.address, 41)], [b.w]), 'NoChips'); await refused('zero chips', () => send(er, [ix.cashOut(b.w.address, 0)], [b.w]), 'BadAmount');
const x = newSigner(); await refused('stranger plays as someone else', () => send(er, [ix.enterRealm(b.w.address, x.address, 0)], [x])); await refused("stranger uses another player's session", () => send(er, [realmIx('enter_realm', { signer: x.address, authority: b.w.address, player: addr.player(b.w.address), purse: addr.purse(b.w.address), session_token: addr.sessionToken(b.w.address, b.s.address) }, u8(0))], [x]), 'BadSession');
await refused("own session on another's player", () => send(er, [realmIx('enter_realm', { signer: b.s.address, authority: a.w.address, player: addr.player(a.w.address), purse: addr.purse(a.w.address), session_token: addr.sessionToken(b.w.address, b.s.address) }, u8(0))], [b.s]), 'BadSession');
await refused("syncing with someone else's purse", () => send(er, [realmIx('sync_deposit', { authority: a.w.address, player: addr.player(a.w.address), purse: addr.purse(b.w.address) })], [a.s]));
await refused('payout to another wallet', () => send(l1, [realmIx('settle_payout', { wallet: keeper.address, purse: addr.purse(b.w.address), player: addr.player(b.w.address) })], [keeper]));
await refused("payout from another player's account", () => send(l1, [realmIx('settle_payout', { wallet: a.w.address, purse: addr.purse(a.w.address), player: addr.player(b.w.address) })], [keeper]));
await refused('opening the same account twice', () => send(l1, [ix.openAccount(sponsor.address, b.w.address)], [sponsor, b.w])); await refused('delegating a delegated player', () => send(l1, [ix.delegatePlayer(sponsor.address, b.w.address)], [sponsor]));
await refused('buying a fraction of a chip', () => send(l1, [ix.buyChips(b.w.address, 10n * CHIP + 1n)], [b.w]), 'BadAmount'); await refused('buying under the minimum', () => send(l1, [ix.buyChips(b.w.address, CHIP)], [b.w]), 'BadAmount');
await refused('stranger sets config', () => send(l1, [realmIx('set_config', { admin: keeper.address }, new Uint8Array(14))], [keeper]), 'NotAllowed'); await refused('stranger pauses the game', () => send(er, [realmIx('set_paused', { admin: keeper.address }, u8(1))], [keeper]), 'NotAllowed'); await refused('initialising again', () => send(l1, [realmIx('init', { admin: keeper.address }, new Uint8Array(6 * 32 + 32))], [keeper])); await refused('cash_out_l1 while on the rollup', () => send(l1, [ix.cashOutL1(b.w.address, 1)], [b.w]));

// ---- pause, rotation at the commit cap, cash-out on L1 while off the rollup
await send(er, [realmIx('set_paused', { admin: admin.address }, u8(1))], [admin]); await refused('playing while paused', () => send(er, [ix.enterRealm(b.w.address, b.s.address, 0)], [b.s]), 'Paused'); await send(er, [realmIx('set_paused', { admin: admin.address }, u8(0))], [admin]);
const c = await open(); await fund(c.w, 0.2); await send(l1, [ix.buyChips(c.w.address, 40n * CHIP)], [c.w]); await until(async () => { await send(er, [ix.syncDeposit(c.w.address)], [c.s]); return (await P(c.w.address)).chips === 40n * CHIP; });
for (let i = 1; i <= 8; i++) { await send(er, [ix.cashOut(c.w.address, 1)], [c.w]); await until(async () => (await Pu(c.w.address)).paidOut === BigInt(i) * CHIP, 45_000, 400); }
const off = await until(async () => { const i = await l1.account(addr.player(c.w.address)); return i && i.owner !== 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh' ? decodePlayer(i.data) : null; }, 45_000, 500); check('the 8th cash-out leaves the rollup, all 8 paid', off.commits === 8 && off.chips === 32n * CHIP && (await Pu(c.w.address)).paidOut === 8n * CHIP);
await send(l1, [ix.cashOutL1(c.w.address, 2)], [c.w]); check('cash out on L1 while off the rollup', (await Pu(c.w.address)).paidOut === 10n * CHIP);
await send(l1, [ix.delegatePlayer(sponsor.address, c.w.address)], [sponsor]); await until(async () => { await send(er, [ix.enterRealm(c.w.address, c.s.address, 1)], [c.s]); return true; }, 30_000, 800); const pc = await P(c.w.address); check('back on the rollup, commits reset, L1 cash-out booked', pc.commits === 0 && pc.chips === 30n * CHIP && pc.withdrawn === 10n * CHIP && pc.withdrawnBooked === pc.withdrawn);

// ---- the books
const h = decodeHouse((await er.account(addr.house()))!.data)!, bk = decodeBank((await l1.account(addr.bank()))!.data)!, bankInfo = (await l1.account(addr.bank()))!; const owed = h.chipsOutstanding + h.vault + h.treasury + h.jackpot + h.machineTotal + h.escrowTotal;
check('I1 rollup books balance', owed === h.totalCredited - h.totalWithdrawn, { owed, credited: h.totalCredited, withdrawn: h.totalWithdrawn }); check('I2 bank holds what it should', BigInt(bankInfo.lamports) >= bk.totalDeposited - bk.totalPaid && BigInt(bankInfo.lamports) >= owed, { bank: bankInfo.lamports, deposited: bk.totalDeposited, paid: bk.totalPaid }); check('I3 nothing credited or paid ahead', h.totalCredited <= bk.totalDeposited && bk.totalPaid <= h.totalWithdrawn);
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED', Object.keys(out).length, 'checks'); fs.writeFileSync('docs/e2e-m2.json', JSON.stringify({ at: new Date().toISOString(), checks: out }, (_, v) => (typeof v === 'bigint' ? String(v) : v), 1)); process.exit(failed ? 1 : 0);
