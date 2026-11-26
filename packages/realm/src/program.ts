import { IDL } from './idl.ts';
import { b58decode, b58encode, concat, i64, pda, sha256, str, u8, u16, u32, u64, utf8 } from './bytes.ts';
import type { Ix } from './tx.ts';

export const REALM = IDL.address as string;
export const CHIP = 1_000_000n;                                     // lamports: 1 chip = 0.001 SOL
export const CHIPS_PER_SOL = 1000;
export const P = {
  system: '11111111111111111111111111111111', delegation: 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh', magic: 'Magic11111111111111111111111111111111111111', magicContext: 'MagicContext1111111111111111111111111111111',
  session: 'KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5', vrf: 'Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz', vrfQueue: '5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc', slotHashes: 'SysvarS1otHashes111111111111111111111111111', hydra: 'eHyd5BU8QffvHi4GnXwxrK4WpS7pM2x9UGKHBWii7mf', ephemeralVault: 'MagicVau1t999999999999999999999999999999999', instructions: 'Sysvar1nstructions1111111111111111111111111', btcFeed: '71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr', loader: 'BPFLoaderUpgradeab1e11111111111111111111111', computeBudget: 'ComputeBudget111111111111111111111111111111',
} as const;
const k = (a: string) => b58decode(a);
export const addr = {
  config: () => pda(['config'], REALM), bank: () => pda(['bank'], REALM), housePurse: () => pda(['house_purse'], REALM), house: () => pda(['house'], REALM), market: () => pda(['market'], REALM), plots: () => pda(['plots'], REALM), decisions: () => pda(['decisions'], REALM), board: (i: number) => pda(['board', u8(i)], REALM),
  /** nobody owns it: it only makes the L1 record of 60 rounds easy to find */
  roundsPage: (page: number) => pda(['rounds', u32(page)], REALM), marketCrank: (seed: Uint8Array) => pda(['crank', k(pda(['market'], REALM)), seed], P.hydra),
  purse: (w: string) => pda(['purse', k(w)], REALM), player: (w: string) => pda(['player', k(w)], REALM),
  sessionToken: (w: string, session: string) => pda(['session_token_v2', k(REALM), k(session), k(w)], P.session),
  programData: () => pda([k(REALM)], P.loader),
};
const fixed = (): Record<string, string> => ({ config: addr.config(), bank: addr.bank(), house_purse: addr.housePurse(), house: addr.house(), market: addr.market(), plots: addr.plots(), decisions: addr.decisions(), feed: P.btcFeed, instructions: P.instructions, hydra: P.hydra, ephemeral_vault: P.ephemeralVault, system_program: P.system, owner_program: REALM, delegation_program: P.delegation, magic_program: P.magic, magic_context: P.magicContext, program_id: REALM, program: REALM, program_data: addr.programData(), oracle_queue: P.vrfQueue, vrf_program: P.vrf, slot_hashes: P.slotHashes, program_identity: pda(['identity'], REALM) });

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
export type HostCallInput =
  | { do: 'none' } | { do: 'set_max_bet'; chips: number } | { do: 'set_luck_rate'; milli: number } | { do: 'start_event'; kind: 0 | 1; minutes: number; boost_bps: number }
  | { do: 'end_event'; kind: 0 | 1 } | { do: 'top_up_jackpot'; chips: number } | { do: 'grant_alms'; chips: number } | { do: 'set_blessing_cap'; bps: number } | { do: 'set_candle_faith'; milli: number };
