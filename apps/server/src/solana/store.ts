import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'; import { dirname } from 'node:path'; import pg from 'pg';
export interface PlayerRow { wallet: string; did: string; name: string | null; nameKey: string | null; avatar: string | null; createdAt: number }
export interface BetRow { wallet: string; seq: string; game: string; wager: number; payout: number; detail: string; randomness: string; tx: string; at: number }
export interface CallRow { wallet: string; seq: string; epoch: number; side: 'up' | 'down'; chips: number }
/** a finished BTC round. `tx`: the rollup transaction that closed it; `page`: the L1 transaction that recorded it */
export interface RoundRow { epoch: number; outcome: string; lock: number; close: number; closedAt: number; up: number; down: number; bets: number; tx: string | null; page: string | null }
export interface SolStore {
  addCall(c: CallRow): Promise<void>; calls(epochs: number[]): Promise<CallRow[]>; maxSeq(wallet: string): Promise<bigint>;
  addRound(r: RoundRow): Promise<void>; rounds(before: number | null, limit: number): Promise<RoundRow[]>; setPage(page: number, tx: string): Promise<void>;
  addBet(b: BetRow): Promise<void>; bets(wallet: string, limit: number): Promise<BetRow[]>; nets(): Promise<Map<string, { wagered: number; net: number }>>;
  byWallet(w: string): Promise<PlayerRow | null>; byDid(d: string): Promise<PlayerRow | null>; byNameKey(k: string): Promise<PlayerRow | null>;
  /** links a Privy user and a wallet, once and for all. False when either already belongs to someone else */
  link(did: string, wallet: string): Promise<boolean>;
  setName(wallet: string, name: string, key: string, avatar: string | null): Promise<boolean>;
  wallets(): Promise<string[]>; count(): Promise<number>;
  hits(kind: string, id: string, sinceMs: number): Promise<number>; hit(kind: string, id: string): Promise<void>;
}
/** development, and a fallback with no database: memory, saved to a small file */
export class FileStore implements SolStore {
  private betRows: BetRow[] = []; private rows = new Map<string, PlayerRow>(); private log: { kind: string; id: string; at: number }[] = []; private callRows: CallRow[] = []; private roundRows = new Map<number, RoundRow>(); private pages: Record<number, string> = {}; private later: NodeJS.Timeout | null = null;
  constructor(private file: string | null) { if (file && existsSync(file)) { const j = JSON.parse(readFileSync(file, 'utf8')); for (const r of j.rows) this.rows.set(r.wallet, r); this.log = j.log ?? []; this.betRows = j.bets ?? []; this.callRows = j.calls ?? []; for (const r of j.rounds ?? []) this.roundRows.set(r.epoch, r); this.pages = j.pages ?? {}; } }
  /** rounds and calls come all day: one write a few seconds later covers them */
  private soon() { if (this.file && !this.later) { this.later = setTimeout(() => { this.later = null; this.save(); }, 3_000); this.later.unref(); } }
  private save() { if (!this.file) return; mkdirSync(dirname(this.file), { recursive: true }); this.log = this.log.filter((x) => x.at > Date.now() - 2 * 86_400_000); writeFileSync(this.file, JSON.stringify({ rows: [...this.rows.values()], log: this.log, bets: this.betRows.slice(-5000), calls: this.callRows.slice(-2000), rounds: [...this.roundRows.values()].slice(-12_000), pages: this.pages })); }
  async addBet(b: BetRow) { if (this.betRows.some((x) => x.wallet === b.wallet && x.seq === b.seq)) return; this.betRows.push(b); this.save(); }
  async bets(w: string, n: number) { return this.betRows.filter((b) => b.wallet === w).slice(-n).reverse(); }
  async maxSeq(w: string) { return [...this.betRows, ...this.callRows].reduce((m, b) => (b.wallet === w && BigInt(b.seq) > m ? BigInt(b.seq) : m), 0n); }
  async addCall(c: CallRow) { if (this.callRows.some((x) => x.wallet === c.wallet && x.seq === c.seq)) return; this.callRows.push(c); this.soon(); }
  async calls(e: number[]) { return this.callRows.filter((c) => e.includes(c.epoch)); }
  async addRound(r: RoundRow) { const o = this.roundRows.get(r.epoch); if (o && (o.tx || !r.tx)) return; this.roundRows.set(r.epoch, { ...r, tx: r.tx ?? o?.tx ?? null }); this.soon(); }
  async rounds(before: number | null, n: number) { return [...this.roundRows.values()].filter((r) => before === null || r.epoch < before).sort((a, b) => b.epoch - a.epoch).slice(0, n).map((r) => ({ ...r, page: this.pages[Math.floor(r.epoch / 60)] ?? null })); }
  async setPage(p: number, tx: string) { this.pages[p] = tx; this.soon(); }
  async nets() { const m = new Map<string, { wagered: number; net: number }>(); for (const b of this.betRows) { const e = m.get(b.wallet) ?? { wagered: 0, net: 0 }; e.wagered += b.wager; e.net += b.payout - b.wager; m.set(b.wallet, e); } return m; }
  private find(f: (r: PlayerRow) => boolean) { for (const r of this.rows.values()) if (f(r)) return { ...r }; return null; }
  async byWallet(w: string) { return this.find((r) => r.wallet === w); } async byDid(d: string) { return this.find((r) => r.did === d); } async byNameKey(k: string) { return this.find((r) => r.nameKey === k); }
  async link(did: string, wallet: string) { const a = await this.byDid(did), b = await this.byWallet(wallet); if (a || b) return a?.wallet === wallet && b?.did === did; this.rows.set(wallet, { wallet, did, name: null, nameKey: null, avatar: null, createdAt: Date.now() }); this.save(); return true; }
  async setName(wallet: string, name: string, key: string, avatar: string | null) { const o = await this.byNameKey(key); if (o && o.wallet !== wallet) return false; const r = this.rows.get(wallet); if (!r) return false; r.name = name; r.nameKey = key; if (avatar) r.avatar = avatar; this.save(); return true; }
  async wallets() { return [...this.rows.keys()]; } async count() { return this.rows.size; }
  async hits(kind: string, id: string, since: number) { return this.log.filter((x) => x.kind === kind && x.id === id && x.at >= since).length; }
  async hit(kind: string, id: string) { this.log.push({ kind, id, at: Date.now() }); this.save(); }
}
export class PgStore implements SolStore {
  private constructor(private db: pg.Pool) {}
  static async open(url: string) {
    const db = new pg.Pool({ connectionString: url.replace(/[?&]sslmode=[^&]*/, ''), ssl: { rejectUnauthorized: false }, max: 5 });
    await db.query(`CREATE TABLE IF NOT EXISTS sol_players (wallet TEXT PRIMARY KEY, did TEXT NOT NULL UNIQUE, name TEXT, name_key TEXT UNIQUE, avatar TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS sol_hits (kind TEXT NOT NULL, id TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now()); CREATE INDEX IF NOT EXISTS sol_hits_ix ON sol_hits (kind, id, at DESC);
      CREATE TABLE IF NOT EXISTS sol_bets (wallet TEXT NOT NULL, seq BIGINT NOT NULL, game TEXT NOT NULL, wager DOUBLE PRECISION NOT NULL, payout DOUBLE PRECISION NOT NULL, detail TEXT NOT NULL, randomness TEXT NOT NULL, tx TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (wallet, seq));
      CREATE TABLE IF NOT EXISTS sol_calls (wallet TEXT NOT NULL, seq BIGINT NOT NULL, epoch BIGINT NOT NULL, side TEXT NOT NULL, chips DOUBLE PRECISION NOT NULL, PRIMARY KEY (wallet, seq)); CREATE INDEX IF NOT EXISTS sol_calls_ix ON sol_calls (epoch);
      CREATE TABLE IF NOT EXISTS sol_rounds (epoch BIGINT PRIMARY KEY, outcome TEXT NOT NULL, lock_price DOUBLE PRECISION NOT NULL, close_price DOUBLE PRECISION NOT NULL, closed_at TIMESTAMPTZ NOT NULL, up DOUBLE PRECISION NOT NULL, down DOUBLE PRECISION NOT NULL, bets INT NOT NULL, tx TEXT);
      CREATE TABLE IF NOT EXISTS sol_pages (page BIGINT PRIMARY KEY, tx TEXT NOT NULL);`);
    return new PgStore(db);
  }
  async addBet(b: BetRow) { await this.db.query('INSERT INTO sol_bets (wallet, seq, game, wager, payout, detail, randomness, tx, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9/1000.0)) ON CONFLICT DO NOTHING', [b.wallet, b.seq, b.game, b.wager, b.payout, b.detail, b.randomness, b.tx, b.at]); }
  async bets(w: string, n: number) { return (await this.db.query('SELECT * FROM sol_bets WHERE wallet=$1 ORDER BY seq DESC LIMIT $2', [w, n])).rows.map((r) => ({ ...r, seq: String(r.seq), at: +r.at })); }
  async maxSeq(w: string) { return BigInt((await this.db.query('SELECT COALESCE(max(s),0) m FROM (SELECT max(seq) s FROM sol_bets WHERE wallet=$1 UNION SELECT max(seq) FROM sol_calls WHERE wallet=$1) x', [w])).rows[0].m); }
  async addCall(c: CallRow) { await this.db.query('INSERT INTO sol_calls (wallet, seq, epoch, side, chips) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [c.wallet, c.seq, c.epoch, c.side, c.chips]); }
  async calls(e: number[]) { return (await this.db.query('SELECT * FROM sol_calls WHERE epoch = ANY($1::bigint[]) ORDER BY epoch, seq', [e])).rows.map((r) => ({ wallet: r.wallet, seq: String(r.seq), epoch: Number(r.epoch), side: r.side, chips: Number(r.chips) })); }
  async addRound(r: RoundRow) { await this.db.query('INSERT INTO sol_rounds (epoch, outcome, lock_price, close_price, closed_at, up, down, bets, tx) VALUES ($1,$2,$3,$4,to_timestamp($5/1000.0),$6,$7,$8,$9) ON CONFLICT (epoch) DO UPDATE SET tx = COALESCE(sol_rounds.tx, EXCLUDED.tx)', [r.epoch, r.outcome, r.lock, r.close, r.closedAt, r.up, r.down, r.bets, r.tx]); }
  async rounds(before: number | null, n: number) { return (await this.db.query('SELECT r.*, p.tx AS page_tx FROM sol_rounds r LEFT JOIN sol_pages p ON p.page = r.epoch / 60 WHERE $1::bigint IS NULL OR r.epoch < $1 ORDER BY r.epoch DESC LIMIT $2', [before, n])).rows.map((r) => ({ epoch: Number(r.epoch), outcome: r.outcome, lock: Number(r.lock_price), close: Number(r.close_price), closedAt: +r.closed_at, up: Number(r.up), down: Number(r.down), bets: r.bets, tx: r.tx, page: r.page_tx })); }
  async setPage(p: number, tx: string) { await this.db.query('INSERT INTO sol_pages (page, tx) VALUES ($1,$2) ON CONFLICT DO NOTHING', [p, tx]); }
  async nets() { const m = new Map<string, { wagered: number; net: number }>(); for (const r of (await this.db.query('SELECT wallet, sum(wager) w, sum(payout-wager) n FROM sol_bets GROUP BY wallet')).rows) m.set(r.wallet, { wagered: Number(r.w), net: Number(r.n) }); return m; }
  private async one(sql: string, p: unknown[]): Promise<PlayerRow | null> { const r = (await this.db.query(sql, p)).rows[0]; return r ? { wallet: r.wallet, did: r.did, name: r.name, nameKey: r.name_key, avatar: r.avatar, createdAt: +r.created_at } : null; }
  byWallet(w: string) { return this.one('SELECT * FROM sol_players WHERE wallet=$1', [w]); } byDid(d: string) { return this.one('SELECT * FROM sol_players WHERE did=$1', [d]); } byNameKey(k: string) { return this.one('SELECT * FROM sol_players WHERE name_key=$1', [k]); }
  async link(did: string, wallet: string) { await this.db.query('INSERT INTO sol_players (wallet, did) VALUES ($1,$2) ON CONFLICT DO NOTHING', [wallet, did]); const r = await this.byWallet(wallet); return r?.did === did; }
  async setName(wallet: string, name: string, key: string, avatar: string | null) { try { return (await this.db.query('UPDATE sol_players SET name=$2, name_key=$3, avatar=COALESCE($4, avatar) WHERE wallet=$1', [wallet, name, key, avatar])).rowCount === 1; } catch { return false; } }
  async wallets() { return (await this.db.query('SELECT wallet FROM sol_players')).rows.map((r) => r.wallet); } async count() { return Number((await this.db.query('SELECT count(*) c FROM sol_players')).rows[0].c); }
  async hits(kind: string, id: string, since: number) { return Number((await this.db.query('SELECT count(*) c FROM sol_hits WHERE kind=$1 AND id=$2 AND at >= to_timestamp($3/1000.0)', [kind, id, since])).rows[0].c); }
  async hit(kind: string, id: string) { await this.db.query('INSERT INTO sol_hits (kind, id) VALUES ($1,$2)', [kind, id]); }
}
