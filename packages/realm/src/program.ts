import { IDL } from './idl.ts';
import { b58decode, b58encode, concat, i64, pda, sha256, str, u8, u64, utf8 } from './bytes.ts';
import type { Ix } from './tx.ts';

export const REALM = IDL.address as string;
export const CHIP = 1_000_000n;                                     // lamports: 1 chip = 0.001 SOL
export const CHIPS_PER_SOL = 1000;
export const P = {
  system: '11111111111111111111111111111111', delegation: 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh', magic: 'Magic11111111111111111111111111111111111111', magicContext: 'MagicContext1111111111111111111111111111111',
  session: 'KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5', vrf: 'Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz', vrfQueue: '5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc', slotHashes: 'SysvarS1otHashes111111111111111111111111111', loader: 'BPFLoaderUpgradeab1e11111111111111111111111', computeBudget: 'ComputeBudget111111111111111111111111111111',
} as const;
const k = (a: string) => b58decode(a);
export const addr = {
  config: () => pda(['config'], REALM), bank: () => pda(['bank'], REALM), housePurse: () => pda(['house_purse'], REALM), house: () => pda(['house'], REALM),
  purse: (w: string) => pda(['purse', k(w)], REALM), player: (w: string) => pda(['player', k(w)], REALM),
  sessionToken: (w: string, session: string) => pda(['session_token_v2', k(REALM), k(session), k(w)], P.session),
  programData: () => pda([k(REALM)], P.loader),
};
const fixed = (): Record<string, string> => ({ config: addr.config(), bank: addr.bank(), house_purse: addr.housePurse(), house: addr.house(), system_program: P.system, owner_program: REALM, delegation_program: P.delegation, magic_program: P.magic, magic_context: P.magicContext, program_id: REALM, program: REALM, program_data: addr.programData(), oracle_queue: P.vrfQueue, vrf_program: P.vrf, slot_hashes: P.slotHashes, program_identity: pda(['identity'], REALM) });

/** an instruction of our program. Accounts follow the IDL; the delegation helpers are derived from the account they serve. */
export function realmIx(name: string, accounts: Record<string, string> = {}, args: Uint8Array = new Uint8Array()): Ix {
  const def = IDL.instructions.find((i) => i.n === name) as { d: readonly number[]; a: readonly { n: string; w?: 1; s?: 1; o?: 1; k?: string }[] } | undefined;
  if (!def) throw new Error(`no instruction ${name}`);
  const known = { ...fixed(), ...accounts };
  return {
    program: REALM, data: concat(Uint8Array.from(def.d), args),
    accounts: def.a.map((a) => {
      let address: string | undefined = known[a.n]; let signer = !!a.s, writable = !!a.w;
      if (!address) { const m = /^(buffer|delegation_record|delegation_metadata)_(.+)$/.exec(a.n); const t = m && known[m[2]]; if (m && t) address = m[1] === 'buffer' ? pda(['buffer', k(t)], REALM) : pda([m[1] === 'delegation_record' ? 'delegation' : 'delegation-metadata', k(t)], P.delegation); }
      if (!address && a.o) { address = REALM; signer = false; writable = false; }
      address ??= a.k; if (!address) throw new Error(`${name}: missing account ${a.n}`);
      return { address, signer, writable };
    }),
  };
}
const mine = (w: string) => ({ authority: w, player: addr.player(w), purse: addr.purse(w) });
const play = (w: string, signer: string) => ({ ...mine(w), signer, ...(signer === w ? {} : { session_token: addr.sessionToken(w, signer) }) });
export const ix = {
  openAccount: (payer: string, w: string) => realmIx('open_account', { payer, owner: w, purse: addr.purse(w), player: addr.player(w) }),
  delegatePlayer: (payer: string, w: string) => realmIx('delegate_player', { payer, owner: w, player: addr.player(w) }),
  buyChips: (w: string, lamports: bigint) => realmIx('buy_chips', { owner: w, purse: addr.purse(w) }, u64(lamports)),
  settlePayout: (w: string) => realmIx('settle_payout', { wallet: w, purse: addr.purse(w), player: addr.player(w) }),
  cashOutL1: (w: string, chips: number) => realmIx('cash_out_l1', { owner: w, purse: addr.purse(w), player: addr.player(w) }, u64(chips)),
  syncDeposit: (w: string) => realmIx('sync_deposit', mine(w)),
  syncHouse: () => realmIx('sync_house'),
  claimWelcome: (w: string, signer: string) => realmIx('claim_welcome', play(w, signer)),
  cashOut: (w: string, chips: number) => realmIx('cash_out', mine(w), u64(chips)),
  setProfile: (w: string, signer: string, name: string, avatar: string) => realmIx('set_profile', play(w, signer), concat(str(name), str(avatar))),
  enterRealm: (w: string, signer: string, realm: number) => realmIx('enter_realm', play(w, signer), u8(realm)),
  completeTour: (w: string, signer: string, realm: number) => realmIx('complete_tour', play(w, signer), u8(realm)),
  placeBet: (w: string, signer: string, game: number, chips: number, pick: number, clientSeed: Uint8Array) => realmIx('place_bet', play(w, signer), concat(u8(game), u64(chips), u8(pick), clientSeed)),
  bjDeal: (w: string, signer: string, chips: number, clientSeed: Uint8Array) => realmIx('bj_deal', play(w, signer), concat(u64(chips), clientSeed)),
  bjAct: (w: string, signer: string, action: number, clientSeed: Uint8Array) => realmIx('bj_act', play(w, signer), concat(u8(action), clientSeed)),
  /** anyone, once the hand has been idle for two minutes */
  bjStandIdle: (w: string, signer: string) => realmIx('bj_stand_idle', { signer, authority: w, player: addr.player(w) }),
  refundStale: (w: string) => realmIx('refund_stale', { authority: w, player: addr.player(w) }),
  /** SessionTokenV2: the wallet, the session key and whoever pays all sign. No SOL goes to the session key. */
  createSession: (w: string, session: string, feePayer: string, validUntil: number): Ix => ({
    program: P.session, data: concat(sha256(utf8('global:create_session_v2')).slice(0, 8), Uint8Array.of(1, 0, 1), i64(validUntil), u8(0)),
    accounts: [{ address: addr.sessionToken(w, session), signer: false, writable: true }, { address: session, signer: true, writable: true }, { address: feePayer, signer: true, writable: true }, { address: w, signer: true, writable: false }, { address: REALM, signer: false, writable: false }, { address: P.system, signer: false, writable: false }],
  }),
  transfer: (from: string, to: string, lamports: bigint): Ix => ({ program: P.system, data: concat(Uint8Array.of(2, 0, 0, 0), u64(lamports)), accounts: [{ address: from, signer: true, writable: true }, { address: to, signer: false, writable: true }] }),
};

