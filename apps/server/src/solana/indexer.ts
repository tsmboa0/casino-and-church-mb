import { b64decode, GAME_NAMES, REALM, settledFromLogs, type Rpc, type SettledEvent } from '@cnc/realm';
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
    default: return '';
  }
}
export const toRow = (e: SettledEvent, tx: string, at: number): BetRow => ({ wallet: e.wallet, seq: String(e.seq), game: GAME_NAMES[e.game] ?? String(e.game), wager: Number(e.wager) / 1e6, payout: Number(e.payout) / 1e6, detail: detail(e), randomness: Buffer.from(e.randomness).toString('hex'), tx, at });

/** Follows the program's settled bets on the rollup. The rollup keeps its history for a limited time, so we keep ours. */
export class Indexer {
  status = { connected: false, seen: 0, lastAt: 0, reconnects: 0, backfilled: 0 };
  private ws: WebSocket | null = null; private on = false; private done = new Set<string>();
  constructor(private er: Rpc, private store: SolStore) {}
  start() { this.on = true; void this.backfill(); this.connect(); setInterval(() => void this.backfill(), 60_000).unref(); }
  private connect() {
    const ws = new WebSocket(this.er.url.replace(/^http/, 'ws')); this.ws = ws;
    ws.onopen = () => { this.status.connected = true; ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [REALM] }, { commitment: 'confirmed' }] })); void this.backfill(); };
    ws.onmessage = (m) => { try { const v = JSON.parse(String(m.data)).params?.result?.value; if (v && !v.err) void this.take(v.signature, v.logs, Date.now()); } catch { /* not ours */ } };
    ws.onclose = () => { this.status.connected = false; if (!this.on || this.ws !== ws) return; this.status.reconnects++; setTimeout(() => this.connect(), 3_000); }; ws.onerror = () => { try { ws.close(); } catch { /* */ } };
  }
  private async take(sig: string, logs: string[], at: number) {
    if (this.done.has(sig)) return; this.done.add(sig); if (this.done.size > 5_000) this.done = new Set([...this.done].slice(-2_500));
    for (const e of settledFromLogs(logs ?? [], b64decode)) { await this.store.addBet(toRow(e, sig, at)); this.status.seen++; this.status.lastAt = at; }
  }
  /** what the socket missed: the newest transactions of our program */
  private async backfill() {
    try {
      const sigs = await this.er.call<{ signature: string; err: unknown; blockTime: number | null }[]>('getSignaturesForAddress', [REALM, { limit: 100, commitment: 'confirmed' }]);
      for (const s of sigs.reverse()) { if (s.err || this.done.has(s.signature)) continue; const t = await this.er.call('getTransaction', [s.signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]); if (t?.meta) { const n = this.status.seen; await this.take(s.signature, t.meta.logMessages, (s.blockTime ?? Date.now() / 1000) * 1000); this.status.backfilled += this.status.seen - n; } }
    } catch { /* next minute */ }
  }
}
