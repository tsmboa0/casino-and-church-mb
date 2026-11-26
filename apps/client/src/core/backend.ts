import { CAMPAIGN_LIMITS, campaignCost, campaignProblem, type NewCampaign } from '@cnc/shared';
import { store, type Plot, type HistRow } from './state';
import { bus } from './bus';
import {
  PARAMS, CHIPS_PER_SOL, QUESTS, PLOT_GATE, PLOT_MIN_BANKROLL, WHEEL_PRIZES, HARMONY_PRIZES, COIN_PAY_BPS,
  randomDraws, resolveSlots, resolveCoin, resolveDice, resolveRoulette, pickWeighted, cardName, handTotal, tenOrAce, blackjackPayout,
  withBlessing, luckForBet, faithForTithe, blessingOf,
} from './rules';

/**
 * THE INTEGRATION SEAM (BACKEND_PLAN.md §3).
 * Every panel talks to `backend`, never to the store directly. `MockBackend` runs the same rules locally;
 * `ChainBackend` (to be written) implements the same interface against the `realm` contract. Every call
 * resolves with the authoritative result; the store is refreshed from the returned player snapshot.
 */
import { BackendError } from './errors';
import { faqAnswer, HOST_REFUSAL } from '@cnc/shared';
export { BackendError };

export type Game = 'slots' | 'coinflip' | 'dice' | 'roulette' | 'blackjack';
export interface BetReq { game: Game; wager: number; pick?: number; machineId?: number }
export interface BetResult {
  betId: number; game: Game; wager: number; payout: number; net: number; blessing: number; luckGain: number;
  outcome: { reels?: string[]; side?: 'H' | 'T'; dice?: [number, number]; n?: number; color?: string };
  proof?: BetProof;   // chain mode only
}
/** what a player needs to check a bet: its number and the randomness that settled it */
export interface BetProof { seq: string; randomness: string; clientSeed: string; placeTx: string }
export interface BetCheck { /** how many random numbers the bet used (a blackjack hand uses one per action) */ answers?: number; found: boolean; tx: string | null; randomness: string; fromVrf: boolean; recomputed: string; recorded: string; matches: boolean }
/** the wheels pay bonus chips; the jackpot is real */
export interface WheelResult { prize: number | 'JACKPOT'; chips: number; proof?: BetProof }
/** a blackjack hand as the panel draws it (chain: built from get_blackjack + the settled result) */
export interface BjState {
  betId: number; stage: 'player' | 'done'; player: string[]; dealer: string[];
  playerTotal: number; dealerTotal: number; soft: boolean; doubled: boolean; stake: number; canDouble: boolean;
  result?: { label: 'natural' | 'win' | 'push' | 'lose'; payout: number; blessing: number; proof?: BetProof };
}
// ---- the two AI hosts (BACKEND_PLAN.md R3-6) ----
export type AgentId = 'fortuna' | 'nakamoto';
export interface CampaignRow {
  id: number; kind: number; creator: string; title: string; url: string; machineId: number; goal: number;
  rewardChips: number; rewardFaith: number; maxClaims: number; claims: number; active: boolean; claimed: boolean; progress: number; mine: boolean;
  /** the Church pays: bonus chips. `refund`: chips left in a closed one */
  free?: boolean; refund?: number;
}
export interface AgentProof { model: string; chatId: string; signedText: string; signature: string; signingAddress: string;
  signatureKind: 'provider_tee' | 'gateway'; requestB64: string; responseB64: string; attestedSigner: string; attestationAt: number; txHash?: string; /** Solana: the L1 record */ anchorTx?: string }
export interface AgentDecision { id: string; agent: AgentId; at: number; action: string; params: Record<string, number | string>;
  line: string; applied: boolean; reason?: string; txHash?: string; anchorTx?: string; proof?: AgentProof; policy?: 'llm' | 'rules' }
/** one line of a verification, checked in the browser */
export interface HostCheck { label: string; ok: boolean; detail: string }
export interface RealmEvent { kind: 'happy_hour' | 'vigil'; realm: 'casino' | 'church'; endsAt: number; boostBps: number; by: AgentId }
export interface HouseStats { playersOnline: number; inCasino: number; inChurch: number; inPlaza: number; volume24h: number; houseNet24h: number;
  vault: number; vaultFree: number; jackpot: number; maxBet: number; luckPerChipMilli: number; edgeRealized24h: number; edgeExpected: number;
  biggestWin24h: { name: string; chips: number; game: string } | null; timeouts24h: number }
export interface ChurchStats { treasury: number; tithes24h: number; candles24h: number; alms24h: number; blessingsPaid24h: number;
  blessingCapBps: number; candleFaithMilli: number; faithfulOnline: number }