// ---------------------------------------------------------------- accounts
const has = (d: Uint8Array, name: keyof typeof IDL.accounts) => (IDL.accounts[name] as readonly number[]).every((b, i) => d[i] === b);
class Reader { o = 8; v: DataView; constructor(public d: Uint8Array) { this.v = new DataView(d.buffer, d.byteOffset, d.byteLength); }
  u8() { return this.d[this.o++]; } u16() { const n = this.v.getUint16(this.o, true); this.o += 2; return n; } u32() { const n = this.v.getUint32(this.o, true); this.o += 4; return n; }
  u64() { const n = this.v.getBigUint64(this.o, true); this.o += 8; return n; } i64() { const n = Number(this.v.getBigInt64(this.o, true)); this.o += 8; return n; }
  key() { const a = b58encode(this.d.subarray(this.o, this.o + 32)); this.o += 32; return a; } raw(n: number) { const b = this.d.slice(this.o, this.o + n); this.o += n; return b; }
  text(n: number) { const b = this.raw(n); const z = b.indexOf(0); return new TextDecoder().decode(z < 0 ? b : b.subarray(0, z)); } skip(n: number) { this.o += n; } }
export interface PlayerState { authority: string; chips: bigint; credited: bigint; withdrawn: bigint; withdrawnBooked: bigint; lastUpdate: number; lastRealmChange: number; candleAt: number; harmonyAt: number; lastAlms: number; wagered: bigint; tithed: bigint; convertedMilli: bigint; faithEarnedMilli: bigint; betSeq: bigint; luckMilli: number; faithMilli: number; questsClaimed: number; spins: number; flips: number; dice: number; roulette: number; blackjack: number; candles: number; timeouts: number; commits: number; realm: number; tourFlags: number; welcomeClaimed: boolean; plotGate: boolean; name: string; avatar: string; pendingActive: boolean; pending: { seq: bigint; wager: bigint; placedTs: number; clientSeed: Uint8Array; game: number; pick: number } | null; hand: HandState | null; recent: BetResultState[]; lastVrf: Uint8Array; lastVrfSeq: bigint }
export interface BetResultState { seq: bigint; wager: bigint; payout: bigint; ts: number; luckGainMilli: number; outcome: number[]; blessingChips: number; game: number; jackpot: boolean }
/** a blackjack hand; `over` hands stay readable until the next deal. `awaiting`: what the oracle has been asked for (0 nothing) */
export interface HandState { seq: bigint; stake: bigint; original: bigint; lastTs: number; used: bigint; player: number[]; dealer: number[]; over: boolean; dealing: boolean; doubled: boolean; awaiting: number }
export const BJ = { deal: 1, hit: 2, stand: 3, double: 4 } as const;
export const BJ_LABELS = ['lose', 'push', 'win', 'natural'] as const;
export const GAME = { slots: 0, coinflip: 1, dice: 2, roulette: 3, wheel: 4, harmony: 5, blackjack: 6, market: 7 } as const;
export const GAME_NAMES = Object.keys(GAME) as (keyof typeof GAME)[];
export function decodePlayer(d: Uint8Array): PlayerState | null {
  if (d.length < 1176 || !has(d, 'Player')) return null;
  const r = new Reader(d); const authority = r.key(), chips = r.u64(), credited = r.u64(), withdrawn = r.u64(), withdrawnBooked = r.u64();
  const lastUpdate = r.i64(), lastRealmChange = r.i64(), candleAt = r.i64(), harmonyAt = r.i64(), lastAlms = r.i64(); const wagered = r.u64(), tithed = r.u64(), convertedMilli = r.u64(), faithEarnedMilli = r.u64(); r.u64(); const betSeq = r.u64();
  const luckMilli = r.u32(), faithMilli = r.u32(), questsClaimed = r.u32(); r.skip(12); const spins = r.u32(), flips = r.u32(), dice = r.u32(), roulette = r.u32(), blackjack = r.u32(), candles = r.u32(), timeouts = r.u32(), commits = r.u32();
  const realm = r.u8(), tourFlags = r.u8(), flags = r.u8(); r.skip(5); const name = r.text(16), avatar = r.text(24); r.skip(32 + 24); const p0 = r.o, pendingActive = d[p0 + 75] !== 0;
  const pSeq = r.u64(), pWager = r.u64(); r.skip(16); const placedTs = r.i64(), clientSeed = r.raw(32); const pending = pendingActive ? { seq: pSeq, wager: pWager, placedTs, clientSeed, game: d[p0 + 72], pick: d[p0 + 73] } : null;
  r.o = p0 + 80; const hSeq = r.u64(), stake = r.u64(), original = r.u64(); r.u64(); const lastTs = r.i64(), used = r.u64(), pc = [...r.raw(12)], dc = [...r.raw(12)], np = r.u8(), nd = r.u8(), stage = r.u8(), dbl = r.u8(), awaiting = r.u8();
  const hand: HandState | null = hSeq ? { seq: hSeq, stake, original, lastTs, used, player: pc.slice(0, np), dealer: dc.slice(0, nd), over: stage === 0, dealing: stage === 1, doubled: dbl !== 0, awaiting } : null;
  r.o = p0 + 80 + 80 + 256; const recent: BetResultState[] = [];
  for (let i = 0; i < 8; i++) { const seq = r.u64(), wager = r.u64(), payout = r.u64(), ts = r.u32(), luckGainMilli = r.u32(), outcome = [...r.raw(4)], blessingChips = r.u16(), game = r.u8(), flags = r.u8(); if (seq) recent.push({ seq, wager, payout, ts, luckGainMilli, outcome, blessingChips, game, jackpot: !!(flags & 1) }); }
  recent.sort((a, b) => (a.seq < b.seq ? 1 : -1)); const lastVrf = r.raw(32), lastVrfSeq = r.u64();
  return { authority, chips, credited, withdrawn, withdrawnBooked, lastUpdate, lastRealmChange, candleAt, harmonyAt, lastAlms, wagered, tithed, convertedMilli, faithEarnedMilli, betSeq, luckMilli, faithMilli, questsClaimed, spins, flips, dice, roulette, blackjack, candles, timeouts, commits, realm, tourFlags, welcomeClaimed: !!(flags & 1), plotGate: !!(flags & 2), name, avatar, pendingActive, pending, hand, recent, lastVrf, lastVrfSeq };
}
export interface PurseState { owner: string; deposited: bigint; paidOut: bigint; lastDepositTs: number }
export function decodePurse(d: Uint8Array): PurseState | null { if (d.length < 60 || !has(d, 'Purse')) return null; const r = new Reader(d); return { owner: r.key(), deposited: r.u64(), paidOut: r.u64(), lastDepositTs: r.i64() }; }
export interface BankState { totalDeposited: bigint; totalPaid: bigint }
export function decodeBank(d: Uint8Array): BankState | null { if (!has(d, 'Bank')) return null; const r = new Reader(d); return { totalDeposited: r.u64(), totalPaid: r.u64() }; }
export interface HouseState { vault: bigint; reserved: bigint; treasury: bigint; jackpot: bigint; machineTotal: bigint; escrowTotal: bigint; chipsOutstanding: bigint; totalCredited: bigint; totalWithdrawn: bigint; welcomePaid: bigint; maxBetChips: number; welcomeChips: number; allowedWagers: number[]; totalPlayers: bigint; paused: boolean }
export function decodeHouse(d: Uint8Array): HouseState | null {
  if (!has(d, 'House')) return null; const r = new Reader(d);
  const vault = r.u64(), reserved = r.u64(), treasury = r.u64(), jackpot = r.u64(), machineTotal = r.u64(); r.u64(); const escrowTotal = r.u64(), chipsOutstanding = r.u64(); r.skip(24); const totalCredited = r.u64(), totalWithdrawn = r.u64(), welcomePaid = r.u64();
  r.skip(40); r.skip(2 * 24 + 16 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 16 * 32 + 8); const p0 = r.o; const par = (i: number) => { const n = r.v.getUint32(p0 + 4 * i, true); return n; };
  const allowedWagers: number[] = []; for (let i = 0; i < 8; i++) if (par(18 + i)) allowedWagers.push(par(18 + i)); r.o = p0 + 26 * 4; const totalPlayers = r.u64(), paused = r.u8() !== 0;
  return { vault, reserved, treasury, jackpot, machineTotal, escrowTotal, chipsOutstanding, totalCredited, totalWithdrawn, welcomePaid, maxBetChips: par(9), welcomeChips: par(8), allowedWagers, totalPlayers, paused };
}
// ---------------------------------------------------------------- events ("Program data: ..." in the logs)
export interface SettledEvent { wallet: string; seq: bigint; game: number; pick: number; wager: bigint; payout: bigint; blessing: bigint; luckGainMilli: number; outcome: number[]; jackpot: boolean; randomness: Uint8Array }
export function settledFromLogs(logs: string[], decode64: (s: string) => Uint8Array): SettledEvent[] {
  const out: SettledEvent[] = [], disc = IDL.events.BetSettled as readonly number[];
  for (const l of logs) { if (!l.startsWith('Program data: ')) continue; let d: Uint8Array; try { d = decode64(l.slice(14).trim()); } catch { continue; } if (d.length < 8 + 32 + 8 + 2 + 24 + 4 + 4 + 1 + 32 || !disc.every((b, i) => d[i] === b)) continue;
    const r = new Reader(d); out.push({ wallet: r.key(), seq: r.u64(), game: r.u8(), pick: r.u8(), wager: r.u64(), payout: r.u64(), blessing: r.u64(), luckGainMilli: r.u32(), outcome: [...r.raw(4)], jackpot: r.u8() !== 0, randomness: r.raw(32) }); }
  return out;
}
export interface HandStepEvent { wallet: string; seq: bigint; step: number; action: number; player: number[]; dealer: number[]; randomness: Uint8Array }
export function handStepsFromLogs(logs: string[], decode64: (s: string) => Uint8Array): HandStepEvent[] {
  const out: HandStepEvent[] = [], disc = IDL.events.HandStep as readonly number[];
  for (const l of logs) { if (!l.startsWith('Program data: ')) continue; let d: Uint8Array; try { d = decode64(l.slice(14).trim()); } catch { continue; } if (d.length < 8 + 32 + 8 + 2 + 13 + 13 + 32 || !disc.every((b, i) => d[i] === b)) continue;
    const r = new Reader(d), wallet = r.key(), seq = r.u64(), step = r.u8(), action = r.u8(), pc = [...r.raw(12)], np = r.u8(), dc = [...r.raw(12)], nd = r.u8(); out.push({ wallet, seq, step, action, player: pc.slice(0, np), dealer: dc.slice(0, nd), randomness: r.raw(32) }); }
  return out;
}
/** the cards one oracle answer gives: card k = sha256(randomness || k), scaled to the cards still in the deck */
export class Shoe {
  private k = 0;
  constructor(private seed: Uint8Array, public used: bigint = 0n) {}
  draw(): number {
    const h = sha256(concat(this.seed, Uint8Array.of(this.k++))), left: number[] = []; for (let c = 0; c < 52; c++) if (!(this.used >> BigInt(c) & 1n)) left.push(c);
    const card = left[Math.floor(new DataView(h.buffer, h.byteOffset, 4).getUint32(0, true) * left.length / 4294967296)]; this.used |= 1n << BigInt(card); return card;
  }
}
/** 32 random bytes -> eight draws, exactly as the program does it */
export const drawsOf = (h: Uint8Array): number[] => { const v = new DataView(h.buffer, h.byteOffset, 32); return Array.from({ length: 8 }, (_, i) => v.getUint32(i * 4, true)); };
/** "Custom": 6001 -> "NotAllowed" */
export const errorName = (code: number): string | null => (IDL.errors as Record<string, string>)[String(code)] ?? null;