const callParts = (c: HostCallInput): [number, number, number, number] => {
  switch (c.do) {
    case 'none': return [0, 0, 0, 0]; case 'set_max_bet': return [1, c.chips, 0, 0]; case 'set_luck_rate': return [2, c.milli, 0, 0]; case 'start_event': return [3, c.kind, c.minutes, c.boost_bps];
    case 'end_event': return [4, c.kind, 0, 0]; case 'top_up_jackpot': return [5, c.chips, 0, 0]; case 'grant_alms': return [6, c.chips, 0, 0]; case 'set_blessing_cap': return [7, c.bps, 0, 0]; case 'set_candle_faith': return [8, c.milli, 0, 0];
  }
};
/** the instruction argument (Anchor's enum) */
export const hostCallBytes = (c: HostCallInput) => { const [t, a, b, d] = callParts(c); return t === 0 ? u8(0) : t === 3 ? concat(u8(3), u8(a), u16(b), u32(d)) : t === 4 ? concat(u8(4), u8(a)) : concat(u8(t), u32(a)); };
/** what the decision hash covers (onchain hosts.rs `Call::bytes`) */
export const hostCallHashBytes = (c: HostCallInput) => { const [t, a, b, d] = callParts(c); return concat(u8(t), u32(a), u32(b), u32(d)); };
/** sha256(id || agent || response sha256 || action): it is what L1 records and the rollup checks */
export const decisionHash = (id: Uint8Array, agent: number, responseSha256: Uint8Array, c: HostCallInput) => sha256(concat(id, u8(agent), responseSha256, hostCallHashBytes(c)));
/** tithes and candles, for the hosts' view of the church */
export const churchFromLogs = (logs: string[], d64: (s: string) => Uint8Array) => [
  ...events(logs, d64, 'Tithed', 44).map((r) => ({ kind: 'tithe' as const, wallet: r.key(), chips: Number(r.u64()) / 1e6 })),
  ...events(logs, d64, 'CandleLit', 36).map((r) => ({ kind: 'candle' as const, wallet: r.key(), chips: 0 })),
];
export interface DecisionProofInput { id: Uint8Array; policy: number; action: string; model: string; signedText: string; signature: Uint8Array; signingAddress: Uint8Array; requestSha256: Uint8Array; responseSha256: Uint8Array }
export interface DecisionAnchoredEvent extends DecisionProofInput { agent: number; hash: Uint8Array }
export function anchoredFromLogs(logs: string[], d64: (s: string) => Uint8Array): DecisionAnchoredEvent[] {
  const disc = IDL.events.DecisionAnchored as readonly number[], out: DecisionAnchoredEvent[] = [];
  for (const l of logs) { if (!l.startsWith('Program data: ')) continue; let d: Uint8Array; try { d = d64(l.slice(14).trim()); } catch { continue; } if (!disc.every((b, i) => d[i] === b)) continue;
    const r = new Reader(d), s = () => new TextDecoder().decode(r.raw(r.u32())); const agent = r.u8(), hash = r.raw(32), id = r.raw(16), policy = r.u8(), action = s(), model = s(), signedText = s();
    out.push({ agent, hash, id, policy, action, model, signedText, signature: r.raw(65), signingAddress: r.raw(20), requestSha256: r.raw(32), responseSha256: r.raw(32) }); }
  return out;
}
export interface CampaignInput { kind: number; title: string; url: string; machine_id: number; goal: number; reward_chips: number; reward_faith_milli: number; max_claims: number }
const campaignBytes = (c: CampaignInput) => concat(u8(c.kind), str(c.title), str(c.url), u32(c.machine_id), u32(c.goal), u32(c.reward_chips), u32(c.reward_faith_milli), u32(c.max_claims));
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
  computeLimit: (units: number): Ix => ({ program: P.computeBudget, data: concat(Uint8Array.of(2), u32(units)), accounts: [] }),
  // the BTC market
  marketBet: (w: string, signer: string, epoch: bigint, side: number, chips: number) => realmIx('market_bet', play(w, signer), concat(u64(epoch), u8(side), u64(chips))),
  /** anyone; it only pays the bettor */
  marketClaim: (w: string) => realmIx('market_claim', { authority: w, player: addr.player(w) }),
  marketTick: (keeper?: string) => realmIx('market_tick', keeper ? { keeper } : {}),
  marketCheckpoint: (signer: string) => realmIx('market_checkpoint', { signer }),
  delegateMarket: (payer: string) => realmIx('delegate_market', { payer }),
  logRounds: (page: number) => realmIx('log_rounds', { rounds: addr.roundsPage(page) }, u32(page)),
  // the church
  tithe: (w: string, signer: string, chips: number) => realmIx('tithe', play(w, signer), u64(chips)),
  offerLuck: (w: string, signer: string, milli: number) => realmIx('offer_luck', play(w, signer), u32(milli)),
  lightCandle: (w: string, signer: string) => realmIx('light_candle', play(w, signer)),
  claimQuest: (w: string, signer: string, bit: number) => realmIx('claim_quest', play(w, signer), u8(bit)),
  // Founders' Row
  claimPlot: (w: string, signer: string, plot: number, name: string, skin: number, chips: number) => realmIx('claim_plot', play(w, signer), concat(u8(plot), str(name), u8(skin), u64(chips))),
  /** more than 0 puts chips in, less takes them out */
  fundMachine: (w: string, signer: string, plot: number, chips: number) => realmIx('fund_machine', play(w, signer), concat(u8(plot), i64(chips))),
  releasePlot: (w: string, signer: string, plot: number) => realmIx('release_plot', play(w, signer), u8(plot)),
  transferDeed: (w: string, plot: number, to: string) => realmIx('transfer_deed', play(w, w), concat(u8(plot), k(to))),
  machineBet: (w: string, signer: string, plot: number, chips: number, clientSeed: Uint8Array) => realmIx('place_machine_bet', play(w, signer), concat(u8(plot), u64(chips), clientSeed)),
  refundMachineBet: (w: string) => realmIx('refund_machine_bet', { authority: w, player: addr.player(w) }),
  // campaigns: ids 0 to 127 live on board 0, the rest on board 1
  createCampaign: (w: string, signer: string, oracle: string, board: number, c: CampaignInput) => realmIx('create_campaign', { ...play(w, signer), board: addr.board(board), oracle }, campaignBytes(c)),
  seedCampaign: (admin: string, board: number, c: CampaignInput) => realmIx('seed_campaign', { admin, board: addr.board(board) }, campaignBytes(c)),
  claimCampaign: (w: string, signer: string, id: number, oracle?: string) => realmIx('claim_campaign', { ...play(w, signer), board: addr.board(id >> 7), ...(oracle ? { oracle } : {}) }, u32(id)),
  closeCampaign: (w: string, signer: string, id: number) => realmIx('close_campaign', { signer, authority: w, board: addr.board(id >> 7), ...(signer === w ? {} : { session_token: addr.sessionToken(w, signer) }) }, u32(id)),
  /** anyone; `creator` unless the treasury paid for it */
  collectCampaign: (id: number, creator?: string) => realmIx('collect_campaign', { board: addr.board(id >> 7), ...(creator ? { player: addr.player(creator) } : {}) }, u32(id)),
  // the hosts: written on L1 first, then acted on, once
  anchorDecision: (host: string, agent: number, hash: Uint8Array, p: DecisionProofInput) => realmIx('anchor_decision', { host }, concat(u8(agent), hash, p.id, u8(p.policy), str(p.action), str(p.model), str(p.signedText), p.signature, p.signingAddress, p.requestSha256, p.responseSha256)),
  hostAct: (host: string, agent: number, id: Uint8Array, responseSha256: Uint8Array, call: HostCallInput, player?: string) => realmIx('host_act', { host, ...(player ? { player: addr.player(player) } : {}) }, concat(u8(agent), id, responseSha256, hostCallBytes(call))),
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
export interface PlayerState { authority: string; chips: bigint; credited: bigint; withdrawn: bigint; withdrawnBooked: bigint; lastUpdate: number; lastRealmChange: number; candleAt: number; harmonyAt: number; lastAlms: number; wagered: bigint; tithed: bigint; convertedMilli: bigint; faithEarnedMilli: bigint; betSeq: bigint; luckMilli: number; faithMilli: number; questsClaimed: number; spins: number; flips: number; dice: number; roulette: number; blackjack: number; candles: number; timeouts: number; commits: number; realm: number; tourFlags: number; welcomeClaimed: boolean; plotGate: boolean; name: string; avatar: string; pendingActive: boolean; pending: { seq: bigint; wager: bigint; placedTs: number; clientSeed: Uint8Array; game: number; pick: number; plot: number } | null; hand: HandState | null; btc: BtcSlotState[]; recent: BetResultState[]; lastVrf: Uint8Array; lastVrfSeq: bigint; bonus: bigint; campaigns: Uint8Array; machinePlays: { machineId: number; plays: number }[] }
/** `blessing` in chips; `free`: the prize was free chips */
export interface BetResultState { seq: bigint; wager: bigint; payout: bigint; ts: number; luckGainMilli: number; outcome: number[]; blessing: number; game: number; jackpot: boolean; free: boolean }
/** a BTC bet that has not been settled yet */
export interface BtcSlotState { epoch: bigint; wager: bigint; seq: bigint; payoutBps: number; side: number }
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
  const realm = r.u8(), tourFlags = r.u8(), flags = r.u8(); r.skip(5); const name = r.text(16), avatar = r.text(24); const campaigns = r.raw(32), machinePlays = [0, 1, 2].map(() => ({ machineId: r.u32(), plays: r.u32() })); const p0 = r.o, pendingActive = d[p0 + 75] !== 0;
  const pSeq = r.u64(), pWager = r.u64(); r.skip(16); const placedTs = r.i64(), clientSeed = r.raw(32); const pending = pendingActive ? { seq: pSeq, wager: pWager, placedTs, clientSeed, game: d[p0 + 72], pick: d[p0 + 73], plot: d[p0 + 74] } : null;
  r.o = p0 + 80; const hSeq = r.u64(), stake = r.u64(), original = r.u64(); r.u64(); const lastTs = r.i64(), used = r.u64(), pc = [...r.raw(12)], dc = [...r.raw(12)], np = r.u8(), nd = r.u8(), stage = r.u8(), dbl = r.u8(), awaiting = r.u8();
  const hand: HandState | null = hSeq ? { seq: hSeq, stake, original, lastTs, used, player: pc.slice(0, np), dealer: dc.slice(0, nd), over: stage === 0, dealing: stage === 1, doubled: dbl !== 0, awaiting } : null;
  r.o = p0 + 160; const btc: BtcSlotState[] = []; for (let i = 0; i < 8; i++) { const epoch = r.u64(), wager = r.u64(), seq = r.u64(), payoutBps = r.u16(); r.u16(); const side = r.u8(), st = r.u8(); r.skip(2); if (st) btc.push({ epoch, wager, seq, payoutBps, side }); }
  r.o = p0 + 80 + 80 + 256; const recent: BetResultState[] = [];
  for (let i = 0; i < 8; i++) { const seq = r.u64(), wager = r.u64(), payout = r.u64(), ts = r.u32(), luckGainMilli = r.u32(), outcome = [...r.raw(4)], blessing = r.u16() / 100, game = r.u8(), flags = r.u8(); if (seq) recent.push({ seq, wager, payout, ts, luckGainMilli, outcome, blessing, game, jackpot: !!(flags & 1), free: !!(flags & 2) }); }
  recent.sort((a, b) => (a.seq < b.seq ? 1 : -1)); const lastVrf = r.raw(32), lastVrfSeq = r.u64(), bonus = r.u64();
  return { authority, chips, credited, withdrawn, withdrawnBooked, lastUpdate, lastRealmChange, candleAt, harmonyAt, lastAlms, wagered, tithed, convertedMilli, faithEarnedMilli, betSeq, luckMilli, faithMilli, questsClaimed, spins, flips, dice, roulette, blackjack, candles, timeouts, commits, realm, tourFlags, welcomeClaimed: !!(flags & 1), plotGate: !!(flags & 2), name, avatar, pendingActive, pending, hand, btc, recent, lastVrf, lastVrfSeq, bonus, campaigns, machinePlays };
}
export interface PurseState { owner: string; deposited: bigint; paidOut: bigint; lastDepositTs: number }
export function decodePurse(d: Uint8Array): PurseState | null { if (d.length < 60 || !has(d, 'Purse')) return null; const r = new Reader(d); return { owner: r.key(), deposited: r.u64(), paidOut: r.u64(), lastDepositTs: r.i64() }; }
export interface BankState { totalDeposited: bigint; totalPaid: bigint }
export function decodeBank(d: Uint8Array): BankState | null { if (!has(d, 'Bank')) return null; const r = new Reader(d); return { totalDeposited: r.u64(), totalPaid: r.u64() }; }
/** a Happy Hour (0) or Vigil (1); `boostBps`: a Vigil's FAITH boost (a Happy Hour doubles blessings) */
export interface EventState { started: number; ends: number; boostBps: number; active: boolean }
export interface HouseHosts { events: EventState[]; lastEventStart: number[]; eventsDay: number; eventsToday: number[]; almsDay: number; almsBase: bigint; almsSpent: bigint; topupDay: number; topupSpent: bigint; lastAgentChange: number; lastPriestChange: number; luckPerChipMilli: number; blessingCapBps: number; candleFaithMilli: number; bonusOutstanding: bigint }
export interface HouseState { vault: bigint; reserved: bigint; treasury: bigint; jackpot: bigint; machineTotal: bigint; escrowTotal: bigint; chipsOutstanding: bigint; totalCredited: bigint; totalWithdrawn: bigint; welcomePaid: bigint; maxBetChips: number; welcomeChips: number; allowedWagers: number[]; totalPlayers: bigint; paused: boolean; hosts: HouseHosts }
export function decodeHouse(d: Uint8Array): HouseState | null {
  if (!has(d, 'House')) return null; const r = new Reader(d);
  const vault = r.u64(), reserved = r.u64(), treasury = r.u64(), jackpot = r.u64(), machineTotal = r.u64(); r.u64(); const escrowTotal = r.u64(), chipsOutstanding = r.u64(); r.skip(24); const totalCredited = r.u64(), totalWithdrawn = r.u64(), welcomePaid = r.u64();
  r.skip(40); r.skip(2 * 24 + 16 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 16 * 32 + 8); const p0 = r.o; const par = (i: number) => { const n = r.v.getUint32(p0 + 4 * i, true); return n; };
  const allowedWagers: number[] = []; for (let i = 0; i < 8; i++) if (par(18 + i)) allowedWagers.push(par(18 + i)); r.o = p0 + 26 * 4; const totalPlayers = r.u64(), paused = r.u8() !== 0;
  const v = r.v, i64at = (o: number) => Number(v.getBigInt64(o, true)), u64at = (o: number) => v.getBigUint64(o, true);
  const events = [160, 184].map((o) => ({ started: i64at(o), ends: i64at(o + 8), boostBps: v.getUint32(o + 16, true), active: v.getUint32(o + 20, true) !== 0 }));
  const hosts: HouseHosts = { events, lastEventStart: [i64at(208), i64at(216)], eventsDay: i64at(224), eventsToday: [v.getUint32(232, true), v.getUint32(236, true)], almsDay: i64at(240), almsBase: u64at(248), almsSpent: u64at(256), topupDay: i64at(264), topupSpent: u64at(272), lastAgentChange: i64at(280), lastPriestChange: i64at(288), luckPerChipMilli: par(0), blessingCapBps: par(12), candleFaithMilli: par(16), bonusOutstanding: d.length >= 944 ? u64at(936) : 0n };
  return { vault, reserved, treasury, jackpot, machineTotal, escrowTotal, chipsOutstanding, totalCredited, totalWithdrawn, welcomePaid, maxBetChips: par(9), welcomeChips: par(8), allowedWagers, totalPlayers, paused, hosts };
}
// ---------------------------------------------------------------- the BTC market
export const OUTCOMES = ['expired', 'up', 'down', 'tie', 'void'] as const;
export interface RoundState { epoch: bigint; openTs: number; lockTs: number; lockedAt: number; up: bigint; down: bigint; bets: number; lockC: number }
export interface RoundRecState { epoch: number; lockC: number; closeC: number; closedTs: number; up: number; down: number; bets: number; outcome: number; lateS: number }
export interface MarketState { open: RoundState; live: RoundState | null; roundS: number; graceS: number; payoutBps: number; commits: number; wagers: number[]; closed: bigint; voided: bigint; crankTicks: bigint; keeperPrices: bigint; lastTickTs: number; lastPriceTs: number; lastPriceC: number; maxGapS: number; enabled: boolean; rounds: RoundRecState[] }
/** bytes before the ring of rounds: enough for a panel to poll */
export const MARKET_HEAD = 352, RING = 240;
/** the header alone, or the whole account (then `rounds` holds the last 4 hours, newest first) */
export function decodeMarket(d: Uint8Array): MarketState | null {
  if (d.length < MARKET_HEAD || !has(d, 'Market')) return null; const r = new Reader(d);
  const round = (): RoundState => ({ epoch: r.u64(), openTs: r.i64(), lockTs: r.i64(), lockedAt: r.i64(), up: r.u64(), down: r.u64(), bets: r.u32(), lockC: r.u32() });
  const open = round(), live = round(), roundS = r.u32(), graceS = r.u32(), payoutBps = r.u32(), commits = r.u32(), wagers = Array.from({ length: 8 }, () => r.u32()).filter(Boolean), closed = r.u64(), voided = r.u64(), crankTicks = r.u64(), keeperPrices = r.u64(), lastTickTs = r.i64(), lastPriceTs = r.i64(), lastPriceC = r.u32(), maxGapS = r.u32(), enabled = r.u8() !== 0;
  const rounds: RoundRecState[] = []; if (d.length >= MARKET_HEAD + RING * 28) { r.o = MARKET_HEAD; for (let i = 0; i < RING; i++) { const x = { epoch: r.u32(), lockC: r.u32(), closeC: r.u32(), closedTs: r.u32(), up: r.u32(), down: r.u32(), bets: r.u16(), outcome: r.u8(), lateS: r.u8() }; if (x.epoch) rounds.push(x); } rounds.sort((a, b) => b.epoch - a.epoch); }
  return { open, live: live.epoch ? live : null, roundS, graceS, payoutBps, commits, wagers, closed, voided, crankTicks, keeperPrices, lastTickTs, lastPriceTs, lastPriceC, maxGapS, enabled, rounds };
}
/** the oracle's price, as the program reads it: US cents and publish time */
export function decodeFeed(d: Uint8Array): { cents: number; at: number } | null { if (d.length < 101) return null; const v = new DataView(d.buffer, d.byteOffset, d.byteLength), p = v.getBigInt64(73, true); return p > 0n ? { cents: Number((p + 500_000n) / 1_000_000n), at: Number(v.getBigInt64(93, true)) } : null; }