export interface LbRow { rank: number; name: string; wagered: number; net: number; you?: boolean }
// ---- the BTC UP/DOWN market: one-minute rounds, run by a crank and priced by an oracle on the rollup (onchain market.rs) ----
export type MarketSide = 'up' | 'down';
export type MarketOutcome = '' | 'up' | 'down' | 'tie' | 'void';
export interface MarketRound {
  epoch: number; phase: 'open' | 'live' | 'closed' | 'void';
  /** ms, chain clock */
  openAt: number; lockAt: number; lockedAt: number; closedAt: number;
  /** USD, null until priced */
  lockPrice: number | null; closePrice: number | null;
  up: number; down: number; bets: number; outcome: MarketOutcome;
}
export interface MarketCrowdBet { betId: number; who: string; side: MarketSide; chips: number; mine: boolean }
export interface MarketState {
  enabled: boolean; epoch: number; pending: boolean; roundS: number; graceS: number;
  /** total paid on a win, stake included (1.9 = stake x 1.9) */
  payout: number; wagers: number[];
  open: MarketRound | null; live: MarketRound | null; recent: MarketRound[];
  /** bets in the open and live rounds, by epoch */
  crowd: Record<number, MarketCrowdBet[]>;
  /** BTC/USD spot for the chart (an exchange feed; the result is the oracle's price), and its recent history */
  price: number | null; history: [number, number][];
  /** the last price the oracle delivered on chain */
  oraclePrice: number | null; oracleAt: number;
  /** add to Date.now() to get the chain clock */
  skew: number;
  /** who prices it, for the footer */
  oracle: string;
}
export interface MarketResult {
  betId: number; side: MarketSide; outcome: Exclude<MarketOutcome, ''>; wager: number; payout: number; blessing: number;
  lockPrice: number | null; closePrice: number | null; luckGain: number; epoch?: number; roundTx?: string;
}
/** a finished round for the PAST ROUNDS list. `tx`: the transaction that closed it; `page`: the record on Solana L1 */
export interface PastRound { epoch: number; outcome: Exclude<MarketOutcome, ''>; lock: number; close: number; closedAt: number; up: number; down: number; bets: number; tx: string | null; page: string | null }
export interface Backend {
  readonly mode: 'mock' | 'chain';
  placeBet(r: BetReq): Promise<BetResult>;                       // resolves when the bet is SETTLED (reveal done)
  spinWheel(): Promise<WheelResult>;                             // needs LUCK 100
  spinHarmony(): Promise<WheelResult>;                           // needs LUCK >= 50 and FAITH >= 50, cooldown
  tithe(chips: number): Promise<{ faithGain: number }>;
  offerLuck(luck: number): Promise<{ faithGain: number }>;
  lightCandle(): Promise<void>;
  claimQuest(id: string): Promise<void>;
  deposit(sol: number): Promise<void>;                           // chain: one popup, the SOL goes to the Bank on L1
  withdraw(chips: number): Promise<void>;
  faucet(): Promise<number | void>;                              // chain: server funds the account; resolves with the NEAR paid
  enterRealm(realm: 'casino' | 'church' | 'plaza'): Promise<void>;
  claimPlot(id: number, name: string, skin: string, bankroll: number): Promise<Plot>;
  fundMachine(id: number, chips: number): Promise<void>;
  withdrawMachine(id: number, chips: number): Promise<void>;
  /** OPTIONAL: take your machine off the plot; its bankroll comes back */
  releasePlot?(id: number): Promise<void>;
  /** OPTIONAL: read the plots again (bankrolls change with every spin) */
  plotsNow?(): Promise<void>;
  /** OPTIONAL blackjack (contract: place_bet("blackjack") then blackjack_act). Resolves once the opening cards are shown
   *  (stage 'player'), or 'done' straight away on a natural. */
  blackjackDeal?(wager: number): Promise<BjState>;
  /** OPTIONAL: a hand left open (a reload, another device): the panel picks it up again */
  blackjackOpen?(): Promise<BjState | null>;
  /** hit keeps stage 'player' unless it busts or makes 21; stand/double resolve only after the dealer has finished (stage 'done') */
  blackjackAct?(betId: number, action: 'hit' | 'stand' | 'double'): Promise<BjState>;
  /** OPTIONAL: the AI hosts (R3-6). The mock simulates them with the rule policy, unsigned. */
  agentFeed?(agent: AgentId | 'all', limit?: number): Promise<AgentDecision[]>;
  /** OPTIONAL: talk to a host. Only game questions are answered; anything else gets an in-character refusal (relevant=false).
   *  Chain: POST /agent/ask (R3-9). The answer can carry the same signed proof as a decision. */
  askHost?(agent: AgentId, question: string): Promise<{ answer: string; relevant: boolean; proof?: AgentProof }>;
  agentProof?(id: string): Promise<AgentProof>;
  activeEvents?(): Promise<RealmEvent[]>;
  houseStats?(): Promise<HouseStats>;
  /** OPTIONAL (Solana): the decision was written on L1, with this proof, before it acted */
  checkAnchor?(d: AgentDecision): Promise<HostCheck>;
  /** link to an L1 transaction */
  l1Url?(sig: string): string;
  churchStats?(): Promise<ChurchStats>;
  /** OPTIONAL: relayed set_profile / complete_tour (the client calls them fire-and-forget) */
  setProfile?(name: string, avatar: string): Promise<void>;
  /** OPTIONAL (usernames are unique, held by the server): is this name free for me? */
  checkName?(name: string): Promise<{ available: boolean; reason?: string }>;
  /** OPTIONAL: Church campaigns (the open Mission Board). Social/project tasks are attested by the Church oracle. */
  campaigns?(): Promise<CampaignRow[]>;
  startCampaign?(id: number): Promise<{ visitS: number }>;
  claimCampaign?(id: number): Promise<{ chips: number; faith: number }>;
  createCampaign?(c: NewCampaign): Promise<number>;
  closeCampaign?(id: number): Promise<void>;
  /** OPTIONAL (chain mode): username + password accounts. The password never leaves the device. */
  signUp?(username: string, password: string): Promise<void>;
  signIn?(username: string, password: string): Promise<{ username: string; avatar: string; toursDone: { casino: boolean; church: boolean } }>;
  signOut?(): void;
  /** the username signed in on this device, if any */
  linkedAccount?(): string | null;
  /** a wallet already lives on this device (e.g. a guest from before accounts existed) */
  hasDeviceWallet?(): boolean;
  /** OPTIONAL (Solana): after Privy signs in, what this wallet still needs; `setup` is one popup */
  attach?(wallet: string): Promise<{ ready: boolean; isNew: boolean; name: string | null; avatar: string | null }>;
  setup?(step?: (text: string) => void): Promise<void>;
  saveName?(name: string, avatar: string): Promise<void>;
  toursDone?(): { casino: boolean; church: boolean };
  /** OPTIONAL (Solana): re-checks a settled bet from the chain, in the browser */
  verifyBet?(p: BetProof): Promise<BetCheck>;
  /** link to a transaction */
  txUrl?(sig: string): string;
  /** OPTIONAL: re-read balances from the chain before acting on them */
  sync?(): Promise<void>;
  /** OPTIONAL: this device's guest wallet (chain mode) */
  wallet?(): Promise<{ accountId: string; encrypted: boolean }>;
  completeTour?(realm: 'casino' | 'church'): Promise<void>;
  /** OPTIONAL (added 10 Nov for the cashier tabs): the player's last plays, newest first. Chain: GET /bets?account= */
  history?(): Promise<HistRow[]>;
  /** OPTIONAL: top players by chips wagered. Chain: GET /leaderboard. */
  leaderboard?(): Promise<{ rows: LbRow[]; demo: boolean }>;
  /** OPTIONAL: the BTC UP/DOWN market. Chain: GET /market (the server's shared snapshot) */
  market?(): Promise<MarketState>;
  /** bet on the OPEN round `epoch`; resolves once the bet is on chain (the result comes when the round closes) */
  marketBet?(epoch: number, side: MarketSide, chips: number): Promise<{ betId: number; tx?: string }>;
  /** finished rounds, newest first; `before` an epoch for older ones */
  pastRounds?(before?: number): Promise<PastRound[]>;

