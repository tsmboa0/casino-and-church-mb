import { addSignatures, addr, b64decode, b64encode, BJ, BJ_LABELS, buildTx, decodeBoard, decodeFeed, decodeMarket, decodePlots, hasClaimed, MARKET_HEAD, OUTCOMES, P, ChainError, CHIP, CHIPS_PER_SOL, compileMessage, GAME, GAME_NAMES, decodeHouse, decodePlayer, decodePurse, ix, REALM, Rpc, type BetResultState, type HandState, type Ix, type MarketState as ChainMarket, type PlayerState, type RoundRecState, type RoundState } from '@cnc/realm';
import { cleanName, nameProblem, type NewCampaign } from '@cnc/shared';
import { BackendError } from '../core/errors';
import type { Backend, BetProof, BetReq, BetResult, BjState, CampaignRow, LbRow, MarketCrowdBet, MarketResult, MarketRound, MarketSide, MarketState, PastRound, WheelResult } from '../core/backend';
import { bus } from '../core/bus';
import { cardName, handTotal, MACHINE_SKINS, PARAMS, QUESTS, setTableBets, SLOT_SYMS } from '../core/rules';
import { store, type HistRow, type Plot } from '../core/state';
import { ER_RPC, L1_RPC, loadWallet } from '../wallet';
import { rollupBanner } from './banner';
import { erTx, l1Tx } from './explorer';
import { checkBet } from './verify';
import { dropSession, freshSession, loadSession, saveSession } from './session';

const SAY: Record<string, string> = {
  Paused: 'The game is paused for a moment. Your chips are safe.', DepositsPaused: 'Buying chips is paused for a moment.', PayoutsPaused: 'Payouts are paused for a moment. Your SOL is safe.',
  BadAmount: 'That amount is not allowed.', NoChips: 'Not enough chips. Visit the Cashier.', VaultLow: 'The house cannot cover that right now.', AlreadyClaimed: 'Already claimed.', BetPending: 'Finish your open bet first.',
  BadPick: 'Pick something first.', BadWager: 'That bet is not offered at this table.', MaxBet: 'That is above the table limit right now.', MarketClosed: 'The BTC exchange is closed for a moment.', RoundMoved: 'That round has just closed. Try the next one.', RoundLocked: 'Betting on that round has closed. Try the next one.', AlreadyBet: 'You already have a bet on this round.', SlotsFull: 'Too many bets are still being settled. One moment.',
  NotDone: 'Not finished yet.', CampaignClosed: 'That campaign has ended.', TreasuryLow: 'The treasury is too low for that.', PlotTaken: 'That plot is already owned.', PlotGate: 'Earn your standing first: wager 100 chips and earn 5 FAITH.', Reserve: 'The machine must keep 100 chips, and enough for a spin in progress.', BoardFull: 'The Quest Board is full. Try again when a campaign ends.', NotAllowed: 'That is not yours to do.',
  NoHand: 'That hand is over.', CannotDouble: 'You can only double on your first two cards.', LuckLow: 'Not enough LUCK yet.', FaithLow: 'Not enough FAITH yet.',
  BadSession: 'Your session ended. Sign in again to keep playing.', Cooldown: 'Too soon. Wait a moment.', BadName: 'That name is not allowed.', rollup_down: 'The rollup is updating. Your chips are safe. Try again in a minute.', l1_down: 'Solana is not answering. Try again in a moment.',
};
const friendly = (e: unknown): BackendError => {
  if (e instanceof BackendError) return e;
  if (e instanceof ChainError) return new BackendError(e.code, SAY[e.code] ?? (e.code.startsWith('custom_') || e.code === 'rpc' ? 'The chain refused that. Please try again.' : e.message));
  const m = String((e as Error)?.message ?? e); return new BackendError('cancelled', /reject|denied|cancel|closed|exited/i.test(m) ? 'Cancelled.' : 'Something went wrong. Please try again.');
};
const soon = (): never => { throw new BackendError('soon', 'This opens in the next update. Try it in the offline demo.'); };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const hex = (u: Uint8Array) => [...u].map((x) => x.toString(16).padStart(2, '0')).join('');
/** lamports to chips, exactly */
const n = (l: bigint) => Number(l) / 1e6;
const sol = (l: bigint) => Number(l) / 1e9;

/** The real game: SOL on Solana L1, play on a MagicBlock Ephemeral Rollup. Games arrive in the next milestones. */
export class SolanaBackend implements Backend {
  readonly mode = 'chain' as const;
  readonly chain = 'solana' as const;
  private l1 = new Rpc(L1_RPC, 'l1'); private er = new Rpc(ER_RPC, 'er');
  private me: string | null = null; private player: PlayerState | null = null;
  private ws: WebSocket | null = null; private wsTries = 0; private queue: Promise<unknown> = Promise.resolve(); private polls = 0;

