import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'; import { dirname } from 'node:path'; import pg from 'pg';
export interface PlayerRow { wallet: string; did: string; name: string | null; nameKey: string | null; avatar: string | null; createdAt: number }
export interface BetRow { wallet: string; seq: string; game: string; wager: number; payout: number; detail: string; randomness: string; tx: string; at: number }
export interface SolStore {
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
  private betRows: BetRow[] = []; private rows = new Map<string, PlayerRow>(); private log: { kind: string; id: string; at: number }[] = [];
  constructor(private file: string | null) { if (file && existsSync(file)) { const j = JSON.parse(readFileSync(file, 'utf8')); for (const r of j.rows) this.rows.set(r.wallet, r); this.log = j.log ?? []; this.betRows = j.bets ?? []; } }
  private save() { if (!this.file) return; mkdirSync(dirname(this.file), { recursive: true }); this.log = this.log.filter((x) => x.at > Date.now() - 2 * 86_400_000); writeFileSync(this.file, JSON.stringify({ rows: [...this.rows.values()], log: this.log, bets: this.betRows.slice(-5000) })); }
  async addBet(b: BetRow) { if (this.betRows.some((x) => x.wallet === b.wallet && x.seq === b.seq)) return; this.betRows.push(b); this.save(); }
  async bets(w: string, n: number) { return this.betRows.filter((b) => b.wallet === w).slice(-n).reverse(); }
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
      CREATE TABLE IF NOT EXISTS sol_bets (wallet TEXT NOT NULL, seq BIGINT NOT NULL, game TEXT NOT NULL, wager DOUBLE PRECISION NOT NULL, payout DOUBLE PRECISION NOT NULL, detail TEXT NOT NULL, randomness TEXT NOT NULL, tx TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (wallet, seq));`);
    return new PgStore(db);
  }
  async addBet(b: BetRow) { await this.db.query('INSERT INTO sol_bets (wallet, seq, game, wager, payout, detail, randomness, tx, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9/1000.0)) ON CONFLICT DO NOTHING', [b.wallet, b.seq, b.game, b.wager, b.payout, b.detail, b.randomness, b.tx, b.at]); }
  async bets(w: string, n: number) { return (await this.db.query('SELECT * FROM sol_bets WHERE wallet=$1 ORDER BY seq DESC LIMIT $2', [w, n])).rows.map((r) => ({ ...r, seq: String(r.seq), at: +r.at })); }
  async nets() { const m = new Map<string, { wagered: number; net: number }>(); for (const r of (await this.db.query('SELECT wallet, sum(wager) w, sum(payout-wager) n FROM sol_bets GROUP BY wallet')).rows) m.set(r.wallet, { wagered: Number(r.w), net: Number(r.n) }); return m; }
  private async one(sql: string, p: unknown[]): Promise<PlayerRow | null> { const r = (await this.db.query(sql, p)).rows[0]; return r ? { wallet: r.wallet, did: r.did, name: r.name, nameKey: r.name_key, avatar: r.avatar, createdAt: +r.created_at } : null; }
  byWallet(w: string) { return this.one('SELECT * FROM sol_players WHERE wallet=$1', [w]); } byDid(d: string) { return this.one('SELECT * FROM sol_players WHERE did=$1', [d]); } byNameKey(k: string) { return this.one('SELECT * FROM sol_players WHERE name_key=$1', [k]); }
  async link(did: string, wallet: string) { await this.db.query('INSERT INTO sol_players (wallet, did) VALUES ($1,$2) ON CONFLICT DO NOTHING', [wallet, did]); const r = await this.byWallet(wallet); return r?.did === did; }
  async setName(wallet: string, name: string, key: string, avatar: string | null) { try { return (await this.db.query('UPDATE sol_players SET name=$2, name_key=$3, avatar=COALESCE($4, avatar) WHERE wallet=$1', [wallet, name, key, avatar])).rowCount === 1; } catch { return false; } }
  async wallets() { return (await this.db.query('SELECT wallet FROM sol_players')).rows.map((r) => r.wallet); } async count() { return Number((await this.db.query('SELECT count(*) c FROM sol_players')).rows[0].c); }
  async hits(kind: string, id: string, since: number) { return Number((await this.db.query('SELECT count(*) c FROM sol_hits WHERE kind=$1 AND id=$2 AND at >= to_timestamp($3/1000.0)', [kind, id, since])).rows[0].c); }
  async hit(kind: string, id: string) { await this.db.query('INSERT INTO sol_hits (kind, id) VALUES ($1,$2)', [kind, id]); }
}