  /** a settled market bet, or null while its round is still running */
  marketResult?(betId: number): Promise<MarketResult | null>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const fail = (code: string, msg: string): never => { throw new BackendError(code, msg); };

class MockBackend implements Backend {
  readonly mode = 'mock' as const;
  private timer = window.setInterval(() => { this.settle(); this.agentTick(); }, 4000);
  stop() { window.clearInterval(this.timer); }

  /** lazy decay, exactly as the contract does it: only the meter of the realm you are NOT in decays */
  private settle() {
    const s = store.stats, now = Date.now();
    const dt = Math.min((now - s.settledAt) / 1000, PARAMS.maxDecayWindowS); s.settledAt = now;
    const d = (dt / 60) * (PARAMS.decayPerMinMilli / 1000);
    if (d > 0) {
      if (store.realm === 'casino') store.eco.faith = Math.max(0, store.eco.faith - d);
      else if (store.realm === 'church') store.eco.luck = Math.max(0, store.eco.luck - d);
      store.saveEco(); store.emit();
    }
  }
  private log(game: string, wager: number, payout: number, detail: string) {
    const s = store.stats; s.net += payout - wager;
    s.history.unshift({ t: Date.now(), game, wager, payout, detail }); s.history.length = Math.min(s.history.length, 40); store.saveEco();
  }
  private faith(n: number) { store.change({ faith: n }); if (n > 0) store.stats.faithEarned += n; }

  async placeBet(r: BetReq): Promise<BetResult> {
    this.settle();
    const e = store.eco, s = store.stats;
    if (r.game === 'blackjack') fail('not_allowed', 'The blackjack table is closed in the demo.');
    if (!PARAMS.quoteBets.includes(r.wager) && r.game !== 'roulette') fail('bad_wager', 'Pick one of the listed bets.');
    if (r.wager < 1 || e.chips + e.bonus < r.wager) fail('no_chips', 'Not enough chips. Visit the Cashier.');
    const free = Math.min(e.bonus, r.wager), real = r.wager - free;
    const draws = randomDraws(), betId = s.nextBet++;
    let base = 0, outcome: BetResult['outcome'] = {};
    if (r.game === 'slots') { const o = resolveSlots(draws); base = r.wager * o.payX; outcome = { reels: o.reels }; s.spins++; }
    else if (r.game === 'coinflip') { const side = resolveCoin(draws); outcome = { side }; if ((r.pick === 0 ? 'H' : 'T') === side) base = (r.wager * COIN_PAY_BPS) / 10000; s.flips++; }
    else if (r.game === 'dice') { const o = resolveDice(draws, r.pick ?? 0); base = (r.wager * o.payBps) / 10000; outcome = { dice: o.dice }; s.dice++; }
    else { const o = resolveRoulette(draws, r.pick ?? 100); base = r.wager * o.payX; outcome = { n: o.n, color: o.color }; s.roulette++; }
    // a returned stake is not a win: the free part comes back free
    const back = base > r.wager ? 0 : Math.min(base, free), blessed = base - back > 0 ? back + withBlessing(base - back, e.faith) : base;
    const luckGain = luckForBet(real, r.game) * this.boost('casino');
    s.wagered += r.wager;
    s.pool += (r.wager * PARAMS.treasuryBpsOfWager) / 10000; s.jackpot += (r.wager * PARAMS.jackpotBpsOfWager) / 10000;
    store.change({ chips: -real + blessed - back, bonus: back - free, luck: luckGain });
    const o = outcome, detail = o.reels ? o.reels.map(x => x.toUpperCase()).join(' ') : o.side ? (o.side === 'H' ? 'HEADS' : 'TAILS') : o.dice ? `${o.dice[0]} + ${o.dice[1]} = ${o.dice[0] + o.dice[1]}` : `${o.n} ${String(o.color).toUpperCase()}`;
    this.log(r.game, r.wager, blessed, detail);
    await sleep(350);                                               // stands in for commit -> reveal latency
    return { betId, game: r.game, wager: r.wager, payout: blessed, net: blessed - r.wager, blessing: blessed - base, luckGain, outcome };
  }