// ---------------------------------------------------------------- Founders' Row and the Quest Board
export interface MachineState { plot: number; id: number; owner: string; name: string; skin: number; bankroll: bigint; reserved: bigint; plays: number; earned: number }
export function decodePlots(d: Uint8Array): MachineState[] | null {
  if (!has(d, 'Plots')) return null; const r = new Reader(d), out: MachineState[] = [];
  for (let i = 0; i < 3; i++) { const owner = r.key(), bankroll = r.u64(), reserved = r.u64(), plays = Number(r.u64()), earned = r.i64(), name = r.text(16), id = r.u32(), skin = r.u8(); r.skip(3); if (id) out.push({ plot: i + 1, id, owner, name, skin, bankroll, reserved, plays, earned }); }
  return out;
}
export interface CampaignState { id: number; creator: string; budget: bigint; created: number; machineId: number; goal: number; rewardChips: number; rewardFaithMilli: number; maxClaims: number; claims: number; kind: number; active: boolean; fromTreasury: boolean; title: string; url: string }
export function decodeBoard(d: Uint8Array): CampaignState[] | null {
  if (!has(d, 'Board')) return null; const r = new Reader(d), out: CampaignState[] = [];
  for (let i = 0; i < 20; i++) { const start = r.o; const creator = r.key(), budget = r.u64(), created = r.i64(), id = r.u32(), machineId = r.u32(), goal = r.u32(), rewardChips = r.u32(), rewardFaithMilli = r.u32(), maxClaims = r.u32(), claims = r.u32(), kind = r.u8(), active = r.u8() !== 0, fromTreasury = r.u8() !== 0, tl = r.u8(), ul = r.u8(); r.skip(3); const title = new TextDecoder().decode(r.raw(60).subarray(0, tl)), url = new TextDecoder().decode(r.raw(160).subarray(0, ul)); r.o = start + 304; if (created) out.push({ id, creator, budget, created, machineId, goal, rewardChips, rewardFaithMilli, maxClaims, claims, kind, active, fromTreasury, title, url }); }
  return out;
}
export const hasClaimed = (p: Pick<PlayerState, 'campaigns'>, id: number) => !!(p.campaigns[id >> 3] >> (id & 7) & 1);