  constructor(private api: string) {
    window.setInterval(() => this.fade(), 4000);
    window.setInterval(() => { if (this.me && document.visibilityState === 'visible') void this.poll(); }, 12_000);
    window.setInterval(() => { if (this.me && this.player?.btc.length) void this.settleBtc(); }, 2_500);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && this.me) void this.poll(); });
    void this.table(); void this.readPlots(); window.setInterval(() => { if (document.visibilityState === 'visible') void this.readPlots(); }, 30_000);
  }

  // ---------------------------------------------------------------- account
  address() { return this.me; }
  /** signed in with Privy: what does this wallet still need? `setup` opens the account and/or a session (one popup) */
  async attach(wallet: string): Promise<{ ready: boolean; isNew: boolean; name: string | null; avatar: string | null }> {
    this.me = wallet; this.player = null; this.mkMine.clear();
    const [who, acct, sess] = await Promise.all([this.get<{ wallet: string | null; name: string | null; avatar: string | null }>('/me').catch(() => ({ wallet: null, name: null, avatar: null })), this.l1.account(addr.player(wallet)).catch(() => null), loadSession(wallet)]);
    let live = false;
    if (sess && sess.until * 1000 > Date.now() + 60_000) live = !!(await this.l1.account(addr.sessionToken(wallet, sess.signer.address)).catch(() => null));
    const ready = !!acct && live && who.wallet === wallet;
    if (ready) await this.start();
    return { ready, isNew: !acct, name: who.name, avatar: who.avatar };
  }
  /** ONE popup: opens the account if it is new, and lets this device play without more popups */
  async setup(step: (text: string) => void = () => {}): Promise<void> {
    const w = this.need();
    try {
      const signer = freshSession(); step('Preparing your account...');
      const { tx } = await this.post<{ tx: string }>('/account/prepare', { wallet: w, session: signer.address });
      step('Approve it in the popup'); let wire = await (await loadWallet()).signTransaction(b64decode(tx));
      wire = addSignatures(wire, [signer]);                              // the session key signs its own creation; the sponsor signs last
      step('Opening your account on Solana...'); await this.post('/tx/submit', { tx: b64encode(wire) });
      await saveSession(w, signer, Math.floor(Date.now() / 1000) + 6 * 86_400 - 300);
      step('Moving onto the rollup...'); await this.waitFor(() => this.readPlayer(), 30_000);
      await this.start(); step('Counting your welcome chips...');
      if (!this.player?.welcomeClaimed) await this.act([ix.claimWelcome(w, signer.address)]).catch(() => bus.emit('toast', 'Your welcome chips are on their way.'));
    } catch (e) { throw friendly(e); }
  }
  async saveName(name: string, avatar: string): Promise<void> { await this.post('/names', { name, avatar }); await this.setProfile(name, avatar).catch(() => {}); }
  private async start() { await this.poll(); this.listen(); }
  signOut() { const w = this.me; this.me = null; this.player = null; this.ws?.close(); this.ws = null; if (w) void dropSession(w); void loadWallet().then((x) => x.logout()).catch(() => {}); }
  linkedAccount() { return this.me; }
  async wallet() { return { accountId: this.need(), encrypted: true }; }
  async checkName(name: string) { const p = nameProblem(cleanName(name)); if (p) return { available: false, reason: p }; return this.get<{ available: boolean; reason?: string }>(`/names/check?name=${encodeURIComponent(name)}&wallet=${this.me ?? ''}`); }

  // ---------------------------------------------------------------- cashier
  async faucet() { const r = await this.post<{ sol: number }>('/faucet', {}).catch((e) => { throw friendly(e); }); await this.waitFor(async () => { const b = store.eco.sol; await this.readSol(); return store.eco.sol > b; }, 15_000).catch(() => {}); return r.sol; }
  /** SOL -> chips. One popup; our server pays the fee */
  async deposit(amountSol: number) {
    const w = this.need(), chips = Math.round(amountSol * CHIPS_PER_SOL);
    try {
      const { tx } = await this.post<{ tx: string }>('/buy/prepare', { wallet: w, chips });
      const wire = await (await loadWallet()).signTransaction(b64decode(tx));
      const before = decodePurse((await this.l1.account(addr.purse(w)))!.data)!.deposited;
      await this.post('/tx/submit', { tx: b64encode(wire) });
      const want = before + BigInt(chips) * CHIP;
      // the rollup's copy of the purse refreshes a moment later; syncing early credits nothing, so just try again
      await this.waitFor(async () => { await this.act([ix.syncDeposit(w)]); return (this.player?.credited ?? 0n) >= want; }, 25_000, 700);
      void this.readSol();
    } catch (e) { if ((e as ChainError).code === 'timeout_wait') throw new BackendError('slow', 'Your SOL arrived. The chips appear in a few seconds.'); throw friendly(e); }
  }
  /** chips -> SOL. The main wallet signs; a session key cannot */
  async withdraw(chips: number) {
    const w = this.need();
    try {
      const before = decodePurse((await this.l1.account(addr.purse(w)))!.data)!.paidOut;
      const msg = compileMessage(w, [ix.cashOut(w, chips)], await this.er.blockhash());
      const signed = await (await loadWallet()).signTransaction(buildTx(msg, []));
      await this.er.send(signed); await this.poll();
      const want = before + BigInt(chips) * CHIP;
      await this.waitFor(async () => (decodePurse((await this.l1.account(addr.purse(w)))!.data)?.paidOut ?? 0n) >= want, 45_000, 900).catch(() => { throw new BackendError('slow', 'Your chips are locked in. The SOL is on its way to your wallet.'); });
      await this.readSol();
    } catch (e) { if (this.offRollup(e)) throw new BackendError('moving', 'Your account is moving back onto the rollup. Try again in half a minute.'); throw friendly(e); }
  }
  async sync() { await this.poll(); }

  // ---------------------------------------------------------------- the player's own things
  async enterRealm(realm: 'casino' | 'church' | 'plaza') { const n = { plaza: 0, casino: 1, church: 2 }[realm]; if (!this.ready()) return; await this.play((w, s) => ix.enterRealm(w, s, n)).catch((e) => { if ((e as BackendError).code !== 'Cooldown') throw e; void sleep(3200).then(() => { if (store.realm === realm) return this.play((w, s) => ix.enterRealm(w, s, n)); }).catch(() => {}); return ''; }); }
  async completeTour(realm: 'casino' | 'church') { if (this.ready()) await this.play((w, s) => ix.completeTour(w, s, realm === 'casino' ? 1 : 2)); }
  async setProfile(name: string, avatar: string) { if (this.ready()) await this.play((w, s) => ix.setProfile(w, s, name, avatar)); }
  toursDone() { const f = this.player?.tourFlags ?? 0; return { casino: !!(f & 2), church: !!(f & 4) }; }

  // ---------------------------------------------------------------- bets: placed with the session key, settled by the VRF oracle
  async placeBet(r: BetReq): Promise<BetResult> {
    const game = GAME[r.game as keyof typeof GAME]; if (game === undefined || game > GAME.roulette) return soon();
    const { b, proof } = await this.bet(game, r.wager, r.pick ?? 0, r.machineId), o = b.outcome;
    return {
      betId: Number(b.seq), game: r.game, wager: r.wager, payout: n(b.payout), net: n(b.payout) - n(b.wager), blessing: b.blessing, luckGain: b.luckGainMilli / 1000,
      outcome: r.game === 'slots' ? { reels: o.slice(0, 3).map((i) => SLOT_SYMS[i]) } : r.game === 'coinflip' ? { side: o[0] === 0 ? 'H' : 'T' } : r.game === 'dice' ? { dice: [o[0], o[1]] } : { n: o[0], color: ['green', 'red', 'black'][o[1]] },
      proof,
    };
  }
  async spinWheel(): Promise<WheelResult> { const { b, proof } = await this.bet(GAME.wheel, 0, 0); const c = n(b.payout); return { prize: c, chips: c, proof }; }
  async spinHarmony(): Promise<WheelResult> { const { b, proof } = await this.bet(GAME.harmony, 0, 0); const c = n(b.payout); void this.readHouse(); return { prize: b.jackpot ? 'JACKPOT' : c, chips: c, proof }; }
  private async bet(game: number, chips: number, pick: number, plot?: number) {
    const seed = crypto.getRandomValues(new Uint8Array(32)); await this.free();
    const placeTx = await this.play((w, s) => (plot ? ix.machineBet(w, s, plot, chips, seed) : ix.placeBet(w, s, game, chips, pick, seed)));
    const seq = this.player!.betSeq; const b = await this.settled(seq); return { b, proof: this.proof(seq, seed, placeTx) };
  }
  private proof(seq: bigint, seed: Uint8Array, placeTx: string): BetProof { const p = this.player!; return { seq: String(seq), randomness: p.lastVrfSeq === seq ? hex(p.lastVrf) : '', clientSeed: hex(seed), placeTx }; }
  /** one bet at a time: say which one is in the way */
  private async free() {
    const open = () => { const h = this.player?.hand; return this.player?.pending ? 'Your last bet is still being settled. One moment.' : h && !h.over ? 'You have a blackjack hand open. Finish it first, or it stands by itself after two minutes.' : null; };
    if (open()) await this.readPlayer().catch(() => {}); const why = open(); if (why) throw new BackendError('BetPending', why);
  }
  private settled(seq: bigint): Promise<BetResultState> {
    return this.oracle(() => this.player?.recent.find((x) => x.seq === seq) ?? null, () => !!this.player && this.player.betSeq >= seq && !this.player.pending);
  }
  /** waits for the oracle's answer: it arrives as an account update, usually within half a second. `gone`: refunded instead */
  private async oracle<T>(ready: () => T | null, gone: () => boolean): Promise<T> {
    const t = Date.now(); let told = false;
    for (;;) {
      const hit = ready(); if (hit) return hit;
      if (gone() && Date.now() - t > 1500) { await this.readPlayer().catch(() => {}); const again = ready(); if (again) return again; if (gone()) throw new BackendError('refunded', 'The randomness oracle did not answer, so your bet was returned.'); }
      if (!told && Date.now() - t > 4000) { told = true; const ok = await this.moving().then(async () => { await sleep(900); return this.moving(); }).catch(() => false); if (ok) bus.emit('toast', 'Waiting for the randomness oracle. Your bet is safe.'); else rollupBanner(true); }
      if (told && Date.now() - t > 6000) void this.moving().then((ok) => { if (ok) rollupBanner(false); }).catch(() => {});
      if (Date.now() - t > 200_000) throw new BackendError('slow', 'The oracle is very late. Your bet comes back by itself.');
      await sleep(120); if (Date.now() - t > 350) await this.readPlayer().catch((e) => { if ((e as ChainError).code === 'rollup_down') rollupBanner(true); });
    }
  }

  // ---------------------------------------------------------------- blackjack: every action is its own VRF request
  private bjTx = ''; private bjSeed = new Uint8Array(32);
  private bjState(h: HandState): BjState {
    const p = handTotal(h.player), d = handTotal(h.dealer), r = h.over ? this.player!.recent.find((x) => x.seq === h.seq) : undefined;
    return {
      betId: Number(h.seq), stage: h.over ? 'done' : 'player', player: h.player.map(cardName), dealer: h.dealer.map(cardName), playerTotal: p.total, dealerTotal: d.total, soft: p.soft, doubled: h.doubled, stake: Number(h.stake / CHIP),
      canDouble: !h.over && h.player.length === 2 && !h.doubled && this.player!.chips + this.player!.bonus >= h.original,
      result: r && { label: BJ_LABELS[r.outcome[2]], payout: n(r.payout), blessing: r.blessing, proof: this.bjTx ? this.proof(h.seq, this.bjSeed, this.bjTx) : undefined },
    };
  }
  /** the hand once it has moved past `cards` player cards (`end`: once it is over) */
  private handAt(seq: bigint, cards: number, end: boolean): Promise<BjState> {
    return this.oracle(() => { const h = this.player?.hand; return h && h.seq === seq && !h.dealing && (h.over ? !!this.player!.recent.find((x) => x.seq === seq) : !end && !h.awaiting && h.player.length > cards) ? this.bjState(h) : null; }, () => !!this.player && this.player.betSeq >= seq && this.player.hand?.seq !== seq);
  }
  async blackjackDeal(wager: number): Promise<BjState> {
    await this.free(); const seed = crypto.getRandomValues(new Uint8Array(32));
    this.bjTx = await this.play((w, s) => ix.bjDeal(w, s, wager, seed)); this.bjSeed = seed;
    return this.handAt(this.player!.betSeq, 0, false);
  }
  async blackjackAct(betId: number, action: 'hit' | 'stand' | 'double'): Promise<BjState> {
    const seq = BigInt(betId), h = this.player?.hand; if (!h || h.seq !== seq) throw new BackendError('NoHand', SAY.NoHand);
    const cards = h.player.length, seed = crypto.getRandomValues(new Uint8Array(32));
    if (!h.over && !h.awaiting) try { this.bjTx = await this.play((w, s) => ix.bjAct(w, s, BJ[action], seed)); this.bjSeed = seed; }
    catch (e) { const c = (e as BackendError).code; if (c !== 'NoHand' && c !== 'BetPending') throw e; await this.readPlayer(); }      // it stood by itself while we looked away: show how it ended
    return this.handAt(seq, cards, action !== 'hit');
  }
  async blackjackOpen(): Promise<BjState | null> {
    await this.readPlayer().catch(() => {}); const h = this.player?.hand; if (!h || h.over) return null;
    return h.awaiting ? this.handAt(h.seq, h.dealing ? 0 : h.player.length, h.awaiting !== BJ.hit && !h.dealing) : this.bjState(h);
  }
  // ---------------------------------------------------------------- the BTC market: read from the rollup, priced by its crank
  private mk: { head: ChainMarket | null; ring: RoundRecState[]; ringFor: bigint; cents: number | null; at: number; skew: number; crowd: Record<number, MarketCrowdBet[]>; crowdAt: number; links: Map<number, { tx: string | null; page: string | null }> } = { head: null, ring: [], ringFor: 0n, cents: null, at: 0, skew: -Infinity, crowd: {}, crowdAt: 0, links: new Map() };
  private mkBusy: Promise<void> | null = null; private mkMine = new Map<bigint, bigint>(); private mkClaiming = false;
  /** one small read (352 bytes of the market, and the oracle's price); the whole account only when a round has ended */
  private readMarket(maxAgeMs = 700): Promise<void> {
    if (Date.now() - this.mk.at < maxAgeMs) return Promise.resolve();
    return (this.mkBusy ??= (async () => {
      const r = await this.er.call('getMultipleAccounts', [[addr.market(), P.btcFeed], { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: MARKET_HEAD } }]);
      const h = r.value[0] && decodeMarket(b64decode(r.value[0].data[0])), f = r.value[1] && decodeFeed(b64decode(r.value[1].data[0])); if (!h) throw new BackendError('MarketClosed', SAY.MarketClosed);
      if (h.open.epoch !== this.mk.ringFor) { const a = await this.er.account(addr.market()), full = a && decodeMarket(a.data); if (full) { this.mk.ring = full.rounds; this.mk.ringFor = full.open.epoch; } }
      // the tick second is at most one second behind the chain's clock, so the largest difference seen is the closest
      if (h.lastTickTs) this.mk.skew = Math.max(this.mk.skew === -Infinity ? -Infinity : this.mk.skew - 5, h.lastTickTs * 1000 - Date.now());
      Object.assign(this.mk, { head: h, cents: f?.cents ?? null, at: Date.now() });
    })().finally(() => { this.mkBusy = null; }));
  }
  private async readCrowd(epochs: number[]) {
    if (Date.now() - this.mk.crowdAt < 1_800) return; this.mk.crowdAt = Date.now();
    const r = await this.get<{ crowd: Record<number, { wallet: string; seq: string; side: MarketSide; chips: number; who: string }[]> }>(`/market/crowd?epochs=${epochs.join(',')}`).catch(() => null); if (!r) return;
    this.mk.crowd = Object.fromEntries(Object.entries(r.crowd).map(([e, l]) => [e, l.map((b) => ({ betId: Number(b.seq), who: b.who, side: b.side, chips: b.chips, mine: b.wallet === this.me }))]));
  }
  async market(): Promise<MarketState> {
    await this.readMarket(); const h = this.mk.head!, skew = Number.isFinite(this.mk.skew) ? this.mk.skew : 0, now = Date.now() + skew;
    const round = (r: RoundState, phase: 'open' | 'live'): MarketRound => ({ epoch: Number(r.epoch), phase, openAt: r.openTs * 1000, lockAt: r.lockTs * 1000, lockedAt: r.lockedAt * 1000, closedAt: 0, lockPrice: r.lockC ? r.lockC / 100 : null, closePrice: null, up: Number(r.up / CHIP), down: Number(r.down / CHIP), bets: r.bets, outcome: '' });
    const open = round(h.open, 'open'), live = h.live ? round(h.live, 'live') : null; await Promise.race([this.readCrowd([open.epoch, ...(live ? [live.epoch] : [])]), sleep(400)]);
    // my own bets are on chain: they show even when our server is down
    const crowd: Record<number, MarketCrowdBet[]> = { ...this.mk.crowd }; for (const s of this.player?.btc ?? []) { const e = Number(s.epoch); if (!crowd[e]?.some((b) => b.mine)) crowd[e] = [{ betId: Number(s.seq), who: 'You', side: s.side === 1 ? 'up' : 'down', chips: Number(s.wager / CHIP), mine: true }, ...(crowd[e] ?? [])]; }
    return {
      enabled: h.enabled, epoch: open.epoch, pending: h.enabled && now >= open.lockAt, roundS: h.roundS, graceS: h.graceS, payout: h.payoutBps / 10_000, wagers: h.wagers, open, live, crowd, skew,
      recent: this.mk.ring.slice(0, 12).map((r) => ({ epoch: r.epoch, phase: r.outcome === 4 ? 'void' as const : 'closed' as const, openAt: 0, lockAt: 0, lockedAt: 0, closedAt: r.closedTs * 1000, lockPrice: r.lockC / 100, closePrice: r.closeC / 100, up: r.up, down: r.down, bets: r.bets, outcome: OUTCOMES[r.outcome] as MarketRound['outcome'] })),
      price: this.mk.cents ? this.mk.cents / 100 : null, history: [], oraclePrice: h.lastPriceC ? h.lastPriceC / 100 : null, oracleAt: h.lastPriceTs * 1000, oracle: 'Pyth Lazer oracle',
    };
  }
  async marketBet(epoch: number, side: MarketSide, chips: number) { const tx = await this.play((w, s) => ix.marketBet(w, s, BigInt(epoch), side === 'up' ? 1 : 2, chips)); return { betId: Number(this.player!.btc.find((b) => b.epoch === BigInt(epoch))?.seq ?? this.player!.betSeq), tx }; }
  async marketResult(betId: number): Promise<MarketResult | null> { const seq = BigInt(betId); const b = this.player?.recent.find((x) => x.seq === seq && x.game === GAME.market); if (!b) { void this.settleBtc(); return null; } return this.btcResult(b); }
  private async btcResult(b: BetResultState): Promise<MarketResult> {
    const low = b.outcome[2] | (b.outcome[3] << 8), find = () => this.mk.ring.find((r) => (r.epoch & 0xffff) === low); if (!find()) { this.mk.ringFor = 0n; await this.readMarket(0).catch(() => {}); }
    const r = find(), o = OUTCOMES[b.outcome[1]], link = r && await this.roundLink(r.epoch);
    return { betId: Number(b.seq), side: b.outcome[0] === 1 ? 'up' : 'down', outcome: o === 'expired' ? 'void' : o, wager: Number(b.wager / CHIP), payout: Number(b.payout) / 1e6, blessing: b.blessing, lockPrice: r ? r.lockC / 100 : null, closePrice: r ? r.closeC / 100 : null, luckGain: b.luckGainMilli / 1000, epoch: r?.epoch, roundTx: link ?? undefined };
  }
  private async roundLink(epoch: number): Promise<string | null> { const k = this.mk.links.get(epoch); if (k?.tx) return k.tx; await Promise.race([this.pastRounds(epoch + 1).catch(() => []), sleep(900)]); return this.mk.links.get(epoch)?.tx ?? null; }
  /** anyone may settle a finished bet; our server does it too, whichever is first */
  private async settleBtc() {
    if (this.mkClaiming || !this.player?.btc.length) return; this.mkClaiming = true;
    try { await this.readMarket(); const h = this.mk.head!; if (this.player.btc.some((s) => s.epoch < h.open.epoch && s.epoch !== h.live?.epoch)) await this.act([ix.marketClaim(this.need())]); } catch { /* again in a moment */ } finally { this.mkClaiming = false; }
  }
  /** a bet that was open and now has a result: tell the panel (or the floor, when it is closed) */
  private watchBtc(p: PlayerState) {
    for (const s of p.btc) this.mkMine.set(s.seq, s.epoch);
    for (const seq of this.mkMine.keys()) { const b = p.recent.find((x) => x.seq === seq && x.game === GAME.market); if (b) { this.mkMine.delete(seq); void this.btcResult(b).then((r) => bus.emit('marketSettled', r)); } }
  }
  /** the last 4 hours come from the chain, older ones and every link from our server's copy */
  async pastRounds(before?: number): Promise<PastRound[]> {
    const [srv] = await Promise.all([this.get<{ rounds: PastRound[] }>(`/market/rounds?limit=60${before ? `&before=${before}` : ''}`).catch(() => ({ rounds: [] as PastRound[] })), this.readMarket().catch(() => {})]);
    for (const r of srv.rounds) this.mk.links.set(r.epoch, { tx: r.tx, page: r.page });
    const chain = this.mk.ring.filter((r) => !before || r.epoch < before).slice(0, 60).map((r): PastRound => ({ epoch: r.epoch, outcome: OUTCOMES[r.outcome] as PastRound['outcome'], lock: r.lockC / 100, close: r.closeC / 100, closedAt: r.closedTs * 1000, up: r.up, down: r.down, bets: r.bets, tx: this.mk.links.get(r.epoch)?.tx ?? null, page: this.mk.links.get(r.epoch)?.page ?? null }));
    const known = new Set(chain.map((r) => r.epoch)); return [...chain, ...srv.rounds.filter((r) => !known.has(r.epoch))].sort((a, b) => b.epoch - a.epoch).slice(0, 60);
  }
  l1Url(sig: string) { return l1Tx(sig); }
  verifyBet(p: BetProof) { return checkBet(this.er, this.need(), p); }
  txUrl(sig: string) { return erTx(sig); }
  async history(): Promise<HistRow[]> {
    const w = this.need(); const r = await this.get<{ bets: { game: string; wager: number; payout: number; detail: string; tx: string; at: number; seq: string }[] }>(`/bets?wallet=${w}`).catch(() => null);
    if (r) return r.bets.map((b) => ({ t: b.at, game: b.game, wager: b.wager, payout: b.payout, detail: b.detail, tx: b.tx }));
    return (this.player?.recent ?? []).map((b) => ({ t: b.ts * 1000, game: GAME_NAMES[b.game], wager: n(b.wager), payout: n(b.payout), detail: '' }));      // our server is down: the last 8 are on chain
  }
  async leaderboard() { const r = await this.get<{ rows: (LbRow & { wallet: string })[] }>('/leaderboard').catch(() => ({ rows: [] })); return { rows: r.rows.map((x) => ({ rank: x.rank, name: x.name, wagered: x.wagered, net: x.net, you: x.wallet === this.me })), demo: false }; }

  // ---------------------------------------------------------------- the church
  private async faithBy(make: (w: string, s: string) => Ix) { const before = this.player?.faithEarnedMilli ?? 0n; await this.play(make); return { faithGain: Number((this.player?.faithEarnedMilli ?? 0n) - before) / 1000 }; }
  async tithe(chips: number) { const r = await this.faithBy((w, s) => ix.tithe(w, s, chips)); void this.readHouse(); return r; }
  async offerLuck(luck: number) { return this.faithBy((w, s) => ix.offerLuck(w, s, Math.round(luck * 1000))); }
  async lightCandle() { await this.play((w, s) => ix.lightCandle(w, s)); }
  async claimQuest(id: string) { const q = QUESTS.find((x) => x.id === id); if (!q) throw new BackendError('quest', 'Unknown quest.'); await this.play((w, s) => ix.claimQuest(w, s, q.bit)); }

  // ---------------------------------------------------------------- Founders' Row
  private plotNames: Record<string, string> = {};
  private async readPlots() {
    const a = await this.er.account(addr.plots()).catch(() => null), l = a && decodePlots(a.data); if (!l) return;
    const unknown = l.map((m) => m.owner).filter((o) => !this.plotNames[o]); if (unknown.length) { const r = await this.get<{ names: Record<string, string> }>(`/who?wallets=${unknown.join(',')}`).catch(() => ({ names: {} })); Object.assign(this.plotNames, r.names); }
    const was = JSON.stringify(store.plots), next: Record<number, Plot> = {};
    for (const m of l) next[m.plot] = { id: m.id, owner: this.plotNames[m.owner] ?? `${m.owner.slice(0, 4)}..${m.owner.slice(-4)}`, name: m.name, skin: MACHINE_SKINS[m.skin] ?? 'gold', bankroll: n(m.bankroll), plays: m.plays, earned: m.earned / 1e6, deed: `deed:machine:${m.id}`, mine: m.owner === this.me, free: n(m.bankroll - m.reserved) };
    store.plots = next; if (JSON.stringify(next) !== was) { bus.emit('plotsChanged'); store.emit(); }
  }
  async claimPlot(id: number, name: string, skin: string, bankroll: number): Promise<Plot> { await this.play((w, s) => ix.claimPlot(w, s, id, name.trim(), Math.max(0, MACHINE_SKINS.indexOf(skin as never)), bankroll)); await this.readPlots(); return store.plots[id]; }
  async fundMachine(id: number, chips: number) { await this.play((w, s) => ix.fundMachine(w, s, id, chips)); await this.readPlots(); }
  async withdrawMachine(id: number, chips: number) { await this.play((w, s) => ix.fundMachine(w, s, id, -chips)); await this.readPlots(); }
  async releasePlot(id: number) { await this.play((w, s) => ix.releasePlot(w, s, id)); await this.readPlots(); }
  async plotsNow() { await this.readPlots(); }

  // ---------------------------------------------------------------- campaigns: the Church oracle co-signs what it has read or seen
  private async session() { const s = await loadSession(this.need()); if (!s) throw new BackendError('BadSession', SAY.BadSession); return s.signer; }
  /** the server built and signed it for this player; we only add the session key */
  private cosigned(tx: string): Promise<string> {
    const run = async () => { const s = await this.session(); try { const sig = await this.er.send(addSignatures(b64decode(tx), [s])); await this.readPlayer(); return sig; } catch (e) { throw friendly(e); } };
    const r = this.queue.then(run, run); this.queue = r.catch(() => {}); return r;
  }
  async campaigns(): Promise<CampaignRow[]> {
    const [bs] = await Promise.all([Promise.all([0, 1].map(async (i) => { const a = await this.er.account(addr.board(i)); return (a && decodeBoard(a.data)) ?? []; })), this.readPlots()]); const p = this.player;
    return bs.flat().sort((a, b) => b.created - a.created).map((c) => ({ id: c.id, kind: c.kind, creator: c.creator, title: c.title, url: c.url, machineId: c.machineId, goal: c.goal, rewardChips: c.rewardChips, rewardFaith: c.rewardFaithMilli / 1000, maxClaims: c.maxClaims, claims: c.claims, active: c.active, free: c.fromTreasury, refund: c.active ? 0 : n(c.budget), claimed: !!p && hasClaimed(p, c.id), progress: p?.machinePlays.find((m) => m.machineId === c.machineId)?.plays ?? 0, mine: c.creator === this.me }));
  }
  async startCampaign(id: number) { const r = await this.post<{ visit_s: number }>(`/campaigns/${id}/start`, {}).catch((e) => { throw friendly(e); }); return { visitS: r.visit_s }; }
  async claimCampaign(id: number) {
    const c = (await this.campaigns()).find((x) => x.id === id); if (!c) throw new BackendError('CampaignClosed', SAY.CampaignClosed); const f = this.player?.faithEarnedMilli ?? 0n;
    if (c.kind === 2) await this.play((w, s) => ix.claimCampaign(w, s, id)); else { const s = await this.session(); const { tx } = await this.post<{ tx: string }>(`/campaigns/${id}/claim`, { session: s.address }); await this.cosigned(tx); }
    return { chips: c.rewardChips, faith: Number((this.player?.faithEarnedMilli ?? 0n) - f) / 1000 };
  }
  async createCampaign(c: NewCampaign) { const s = await this.session(); const before = new Set((await this.campaigns()).map((x) => x.id)); const { tx } = await this.post<{ tx: string }>('/campaigns/approve', { session: s.address, campaign: c }); await this.cosigned(tx); return (await this.campaigns()).find((x) => x.mine && !before.has(x.id))?.id ?? 0; }
  async closeCampaign(id: number) { const open = (await this.campaigns()).find((c) => c.id === id)?.active; if (open) await this.play((w, s) => ix.closeCampaign(w, s, id)); await this.act([ix.collectCampaign(id, this.need())]).catch((e) => { if ((e as BackendError).code !== 'NothingPending') throw e; }); }


  // ---------------------------------------------------------------- chain plumbing
  private need() { if (!this.me) throw new BackendError('signed_out', 'Sign in first.'); return this.me; }
  private ready() { return !!this.me && !!this.player; }
  private async play(make: (wallet: string, signer: string) => Ix): Promise<string> { const w = this.need(), s = await loadSession(w); if (!s) throw new BackendError('BadSession', SAY.BadSession); return this.act([make(w, s.signer.address)]); }
  /** sends to the rollup, signed and "paid" by the session key (it holds no SOL: rollup transactions are free) */
  private act(ixs: Ix[]): Promise<string> {
    const run = async () => {
      const w = this.need(), s = await loadSession(w); if (!s) throw new BackendError('BadSession', SAY.BadSession);
      try { const sig = await this.er.send(buildTx(compileMessage(s.signer.address, ixs, await this.er.blockhash()), [s.signer])); rollupBanner(false); await this.readPlayer(); return sig; }
      catch (e) { if ((e as ChainError).code === 'rollup_down') rollupBanner(true); throw e instanceof ChainError && e.code === 'timeout_wait' ? e : friendly(e); }
    };
    const r = this.queue.then(run, run); this.queue = r.catch(() => {}); return r as Promise<string>;
  }
  private offRollup(e: unknown) { const c = (e as ChainError)?.code; return c === 'custom_3007' || /writable|delegated|InvalidWritableAccount/i.test(String((e as Error)?.message ?? '')); }
  private async waitFor(f: () => Promise<unknown>, ms: number, every = 350) { const t = Date.now(); for (;;) { try { if (await f()) return; } catch (e) { if ((e as ChainError).code === 'rollup_down') rollupBanner(true); else if (Date.now() - t > ms) throw e; } if (Date.now() - t > ms) throw new ChainError('waited too long', 'timeout_wait'); await sleep(every); } }
  private apply(p: PlayerState) {
    this.player = p; const e = store.eco, s = store.stats;
    e.chips = n(p.chips); e.bonus = Number(p.bonus / CHIP); s.candleAt = p.candleAt * 1000; e.luck = p.luckMilli / 1000; e.faith = p.faithMilli / 1000; s.settledAt = Date.now();
    s.spins = p.spins; s.flips = p.flips; s.dice = p.dice; s.harmonyAt = p.harmonyAt * 1000; s.roulette = p.roulette; s.candles = p.candles; s.wagered = Number(p.wagered / CHIP); s.tithed = Number(p.tithed / CHIP); s.converted = Number(p.convertedMilli) / 1000; s.faithEarned = Number(p.faithEarnedMilli) / 1000;
    s.claimed = Object.fromEntries(QUESTS.filter((q) => p.questsClaimed & (1 << q.bit)).map((q) => [q.id, true]));
    this.fade(p.lastUpdate * 1000); store.emit(); this.watchBtc(p);
  }
  private async readPlayer(): Promise<boolean> { const w = this.me; if (!w) return false; const a = await this.er.account(addr.player(w)); const p = a && decodePlayer(a.data); if (!p || w !== this.me) return false; this.apply(p); return true; }
  private async readSol() { const w = this.me; if (!w) return; const b = await this.l1.balance(w); if (w === this.me) { store.eco.sol = sol(b); store.emit(); } }
  private lastSlot = 0; private frozen = 0;
  /** the rollup sometimes freezes for a minute while still answering: its slot number stops moving */
  private async moving(): Promise<boolean> { const s = await this.er.slot(); this.frozen = s === this.lastSlot ? this.frozen + 1 : 0; this.lastSlot = s; return this.frozen === 0; }
  private async poll() { try { await this.readPlayer(); rollupBanner(!(await this.moving())); } catch (e) { if ((e as ChainError).code === 'rollup_down') rollupBanner(true); } if (this.polls++ % 3 === 0) await Promise.all([this.readSol(), this.readHouse()]).catch(() => {}); }
  /** chips and meters arrive as account updates; polling is only the safety net */
  private listen() {
    const w = this.me; if (!w || this.ws) return;
    const ws = new WebSocket(ER_RPC.replace(/^http/, 'ws')); this.ws = ws;
    ws.onopen = () => { this.wsTries = 0; ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'accountSubscribe', params: [addr.player(w), { encoding: 'base64', commitment: 'confirmed' }] })); };
    ws.onmessage = (m) => { try { const v = JSON.parse(m.data).params?.result?.value; const p = v && decodePlayer(b64decode(v.data[0])); if (p && this.me === w) this.apply(p); } catch { /* not for us */ } };
    ws.onclose = () => { if (this.ws !== ws) return; this.ws = null; if (this.me === w) setTimeout(() => this.listen(), Math.min(20_000, 1000 * 2 ** this.wsTries++)); };
  }
  /** the meter of the realm you are not in fades between actions, the way the program will work it out */
  private fade(from = store.stats.settledAt) {
    const now = Date.now(), dt = Math.min(Math.max(0, now - from) / 1000, PARAMS.maxDecayWindowS); store.stats.settledAt = now;
    const d = (dt / 60) * (PARAMS.decayPerMinMilli / 1000); if (d <= 0 || !this.player) return;
    if (this.player.realm === 1) store.eco.faith = Math.max(0, store.eco.faith - d); else if (this.player.realm === 2) store.eco.luck = Math.max(0, store.eco.luck - d); else return;
    store.emit();
  }
  private async readHouse() { const a = await this.er.account(addr.house()); const h = a && decodeHouse(a.data); if (!h) return null; store.stats.jackpot = Number(h.jackpot / CHIP); store.stats.pool = Number(h.treasury / CHIP); store.emit(); return h; }
  private async table() { for (let i = 0; i < 5; i++) { try { const h = await this.readHouse(); if (h) { const b = h.allowedWagers.filter((x) => x <= h.maxBetChips); if (b.length) setTableBets(b); return; } } catch { /* */ } await sleep(1500 * (i + 1)); } }
  private async headers() { const t = await (await loadWallet()).accessToken(); return { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }; }
  private async api_<T>(path: string, init: RequestInit): Promise<T> {
    let res: Response; try { res = await fetch(this.api + path, { ...init, headers: await this.headers(), signal: AbortSignal.timeout(75_000) }); } catch { throw new BackendError('offline', 'The game server is not answering. Try again in a moment.'); }
    const j = await res.json().catch(() => ({})) as any; if (!res.ok) throw new BackendError(String(j.error ?? 'server'), SAY[j.error] ?? j.message ?? 'The server failed. Try again.'); return j as T;
  }
  private get<T>(path: string) { return this.api_<T>(path, { method: 'GET' }); }
  private post<T>(path: string, body: unknown) { return this.api_<T>(path, { method: 'POST', body: JSON.stringify(body) }); }
}

export async function connectSolana(api: string): Promise<SolanaBackend | { offline: string }> {
  try { const r = await fetch(`${api}/healthz`, { signal: AbortSignal.timeout(8_000) }); const h = await r.json() as { program?: string; rollup?: { up: boolean } }; if (h.program !== REALM) return { offline: 'The game server is for another version. Playing the offline demo.' }; const b = new SolanaBackend(api); if (h.rollup && !h.rollup.up) rollupBanner(true); return b; }
  catch { return { offline: 'The game server is not answering. Playing the offline demo.' }; }
}
