import { addr, b64decode, campaignsOpenedFromLogs, churchFromLogs, decodeMarket, decodePlayer, GAME_NAMES, marketBetsFromLogs, marketSettledFromLogs, OUTCOMES, REALM, roundsFromLogs, settledFromLogs, type MarketSettledEvent, type Rpc, type SettledEvent } from '@cnc/realm';
import { toRound } from './market.ts';
import type { BetRow, SolStore } from './store.ts';

const SYM = ['SEVEN', 'DIAMOND', 'CLOVER', 'COIN', 'CROSS'], COLOUR = ['GREEN', 'RED', 'BLACK'], WHEEL = [10, 25, 50, 100, 250, 500], HARMONY = [150, 300, 600, 1500];
export function detail(e: Pick<SettledEvent, 'game' | 'outcome' | 'jackpot'>): string {
  const o = e.outcome;
  switch (GAME_NAMES[e.game]) {
    case 'slots': return o.slice(0, 3).map((i) => SYM[i]).join(' ');
    case 'coinflip': return o[0] === 0 ? 'HEADS' : 'TAILS';
    case 'dice': return `${o[0]} + ${o[1]} = ${o[0] + o[1]}`;
    case 'roulette': return `${o[0]} ${COLOUR[o[1]]}`;
    case 'wheel': return `WHEEL ${WHEEL[o[0]]}`;
    case 'harmony': return e.jackpot ? 'JACKPOT' : `HARMONY ${HARMONY[o[0]]}`;
    case 'blackjack': return `${o[0]} v ${o[1]}${o[2] === 3 ? ' BLACKJACK' : o[3] ? ' DOUBLE' : ''}`;
    default: return '';
  }
}
export const toRow = (e: SettledEvent, tx: string, at: number): BetRow => ({ wallet: e.wallet, seq: String(e.seq), game: GAME_NAMES[e.game] ?? String(e.game), wager: Number(e.wager) / 1e6, payout: Number(e.payout) / 1e6, detail: detail(e), randomness: Buffer.from(e.randomness).toString('hex'), tx, at });

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
export const marketRow = (e: MarketSettledEvent, tx: string, at: number): BetRow => ({ wallet: e.wallet, seq: String(e.seq), game: 'btc', wager: Number(e.wager) / 1e6, payout: Number(e.payout) / 1e6, randomness: '', tx, at, detail: `${e.side === 1 ? 'UP' : 'DOWN'} #${e.epoch} ${e.outcome === 1 || e.outcome === 2 ? `${usd(e.lockC)} to ${usd(e.closeC)}` : (OUTCOMES[e.outcome] ?? '').toUpperCase()}` });

/**
 * Follows everything our program says on the rollup, which keeps its history for a limited time, so we keep ours. Live
 * from the socket; what that missed is found again through each player's own account, because the program's own history
 * is a market tick every second.
 */