// ---------------------------------------------------------------- events ("Program data: ..." in the logs)
export interface SettledEvent { wallet: string; seq: bigint; game: number; pick: number; wager: bigint; payout: bigint; blessing: bigint; luckGainMilli: number; outcome: number[]; jackpot: boolean; randomness: Uint8Array }
export function settledFromLogs(logs: string[], decode64: (s: string) => Uint8Array): SettledEvent[] {
  const out: SettledEvent[] = [], disc = IDL.events.BetSettled as readonly number[];
  for (const l of logs) { if (!l.startsWith('Program data: ')) continue; let d: Uint8Array; try { d = decode64(l.slice(14).trim()); } catch { continue; } if (d.length < 8 + 32 + 8 + 2 + 24 + 4 + 4 + 1 + 32 || !disc.every((b, i) => d[i] === b)) continue;
    const r = new Reader(d); out.push({ wallet: r.key(), seq: r.u64(), game: r.u8(), pick: r.u8(), wager: r.u64(), payout: r.u64(), blessing: r.u64(), luckGainMilli: r.u32(), outcome: [...r.raw(4)], jackpot: r.u8() !== 0, randomness: r.raw(32) }); }
  return out;
}
const events = (logs: string[], decode64: (s: string) => Uint8Array, name: keyof typeof IDL.events, min: number) => { const disc = IDL.events[name] as readonly number[], out: Reader[] = []; for (const l of logs) { if (!l.startsWith('Program data: ')) continue; try { const d = decode64(l.slice(14).trim()); if (d.length >= 8 + min && disc.every((b, i) => d[i] === b)) out.push(new Reader(d)); } catch { /* not ours */ } } return out; };
export interface MarketBetEvent { wallet: string; seq: bigint; epoch: bigint; side: number; wager: bigint }
export const marketBetsFromLogs = (logs: string[], d64: (s: string) => Uint8Array): MarketBetEvent[] => events(logs, d64, 'MarketBetPlaced', 57).map((r) => ({ wallet: r.key(), seq: r.u64(), epoch: r.u64(), side: r.u8(), wager: r.u64() }));
export interface MarketSettledEvent { wallet: string; seq: bigint; epoch: bigint; side: number; outcome: number; wager: bigint; payout: bigint; blessing: bigint; luckGainMilli: number; lockC: number; closeC: number }
export const marketSettledFromLogs = (logs: string[], d64: (s: string) => Uint8Array): MarketSettledEvent[] => events(logs, d64, 'MarketSettled', 86).map((r) => ({ wallet: r.key(), seq: r.u64(), epoch: r.u64(), side: r.u8(), outcome: r.u8(), wager: r.u64(), payout: r.u64(), blessing: r.u64(), luckGainMilli: r.u32(), lockC: r.u32(), closeC: r.u32() }));
export interface RoundClosedEvent { epoch: bigint; outcome: number; lockC: number; closeC: number; closedTs: number; up: number; down: number; bets: number }
export const roundsFromLogs = (logs: string[], d64: (s: string) => Uint8Array): RoundClosedEvent[] => events(logs, d64, 'RoundClosed', 31).map((r) => ({ epoch: r.u64(), outcome: r.u8(), lockC: r.u32(), closeC: r.u32(), closedTs: r.u32(), up: r.u32(), down: r.u32(), bets: r.u16() }));
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