  async spinWheel(): Promise<WheelResult> {
    this.settle(); if (store.eco.luck < 100) fail('luck', 'Your LUCK must be full (100).');
    const prize = pickWeighted(WHEEL_PRIZES, randomDraws()[0]);
    store.change({ luck: -100, bonus: prize }); this.log('wheel', 0, prize, `WHEEL ${prize}`); await sleep(250); return { prize, chips: prize };
  }
  async spinHarmony(): Promise<WheelResult> {
    this.settle(); const e = store.eco, s = store.stats;
    if (e.luck < 50 || e.faith < 50) fail('harmony', 'Harmony needs 50 LUCK and 50 FAITH.');
    const wait = s.harmonyAt + PARAMS.harmonyCooldownS * 1000 - Date.now();
    if (wait > 0) fail('cooldown', `The wheel rests for ${Math.ceil(wait / 1000)}s.`);
    const prize = pickWeighted(HARMONY_PRIZES, randomDraws()[0]);
    const chips = prize === 'JACKPOT' ? Math.floor(s.jackpot) : prize;
    if (prize === 'JACKPOT') s.jackpot -= chips;
    s.harmonyAt = Date.now(); store.change({ luck: -PARAMS.harmonyCostMilli / 1000, faith: -PARAMS.harmonyCostMilli / 1000, ...(prize === 'JACKPOT' ? { chips } : { bonus: chips }) });
    this.log('harmony', 0, chips, prize === 'JACKPOT' ? 'JACKPOT' : `HARMONY ${chips}`);
    await sleep(250); return { prize, chips };
  }
  async tithe(chips: number) {
    this.settle(); if (chips < 10) fail('min', 'The minimum tithe is 10 chips.'); if (store.eco.chips < chips) fail('no_chips', 'Not enough chips.');
    const g = faithForTithe(chips, store.eco.faith) * this.boost('church');
    store.stats.tithed += chips; store.stats.pool += chips; store.change({ chips: -chips }); this.faith(g); return { faithGain: g };
  }
  async offerLuck(luck: number) {
    this.settle(); if (luck < 1 || store.eco.luck < luck) fail('luck', 'Not enough LUCK to offer.');
    const g = (luck * PARAMS.offerRatioBps) / 10000; store.stats.converted += luck; store.change({ luck: -luck }); this.faith(g); return { faithGain: g };
  }
  async lightCandle() {
    this.settle(); const wait = store.stats.candleAt + PARAMS.candleCooldownS * 1000 - Date.now();
    if (wait > 0) fail('cooldown', `Wait ${Math.ceil(wait / 1000)}s.`);
    store.stats.candles++; store.stats.candleAt = Date.now(); this.faith((PARAMS.candleFaithMilli / 1000) * this.boost('church'));
  }
  async claimQuest(id: string) {
    const q = QUESTS.find((x) => x.id === id); if (!q) return fail('quest', 'Unknown quest.');
    if (store.stats.claimed[id]) fail('claimed', 'Already claimed.');
    if (store.stats[q.counter] < q.goal) fail('progress', 'Not finished yet.');
    store.stats.claimed[id] = true;
    store.change({ bonus: q.reward.chips ?? 0, luck: q.reward.luck ?? 0 }); if (q.reward.faith) this.faith(q.reward.faith);
  }
  async deposit(sol: number) {
    if (sol <= 0 || store.eco.sol < sol) fail('no_sol', 'Not enough test SOL. Use the faucet.');
    store.eco.sol = Math.max(0, store.eco.sol - sol); store.change({ chips: Math.round(sol * CHIPS_PER_SOL) });
  }
  async withdraw(chips: number) {
    const n = Math.floor(Math.min(chips, store.eco.chips)); if (n < 1) fail('min', 'You have no chips to cash out.');
    store.eco.sol += n / CHIPS_PER_SOL; store.change({ chips: -n });
  }
  async faucet() { store.eco.sol += 0.05; store.change({}); return 0.05; }
  async enterRealm() { this.settle(); }

