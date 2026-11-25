import { addSignatures, addr, b64decode, b64encode, buildTx, ChainError, CHIP, CHIPS_PER_SOL, compileMessage, decodeHouse, decodePlayer, decodePurse, ix, REALM, Rpc, type Ix, type PlayerState } from '@cnc/realm';
import { cleanName, nameProblem } from '@cnc/shared';
import { BackendError } from '../core/errors';
import type { Backend, BetResult, WheelResult } from '../core/backend';
import { bus } from '../core/bus';
import { PARAMS, QUESTS, setTableBets } from '../core/rules';
import { store, type HistRow, type Plot } from '../core/state';
import { ER_RPC, L1_RPC, loadWallet } from '../wallet';
import { rollupBanner } from './banner';
import { dropSession, freshSession, loadSession, saveSession } from './session';

const SAY: Record<string, string> = {
  Paused: 'The game is paused for a moment. Your chips are safe.', DepositsPaused: 'Buying chips is paused for a moment.', PayoutsPaused: 'Payouts are paused for a moment. Your SOL is safe.',
  BadAmount: 'That amount is not allowed.', NoChips: 'Not enough chips. Visit the Cashier.', VaultLow: 'The house cannot cover that right now.', AlreadyClaimed: 'Already claimed.', BetPending: 'Finish your open bet first.',
  BadSession: 'Your session ended. Sign in again to keep playing.', Cooldown: 'Too soon. Wait a moment.', BadName: 'That name is not allowed.', rollup_down: 'The rollup is updating. Your chips are safe. Try again in a minute.', l1_down: 'Solana is not answering. Try again in a moment.',
};
const friendly = (e: unknown): BackendError => {
  if (e instanceof BackendError) return e;
  if (e instanceof ChainError) return new BackendError(e.code, SAY[e.code] ?? (e.code.startsWith('custom_') || e.code === 'rpc' ? 'The chain refused that. Please try again.' : e.message));
  const m = String((e as Error)?.message ?? e); return new BackendError('cancelled', /reject|denied|cancel|closed|exited/i.test(m) ? 'Cancelled.' : 'Something went wrong. Please try again.');
};
const soon = (): never => { throw new BackendError('soon', 'This opens in the next update. Try it in the offline demo.'); };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
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
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && this.me) void this.poll(); });
    void this.table();
  }

  // ---------------------------------------------------------------- account
  address() { return this.me; }
  /** signed in with Privy: what does this wallet still need? `setup` opens the account and/or a session (one popup) */
  async attach(wallet: string): Promise<{ ready: boolean; isNew: boolean; name: string | null; avatar: string | null }> {
    this.me = wallet; this.player = null;
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
  async enterRealm(realm: 'casino' | 'church' | 'plaza') { const n = { plaza: 0, casino: 1, church: 2 }[realm]; if (!this.ready()) return; await this.play((w, s) => ix.enterRealm(w, s, n)).catch((e) => { if ((e as BackendError).code !== 'Cooldown') throw e; void sleep(3200).then(() => { if (store.realm === realm) return this.play((w, s) => ix.enterRealm(w, s, n)); }).catch(() => {}); }); }
  async completeTour(realm: 'casino' | 'church') { if (this.ready()) await this.play((w, s) => ix.completeTour(w, s, realm === 'casino' ? 1 : 2)); }
  async setProfile(name: string, avatar: string) { if (this.ready()) await this.play((w, s) => ix.setProfile(w, s, name, avatar)); }
  toursDone() { const f = this.player?.tourFlags ?? 0; return { casino: !!(f & 2), church: !!(f & 4) }; }

  // ---------------------------------------------------------------- not yet on Solana (M3 to M7)
  async placeBet(): Promise<BetResult> { return soon(); } async spinWheel(): Promise<WheelResult> { return soon(); } async spinHarmony(): Promise<WheelResult> { return soon(); }
  async tithe(): Promise<{ faithGain: number }> { return soon(); } async offerLuck(): Promise<{ faithGain: number }> { return soon(); } async lightCandle() { soon(); } async claimQuest() { soon(); }
  async claimPlot(): Promise<Plot> { return soon(); } async fundMachine() { soon(); } async withdrawMachine() { soon(); }
  async history(): Promise<HistRow[]> { return []; } async leaderboard() { return { rows: [], demo: false }; }

  // ---------------------------------------------------------------- chain plumbing
  private need() { if (!this.me) throw new BackendError('signed_out', 'Sign in first.'); return this.me; }
  private ready() { return !!this.me && !!this.player; }
  private async play(make: (wallet: string, signer: string) => Ix) { const w = this.need(), s = await loadSession(w); if (!s) throw new BackendError('BadSession', SAY.BadSession); await this.act([make(w, s.signer.address)]); }
  /** sends to the rollup, signed and "paid" by the session key (it holds no SOL: rollup transactions are free) */
  private act(ixs: Ix[]): Promise<void> {
    const run = async () => {
      const w = this.need(), s = await loadSession(w); if (!s) throw new BackendError('BadSession', SAY.BadSession);
      try { await this.er.send(buildTx(compileMessage(s.signer.address, ixs, await this.er.blockhash()), [s.signer])); rollupBanner(false); await this.readPlayer(); }
      catch (e) { if ((e as ChainError).code === 'rollup_down') rollupBanner(true); throw e instanceof ChainError && e.code === 'timeout_wait' ? e : friendly(e); }
    };
    const r = this.queue.then(run, run); this.queue = r.catch(() => {}); return r;
  }
  private offRollup(e: unknown) { const c = (e as ChainError)?.code; return c === 'custom_3007' || /writable|delegated|InvalidWritableAccount/i.test(String((e as Error)?.message ?? '')); }
  private async waitFor(f: () => Promise<unknown>, ms: number, every = 350) { const t = Date.now(); for (;;) { try { if (await f()) return; } catch (e) { if ((e as ChainError).code === 'rollup_down') rollupBanner(true); else if (Date.now() - t > ms) throw e; } if (Date.now() - t > ms) throw new ChainError('waited too long', 'timeout_wait'); await sleep(every); } }
  private apply(p: PlayerState) {
    this.player = p; const e = store.eco, s = store.stats;
    e.chips = Number(p.chips / CHIP); e.luck = p.luckMilli / 1000; e.faith = p.faithMilli / 1000; s.settledAt = Date.now();
    s.spins = p.spins; s.flips = p.flips; s.dice = p.dice; s.roulette = p.roulette; s.candles = p.candles; s.wagered = Number(p.wagered / CHIP); s.tithed = Number(p.tithed / CHIP); s.converted = Number(p.convertedMilli) / 1000; s.faithEarned = Number(p.faithEarnedMilli) / 1000;
    s.claimed = Object.fromEntries(QUESTS.filter((q) => p.questsClaimed & (1 << q.bit)).map((q) => [q.id, true]));
    this.fade(p.lastUpdate * 1000); store.emit();
  }
  private async readPlayer(): Promise<boolean> { const w = this.me; if (!w) return false; const a = await this.er.account(addr.player(w)); const p = a && decodePlayer(a.data); if (!p || w !== this.me) return false; this.apply(p); return true; }
  private async readSol() { const w = this.me; if (!w) return; const b = await this.l1.balance(w); if (w === this.me) { store.eco.sol = sol(b); store.emit(); } }
  private async poll() { try { await this.readPlayer(); rollupBanner(false); } catch (e) { if ((e as ChainError).code === 'rollup_down') rollupBanner(true); } if (this.polls++ % 3 === 0) await this.readSol().catch(() => {}); }
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
  private async table() { for (let i = 0; i < 5; i++) { try { const a = await this.er.account(addr.house()); const h = a && decodeHouse(a.data); if (h) { const b = h.allowedWagers.filter((x) => x <= h.maxBetChips); if (b.length) setTableBets(b); return; } } catch { /* */ } await sleep(1500 * (i + 1)); } }
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