export class Indexer {
  status = { connected: false, seen: 0, rounds: 0, lastAt: 0, reconnects: 0, backfilled: 0 };
  private ws: WebSocket | null = null; private on = false; private done = new Set<string>(); private heard = 0; private filling = false;
  /** tithes and candles as they happen (the hosts watch the church with it) */
  onChurch: (kind: 'tithe' | 'candle', chips: number, at: number) => void = () => {};
  constructor(private er: Rpc, private store: SolStore) {}
  start() { this.on = true; this.connect(); setInterval(() => void this.backfill(), 60_000).unref(); setInterval(() => { if (this.status.connected && Date.now() - this.heard > 45_000) this.ws?.close(); }, 15_000).unref(); }
  private connect() {
    const ws = new WebSocket(this.er.url.replace(/^http/, 'ws')); this.ws = ws; this.heard = Date.now();
    ws.onopen = () => { this.status.connected = true; ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [REALM] }, { commitment: 'confirmed' }] })); void this.backfill().then(() => this.backfillRounds()); };
    ws.onmessage = (m) => { this.heard = Date.now(); try { const v = JSON.parse(String(m.data)).params?.result?.value; if (v && !v.err) void this.take(v.signature, v.logs, Date.now()); } catch { /* not ours */ } };
    ws.onclose = () => { this.status.connected = false; if (!this.on || this.ws !== ws) return; this.status.reconnects++; setTimeout(() => this.connect(), 3_000); }; ws.onerror = () => { try { ws.close(); } catch { /* */ } };
  }
  async take(sig: string, logs: string[], at: number) {
    if (!logs?.some((l) => l.startsWith('Program data: '))) return;      // most are ticks with nothing to say
    if (this.done.has(sig)) return; this.done.add(sig); if (this.done.size > 5_000) this.done = new Set([...this.done].slice(-2_500));
    const saw = () => { this.status.seen++; this.status.lastAt = at; };
    for (const e of settledFromLogs(logs, b64decode)) { await this.store.addBet(toRow(e, sig, at)); saw(); }
    for (const e of marketBetsFromLogs(logs, b64decode)) await this.store.addCall({ wallet: e.wallet, seq: String(e.seq), epoch: Number(e.epoch), side: e.side === 1 ? 'up' : 'down', chips: Number(e.wager) / 1e6 });
    for (const e of marketSettledFromLogs(logs, b64decode)) { await this.store.addBet(marketRow(e, sig, at)); saw(); }
    for (const e of churchFromLogs(logs, b64decode)) this.onChurch(e.kind, e.chips, at);
    for (const e of campaignsOpenedFromLogs(logs, b64decode)) await this.store.bindDetails(e.wallet, e.id);
    for (const e of roundsFromLogs(logs, b64decode)) { await this.store.addRound(toRound(e, sig)); this.status.rounds++; }
  }
  private async tx(sig: string, blockTime: number | null) { const t = await this.er.call('getTransaction', [sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]); if (t?.meta) await this.take(sig, t.meta.logMessages, (blockTime ?? Date.now() / 1000) * 1000); }
  /** players whose account is ahead of what we stored: read just their own transactions */
  async backfill() {
    if (this.filling) return; this.filling = true;
    try {
      const ws = await this.store.wallets();
      for (let i = 0; i < ws.length; i += 100) {
        const part = ws.slice(i, i + 100), r = await this.er.call('getMultipleAccounts', [part.map(addr.player), { encoding: 'base64', commitment: 'confirmed' }]);
        for (let k = 0; k < part.length; k++) {
          const v = r.value[k], p = v && decodePlayer(b64decode(v.data[0])); if (!p) continue;
          const newest = p.recent[0]?.seq ?? 0n; if (newest <= await this.store.maxSeq(part[k])) continue;
          const n = this.status.seen; for (const s of (await this.er.call<{ signature: string; err: unknown; blockTime: number | null }[]>('getSignaturesForAddress', [addr.player(part[k]), { limit: 200, commitment: 'confirmed' }])).reverse()) if (!s.err && !this.done.has(s.signature)) await this.tx(s.signature, s.blockTime);
          this.status.backfilled += this.status.seen - n;
        }
      }
    } catch { /* next minute */ } finally { this.filling = false; }
  }
  /** rounds that closed while we were away: their closing second is known, so only those transactions are read */
  async backfillRounds() {
    try {
      const a = await this.er.account(addr.market()), m = a && decodeMarket(a.data); if (!m) return;
      const have = new Set((await this.store.rounds(null, 300)).filter((r) => r.tx).map((r) => r.epoch)), need = new Map(m.rounds.filter((r) => !have.has(r.epoch)).map((r) => [r.closedTs, r.epoch])); if (!need.size) return;
      let before: string | undefined; const oldest = Math.min(...need.keys());
      for (let page = 0; page < 20; page++) {
        const s = await this.er.call<{ signature: string; err: unknown; blockTime: number | null }[]>('getSignaturesForAddress', [addr.market(), { limit: 1000, commitment: 'confirmed', ...(before ? { before } : {}) }]); if (!s.length) return;
        for (const x of s) if (!x.err && x.blockTime && [x.blockTime - 1, x.blockTime, x.blockTime + 1].some((t) => need.has(t)) && !this.done.has(x.signature)) await this.tx(x.signature, x.blockTime);
        before = s[s.length - 1].signature; if ((s[s.length - 1].blockTime ?? 0) < oldest) return;
      }
    } catch { /* the rounds are known anyway; only their links are missing */ }
  }
}