  async claimPlot(id: number, name: string, skin: string, bankroll: number): Promise<Plot> {
    const s = store.stats; name = name.replace(/[^\w '\-]/g, '').trim().slice(0, 16);
    if (store.plots[id]) fail('taken', 'That plot is already owned.');
    if (name.length < 3) fail('name', 'Give the machine a name (3-16 letters).');
    if (s.wagered < PLOT_GATE.wagered || s.faithEarned < PLOT_GATE.faithEarned) fail('gate', `Earn your standing first: wager ${PLOT_GATE.wagered} chips (${Math.floor(s.wagered)} so far) and earn ${PLOT_GATE.faithEarned} FAITH (${Math.floor(s.faithEarned)} so far).`);
    if (bankroll < PLOT_MIN_BANKROLL) fail('bankroll', `The machine needs at least ${PLOT_MIN_BANKROLL} chips of bankroll.`);
    if (store.eco.chips < bankroll) fail('no_chips', 'Not enough chips for that bankroll.');
    store.change({ chips: -bankroll });
    const p: Plot = { id, owner: store.profile?.username ?? 'you', name, skin, bankroll, plays: 0, earned: 0, deed: `deed:machine:${id}` };
    store.plots[id] = p; store.saveEco(); store.emit(); bus.emit('plotsChanged'); return p;
  }
  // ---- blackjack (one deck, dealer stands on all 17s, natural pays 3:2, double on two cards, no split)
  private bj: { id: number; deck: number[]; player: number[]; dealer: number[]; original: number; stake: number; doubled: boolean } | null = null;
  private bjView(done?: BjState['result']): BjState {
    const h = this.bj!, p = handTotal(h.player), d = handTotal(h.dealer);
    return { betId: h.id, stage: done ? 'done' : 'player', player: h.player.map(cardName), dealer: h.dealer.map(cardName), playerTotal: p.total, dealerTotal: d.total, soft: p.soft, doubled: h.doubled, stake: h.stake, canDouble: !done && h.player.length === 2 && !h.doubled && store.eco.chips >= h.original, result: done };
  }
  private bjFinish(dealerPlays: boolean): BjState {
    const h = this.bj!;
    if (dealerPlays) while (handTotal(h.dealer).total < 17) h.dealer.push(h.deck.pop()!);
    const r = blackjackPayout(h.player, h.dealer, h.original, h.stake);
    const paid = r.label === 'win' || r.label === 'natural' ? withBlessing(r.pay, store.eco.faith) : r.pay;
    const s = store.stats; s.wagered += h.stake; s.pool += (h.stake * PARAMS.treasuryBpsOfWager) / 10000; s.jackpot += (h.stake * PARAMS.jackpotBpsOfWager) / 10000;
    store.change({ chips: paid, luck: luckForBet(h.stake, 'blackjack') });
    this.log('blackjack', h.stake, paid, `${h.player.map(cardName).join(' ')} v ${h.dealer.map(cardName).join(' ')}`);
    const v = this.bjView({ label: r.label, payout: paid, blessing: paid - r.pay }); this.bj = null; return v;
  }
  async blackjackDeal(wager: number): Promise<BjState> {
    this.settle();
    if (this.bj) fail('busy', 'Finish the hand on the table first.');
    if (!PARAMS.quoteBets.includes(wager)) fail('bad_wager', 'Pick one of the listed bets.');
    if (store.eco.chips < wager) fail('no_chips', 'Not enough chips. Visit the Cashier.');
    const deck = Array.from({ length: 52 }, (_, i) => i), rnd = new Uint32Array(52); crypto.getRandomValues(rnd);
    for (let i = 51; i > 0; i--) { const j = rnd[i] % (i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    store.change({ chips: -wager });
    const h = { id: store.stats.nextBet++, deck, player: [] as number[], dealer: [] as number[], original: wager, stake: wager, doubled: false };
    h.player.push(deck.pop()!); h.dealer.push(deck.pop()!); h.player.push(deck.pop()!);   // player, upcard, player (no hole card yet)
    this.bj = h; await sleep(300);
    if (handTotal(h.player).total === 21) {                         // natural: paid now unless the upcard could also make one
      if (tenOrAce(h.dealer[0])) h.dealer.push(deck.pop()!);
      return this.bjFinish(false);
    }
    return this.bjView();
  }
  async blackjackAct(betId: number, action: 'hit' | 'stand' | 'double'): Promise<BjState> {
    const h = this.bj; if (!h || h.id !== betId) return fail('unknown_bet', 'That hand is over.');
    await sleep(250);
    if (action === 'double') {
      if (h.player.length !== 2 || h.doubled) fail('not_allowed', 'You can only double on your first two cards.');
      if (store.eco.chips < h.original) fail('no_chips', 'Not enough chips to double.');
      store.change({ chips: -h.original }); h.stake += h.original; h.doubled = true; h.player.push(h.deck.pop()!);
      return this.bjFinish(handTotal(h.player).total <= 21);
    }
    if (action === 'hit') {
      h.player.push(h.deck.pop()!);
      const t = handTotal(h.player).total;
      if (t > 21) return this.bjFinish(false);
      if (t === 21) return this.bjFinish(true);
      return this.bjView();
    }
    return this.bjFinish(true);
  }

  // ---- the AI hosts, simulated offline with the same rule policy the server falls back to (unsigned) ----
  private feed: AgentDecision[] = [];
  private events: RealmEvent[] = [];
  private lastEventAt: Record<'casino' | 'church', number> = { casino: 0, church: 0 };
  private nextDecisionAt = Date.now() + 25000;
  private turn: AgentId = 'fortuna';
  private boost(realm: 'casino' | 'church') { const e = this.events.find(x => x.realm === realm && x.endsAt > Date.now()); return e ? 1 + e.boostBps / 10000 : 1; }
  private agentTick() {
    const now = Date.now();
    const before = this.events.length; this.events = this.events.filter(e => e.endsAt > now);
    if (this.events.length !== before) bus.emit('eventsChanged');
    if (now < this.nextDecisionAt) return;
    this.nextDecisionAt = now + 75000;                               // demo cadence; the server decides every 10 minutes
    const a = this.turn; this.turn = a === 'fortuna' ? 'nakamoto' : 'fortuna';
    const realm = a === 'fortuna' ? 'casino' : 'church';
    const quietSince = now - this.lastEventAt[realm];
    const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
    let d: AgentDecision;
    const id = `demo-${now}`;
    if (!this.events.some(e => e.realm === realm) && quietSince > 4 * 60000 && Math.random() < 0.65) {
      const minutes = 3, boostBps = pick([2000, 2500, 3000]);         // demo: short events so a judge sees one start and end
      this.events.push({ kind: a === 'fortuna' ? 'happy_hour' : 'vigil', realm, endsAt: now + minutes * 60000, boostBps, by: a });
      this.lastEventAt[realm] = now; bus.emit('eventsChanged');
      d = { id, agent: a, at: now, action: a === 'fortuna' ? 'start_happy_hour' : 'start_vigil', params: { minutes, boost_pct: boostBps / 100 }, applied: true,
        line: a === 'fortuna' ? pick(['The floor is too quiet. Happy Hour: every bet fills your LUCK faster.', 'The Father has his candles. I have Happy Hour. Choose wisely.', 'Empty tables make me nervous. LUCK is cheap for the next few minutes.'])
                              : pick(['The dice are loud tonight. A Vigil, children: every candle counts double.', 'Don Fortuna lit his neon. We light candles. Come, the Vigil has begun.', 'A quiet hour for the soul. Tithes and candles grow FAITH faster during the Vigil.']) };
    } else if (a === 'nakamoto' && store.eco.chips < 50 && !store.stats.claimed['alms-today']) {
      store.stats.claimed['alms-today'] = true; store.change({ chips: 30 });
      d = { id, agent: a, at: now, action: 'grant_alms', params: { chips: 30 }, applied: true, line: 'A weary pilgrim came to us with empty pockets. The Church gave 30 chips. Spend them wisely.' };
    } else {
      d = { id, agent: a, at: now, action: 'none', params: {}, applied: true,
        line: a === 'fortuna' ? pick(['The vault is healthy. The house keeps its rules today.', 'Steady night. I watch the screens, you watch the reels.', 'No changes. A good casino is a predictable casino.'])
                              : pick(['The treasury is steady. Blessings flow as promised.', 'Nothing to change tonight. The candles burn on their own.', 'Peace at the altar. The Church keeps its course.']) };
    }
    this.feed.unshift(d); this.feed.length = Math.min(this.feed.length, 30);
    bus.emit('agentDecision', d);
  }
  /** offline: a small in-character FAQ. The server uses NEAR AI with a relevance gate (BACKEND_PLAN R3-9). */
  async askHost(agent: AgentId, question: string) {
    await sleep(500 + Math.random() * 500);
    const hit = faqAnswer(agent, question);
    return hit ? { answer: hit, relevant: true } : { answer: HOST_REFUSAL[agent], relevant: false };
  }
  async agentFeed(agent: AgentId | 'all', limit = 20) { return this.feed.filter(d => agent === 'all' || d.agent === agent).slice(0, limit); }
  async activeEvents() { const now = Date.now(); return this.events.filter(e => e.endsAt > now); }
  async houseStats(): Promise<HouseStats> {
    const day = Date.now() - 86400000, h = store.stats.history.filter(x => x.t > day && x.wager > 0);
    const vol = h.reduce((a, x) => a + x.wager, 0), net = h.reduce((a, x) => a + x.wager - x.payout, 0);
    const best = store.stats.history.filter(x => x.t > day).sort((a, b) => b.payout - a.payout)[0];
    return { playersOnline: 1, inCasino: store.realm === 'casino' ? 1 : 0, inChurch: store.realm === 'church' ? 1 : 0, inPlaza: store.realm === 'plaza' ? 1 : 0,
      volume24h: vol, houseNet24h: net, vault: 40000 + net, vaultFree: 38000 + net, jackpot: Math.floor(store.stats.jackpot), maxBet: 100, luckPerChipMilli: PARAMS.luckPerChipMilli * this.boost('casino'),
      edgeRealized24h: vol ? net / vol : 0, edgeExpected: 0.045, biggestWin24h: best && best.payout > 0 ? { name: store.profile?.username ?? 'You', chips: best.payout, game: best.game } : null, timeouts24h: 0 };
  }
  async churchStats(): Promise<ChurchStats> {
    return { treasury: Math.floor(store.stats.pool), tithes24h: store.stats.tithed, candles24h: store.stats.candles, alms24h: store.stats.claimed['alms-today'] ? 30 : 0,
      blessingsPaid24h: 0, blessingCapBps: 500, candleFaithMilli: PARAMS.candleFaithMilli * this.boost('church'), faithfulOnline: store.realm === 'church' ? 1 : 0 };
  }

  async history() { return store.stats.history.slice(); }

  // ---- BTC UP/DOWN (demo): a local random walk stands in for the oracle; same rounds, same 1.9x, same tie refund
  private mk = { epoch: 0, rounds: new Map<number, MarketRound>(), bets: new Map<number, { betId: number; epoch: number; side: MarketSide; chips: number }>(), results: new Map<number, MarketResult>(), price: 73_400 + Math.random() * 400, at: Date.now(), history: [] as [number, number][], nextId: 900_000 };
  private walk() {
    const now = Date.now();
    while (this.mk.at + 1000 <= now) {
      this.mk.at += 1000;
      this.mk.price = Math.max(1000, this.mk.price * (1 + (Math.random() - 0.5) * 0.0009));
      this.mk.history.push([this.mk.at, Math.round(this.mk.price * 100) / 100]);
    }
    while (this.mk.history.length > 600) this.mk.history.shift();
    return Math.round(this.mk.price * 100) / 100;
  }
  private mkTick() {
    const ROUND = 60_000, now = Date.now(), price = this.walk(), m = this.mk;
    const blank = (epoch: number, at: number): MarketRound => ({ epoch, phase: 'open', openAt: at, lockAt: at + ROUND, lockedAt: 0, closedAt: 0, lockPrice: null, closePrice: null, up: 0, down: 0, bets: 0, outcome: '' });
    if (!m.epoch) { m.epoch = 1; m.rounds.set(1, blank(1, now)); }
    for (let guard = 0; guard < 5; guard++) {
      const open = m.rounds.get(m.epoch)!;
      if (now < open.lockAt) break;
      const live = m.rounds.get(m.epoch - 1);
      if (live?.phase === 'live') {
        live.closePrice = price; live.closedAt = now; live.phase = 'closed';
        live.outcome = price > live.lockPrice! ? 'up' : price < live.lockPrice! ? 'down' : 'tie';
        for (const b of [...m.bets.values()].filter((x) => x.epoch === live.epoch)) {
          const won = b.side === live.outcome, refund = live.outcome === 'tie';
          const payout = won ? b.chips * 1.9 : refund ? b.chips : 0;
          if (payout) store.change({ chips: payout });
          this.log('btc', b.chips, payout, `BTC ${b.side.toUpperCase()} · $${live.lockPrice!.toFixed(2)} → $${price.toFixed(2)}`);
          const res: MarketResult = { betId: b.betId, side: b.side, outcome: live.outcome as MarketResult['outcome'], wager: b.chips, payout, blessing: 0, lockPrice: live.lockPrice, closePrice: price, luckGain: won || !refund ? 0.1 * b.chips : 0 };
          m.results.set(b.betId, res); m.bets.delete(b.betId);
          setTimeout(() => bus.emit('marketSettled', res), 0);
        }
      }
      open.phase = 'live'; open.lockPrice = price; open.lockedAt = now;
      m.epoch += 1; m.rounds.set(m.epoch, blank(m.epoch, now));
      m.rounds.delete(m.epoch - 14);
    }
  }
  async market(): Promise<MarketState> {
    this.mkTick();
    const m = this.mk, open = m.rounds.get(m.epoch)!, live = m.rounds.get(m.epoch - 1);
    const recent = [...m.rounds.values()].filter((r) => r.phase === 'closed').sort((a, b) => b.epoch - a.epoch).slice(0, 12);
    const crowd: MarketState['crowd'] = {};
    for (const b of m.bets.values()) (crowd[b.epoch] ??= []).push({ betId: b.betId, who: 'You', side: b.side, chips: b.chips, mine: true });
    return {
      enabled: true, epoch: m.epoch, pending: false, roundS: 60, graceS: 45, payout: 1.9, wagers: [1, 2, 5, 10],
      open: { ...open }, live: live?.phase === 'live' ? { ...live } : null, recent: recent.map((r) => ({ ...r })), crowd,
      price: this.walk(), history: m.history.slice(-300), oraclePrice: live?.lockPrice ?? null, oracleAt: live?.lockedAt ?? 0, skew: 0,
      oracle: 'demo price (offline)',
    };
  }
  async marketBet(epoch: number, side: MarketSide, chips: number) {
    this.mkTick();
    const open = this.mk.rounds.get(this.mk.epoch)!;
    if (epoch !== this.mk.epoch || Date.now() >= open.lockAt) fail('round_locked', 'Betting on that round has closed. Try the next one.');
    if ([...this.mk.bets.values()].some((b) => b.epoch === epoch)) fail('already_bet', 'You already have a bet on this round.');
    if (store.eco.chips < chips) fail('no_chips', 'Not enough chips.');
    await sleep(500);
    store.change({ chips: -chips });
    const betId = ++this.mk.nextId;
    this.mk.bets.set(betId, { betId, epoch, side, chips });
    open.bets += 1; if (side === 'up') open.up += chips; else open.down += chips;
    return { betId };
  }
  async marketResult(betId: number) { this.mkTick(); return this.mk.results.get(betId) ?? null; }

  // ---- campaigns (demo): the same rules as the contract, kept in memory; the Church "oracle" waits 5 s
  private camps: CampaignRow[] = [
    { id: 1, kind: 0, creator: 'admin', title: 'Follow @NEARProtocol on X', url: 'https://x.com/NEARProtocol', machineId: 0, goal: 0, rewardChips: 2, rewardFaith: 3, maxClaims: 50, claims: 12, active: true, claimed: false, progress: 0, mine: false },
    { id: 2, kind: 1, creator: 'admin', title: 'Read how NEAR AI keeps the hosts honest', url: 'https://docs.near.ai/', machineId: 0, goal: 0, rewardChips: 0, rewardFaith: 2, maxClaims: 200, claims: 31, active: true, claimed: false, progress: 0, mine: false },
    { id: 3, kind: 0, creator: 'admin', title: 'Share the game with #NEARHackathon', url: 'https://x.com/intent/post?text=Playing%20The%20Casino%20%26%20The%20Church%20%23NEARHackathon', machineId: 0, goal: 0, rewardChips: 2, rewardFaith: 3, maxClaims: 30, claims: 4, active: true, claimed: false, progress: 0, mine: false },
  ];
  private campStarts = new Map<number, number>();
  async campaigns() { return this.camps.map((c) => ({ ...c })).reverse(); }
  async startCampaign(id: number) { this.campStarts.set(id, Date.now()); return { visitS: 5 }; }
  async claimCampaign(id: number) {
    await sleep(600);
    const c = this.camps.find((x) => x.id === id);
    if (!c || !c.active) fail('closed', 'That campaign has ended.');
    if (c!.claimed) fail('already_claimed', 'You already claimed this one.');
    if (c!.mine) fail('not_allowed', 'You cannot claim your own campaign.');
    const at = this.campStarts.get(id);
    if (!at || Date.now() - at < 5000) fail('not_done', 'Open the task first, then come back.');
    c!.claimed = true; c!.claims++; if (c!.claims >= c!.maxClaims) c!.active = false;
    store.eco.chips += c!.rewardChips; store.eco.faith = Math.min(100, store.eco.faith + c!.rewardFaith); store.emit();
    return { chips: c!.rewardChips, faith: c!.rewardFaith };
  }
  async createCampaign(n: NewCampaign) {
    await sleep(700);
    const problem = campaignProblem(n); if (problem) fail('bad_campaign', problem);
    if (store.eco.faith < CAMPAIGN_LIMITS.creatorMinFaith) fail('faith_low', `You need FAITH ${CAMPAIGN_LIMITS.creatorMinFaith} to open a campaign.`);
    const cost = campaignCost(n);
    if (store.eco.chips < cost.total) fail('no_chips', `This campaign costs ${cost.total} chips.`);
    store.eco.chips -= cost.total; store.stats.pool += cost.listing; store.emit();
    const id = Math.max(...this.camps.map((c) => c.id)) + 1;
    this.camps.push({ id, kind: n.kind, creator: 'you', title: n.title, url: n.url, machineId: n.machine_id, goal: n.goal, rewardChips: n.reward_chips, rewardFaith: n.reward_faith_milli / 1000, maxClaims: n.max_claims, claims: 0, active: true, claimed: false, progress: 0, mine: true });
    return id;
  }
  async closeCampaign(id: number) {
    const c = this.camps.find((x) => x.id === id);
    if (!c || !c.mine || !c.active) fail('not_allowed', 'Only the creator can close an open campaign.');
    c!.active = false; store.eco.chips += (c!.maxClaims - c!.claims) * c!.rewardChips; store.emit();
  }
  async leaderboard() {
    // until the indexer is live the board is seeded with the house regulars, clearly marked DEMO in the UI
    const rivals = [['HighRollerVic', 48200, 3100], ['LadyLuck', 31750, -2400], ['SaintNakamoto', 22900, 900], ['CardShark', 18400, -5200], ['Songbird', 9600, 1200], ['TheTourist', 4100, -900], ['Pilgrim42', 2300, 300]] as const;
    const me = { name: store.profile?.username ?? 'You', wagered: Math.floor(store.stats.wagered), net: Math.floor(store.stats.net), you: true };
    const rows = [...rivals.map(([name, wagered, net]) => ({ name, wagered, net })), me].sort((a, b) => b.wagered - a.wagered).map((r, i) => ({ rank: i + 1, ...r }));
    return { rows, demo: true };
  }
  async fundMachine(id: number, chips: number) {
    const p = store.plots[id]; if (!p) return fail('none', 'No machine there.'); if (store.eco.chips < chips || chips < 1) fail('no_chips', 'Not enough chips.');
    store.change({ chips: -chips }); p.bankroll += chips; store.saveEco(); store.emit();
  }
  async withdrawMachine(id: number, chips: number) {
    const p = store.plots[id]; if (!p) return fail('none', 'No machine there.');
    if (chips < 1 || p.bankroll - chips < 100) fail('reserve', 'The machine must keep a 100 chip reserve.');
    p.bankroll -= chips; store.change({ chips }); store.saveEco();
  }
}

export let backend: Backend = new MockBackend();

/** Boot hook. Chain mode falls back to the mock when `/healthz` does not answer. */
export async function initBackend(): Promise<string | null> {
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  if ((env.VITE_BACKEND ?? 'solana') === 'mock') return null;
  // ?demo=1: the offline demo on any build (no account, nothing on chain): the quickest way to try every panel
  if (new URLSearchParams(location.search).get('demo') === '1') return null;
  const { connectSolana } = await import('../solana/solanaBackend');
  const next = await connectSolana(env.VITE_API_URL ?? 'http://localhost:8787');
  if ('offline' in next) return next.offline;
  if (backend instanceof MockBackend) backend.stop();
  backend = next;
  return null;
}

export { blessingOf };
