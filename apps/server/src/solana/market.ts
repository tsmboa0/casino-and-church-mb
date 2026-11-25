import { addr, b64decode, buildTx, compileMessage, decodeMarket, ix, MARKET_HEAD, OUTCOMES, REALM, roundsFromLogs, type Ix, type MarketState, type PlayerState, type Rpc, type Signer } from '@cnc/realm';
import type { RoundRow, SolStore } from './store.ts';

/**
 * Looks after the BTC market. The crank runs the rounds; this is the backup and the tidying:
 *   - prices a round only if the crank is late (it is the keeper the program knows), voids one that is too late;
 *   - claims for everyone a moment after each close, so nobody has to;
 *   - saves the market to L1 every hour, and writes finished rounds into Solana's own history.
 * If it stops, rounds go on, and every bet still settles when its owner next plays.
 */
export class MarketKeeper {
  status = { running: false, at: 0, epoch: 0, enabled: false, lastTickTs: 0, rescued: 0, claimed: 0, checkpoints: 0, rotations: 0, pages: 0, errors: 0, lastError: null as string | null };
  head: MarketState | null = null; private full: MarketState | null = null; private timer: NodeJS.Timeout | null = null;
  private seen = 0n; private saving = false; private lastSave = 0; private logged = new Set<number>(); private offAt = 0; private busy = new Set<string>();
  constructor(private l1: Rpc, private er: Rpc, private key: Signer, private store: SolStore, private now = () => Date.now() / 1000) {}
  start() { this.status.running = true; const go = async () => { await this.tick(); if (this.status.running) this.timer = setTimeout(go, 2_000); }; this.timer = setTimeout(go, 1_000); }
  stop() { this.status.running = false; if (this.timer) clearTimeout(this.timer); }
  private fail = (e: unknown) => { this.status.errors++; this.status.lastError = String((e as Error)?.message ?? e).slice(0, 160); };
  private async send(rpc: Rpc, ixs: Ix[]) { return rpc.send(buildTx(compileMessage(this.key.address, ixs, await rpc.blockhash()), [this.key])); }
  async readHead(): Promise<MarketState | null> { const v = (await this.er.call('getAccountInfo', [addr.market(), { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: MARKET_HEAD } }])).value; return v ? decodeMarket(b64decode(v.data[0])) : null; }
  async tick() {
    try {
      const m = await this.readHead(); if (!m) return; this.head = m; const now = this.now();
      Object.assign(this.status, { epoch: Number(m.open.epoch), enabled: m.enabled, lastTickTs: m.lastTickTs });
      if (m.enabled && now > m.open.lockTs + 4) { await this.send(this.er, [ix.marketTick(this.key.address)]).then(() => { this.status.rescued++; }, (e) => { if (e.code !== 'NotAllowed') throw e; }); }
      if (this.seen && m.open.epoch !== this.seen) await this.closed(m);
      if (!this.seen) await this.closed(m);
      this.seen = m.open.epoch;
      if (!this.lastSave) this.lastSave = (await this.l1.account(addr.market()).then((a) => (a ? decodeMarket(a.data)?.lastTickTs : 0)).catch(() => 0)) || now - 3_500;      // L1's copy says when it was saved
      if (m.enabled && now - this.lastSave > 3_600 && now >= m.open.openTs + 2 && now <= m.open.openTs + 8) void this.save(m);
      if (Date.now() - this.offAt > 30_000) { this.offAt = Date.now(); void this.back(); }
    } catch (e) { this.fail(e); }
    this.status.at = Date.now();
  }
  /** one or more rounds just ended: keep them, and settle everybody who was in */
  private async closed(m: MarketState) {
    const a = await this.er.account(addr.market()), f = a && decodeMarket(a.data); if (!f) return; this.full = f;
    for (const r of f.rounds.slice(0, 12)) await this.store.addRound(toRound(r, null));
    const done = f.rounds.slice(0, 6).map((r) => r.epoch);
    for (const w of new Set((await this.store.calls(done)).map((c) => c.wallet))) void this.claim(w);
    void m;
  }
  /** rounds that are over: not the one taking bets, not the one being decided */
  isOver(epoch: bigint) { const m = this.head; return !!m && epoch < m.open.epoch && epoch !== (m.live?.epoch ?? 0n); }
  async claim(w: string) {
    if (this.busy.has(w)) return; this.busy.add(w);
    try { await this.send(this.er, [ix.marketClaim(w)]); this.status.claimed++; } catch (e) { this.fail(e); } finally { this.busy.delete(w); }
  }
  /** called by the other keeper with every player it reads: whatever the fast path missed */
  async sweep(w: string, p: PlayerState) { if (p.btc.some((s) => this.isOver(s.epoch))) await this.claim(w); }

  /** hourly: the market's saved copy on L1. The ninth save also takes it off the rollup (10 are allowed), and `back` returns it */
  private async save(m: MarketState) {
    if (this.saving) return; this.saving = true;
    try {
      await this.send(this.er, [ix.marketCheckpoint(this.key.address)]); this.lastSave = this.now(); this.status.checkpoints++;
      if (m.commits + 1 >= 9) for (let i = 0; i < 30 && !(await this.back()); i++) await new Promise((r) => setTimeout(r, 700));
      await new Promise((r) => setTimeout(r, 12_000)); await this.record();
    } catch (e) { this.fail(e); this.lastSave = this.now() - 3_300; } finally { this.saving = false; }      // try again in five minutes
  }
  /** the market is on L1 (a rotation): put it on the rollup again */
  async back(): Promise<boolean> {
    try { const a = await this.l1.account(addr.market()); if (!a || a.owner !== REALM) return false; await this.send(this.l1, [ix.delegateMarket(this.key.address)]); this.status.rotations++; return true; } catch (e) { this.fail(e); return false; }
  }
  /** every finished page of 60 rounds that L1 has in full and Solana's history does not */
  async record() {
    const a = await this.l1.account(addr.market()), f = a && decodeMarket(a.data); if (!f?.rounds.length) return;
    const last = Math.floor(f.rounds[0].epoch / 60), first = Math.max(0, Math.ceil(f.rounds[f.rounds.length - 1].epoch / 60) - 1), have = new Set(f.rounds.map((r) => r.epoch));
    for (let page = first; page < last; page++) {
      if (this.logged.has(page) || ![...Array(60).keys()].some((i) => have.has(page * 60 + i))) continue;
      const before = await this.l1.call<{ err: unknown; signature: string }[]>('getSignaturesForAddress', [addr.roundsPage(page), { limit: 5, commitment: 'confirmed' }]).catch(() => null); if (!before) continue;
      const old = before.find((s) => !s.err); const tx = old ? old.signature : await this.send(this.l1, [ix.computeLimit(600_000), ix.logRounds(page)]); if (!old) this.status.pages++;
      this.logged.add(page); await this.store.setPage(page, tx);
    }
  }
}
export const toRound = (r: { epoch: number | bigint; outcome: number; lockC: number; closeC: number; closedTs: number; up: number; down: number; bets: number }, tx: string | null): RoundRow => ({ epoch: Number(r.epoch), outcome: OUTCOMES[r.outcome] ?? 'void', lock: r.lockC / 100, close: r.closeC / 100, closedAt: r.closedTs * 1000, up: r.up, down: r.down, bets: r.bets, tx, page: null });
export { roundsFromLogs };
