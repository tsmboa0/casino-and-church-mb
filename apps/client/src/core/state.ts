import type { Realm, Zone } from '../config';

/** Local profile + mock economy. Replaced by the on-chain record later (PLAN §12). */
export interface Profile {
  username: string;
  avatar: string;
  startRealm: Realm;
  toursDone: { casino: boolean; church: boolean };
  /** the Solana wallet this profile belongs to (none in the offline demo) */
  wallet?: string;
}
/** `bonus`: free chips. They are played before real ones and cannot be cashed out; what they win is real */
export interface Economy { chips: number; bonus: number; luck: number; faith: number; sol: number; }
/** counters that drive the quest board (mock; becomes on-chain records later) */
export interface Stats {
  spins: number; flips: number; dice: number; roulette: number; tithed: number; candles: number; converted: number;
  wagered: number; faithEarned: number; claimed: Record<string, boolean>;
  pool: number; jackpot: number; candleAt: number; harmonyAt: number; settledAt: number; nextBet: number;
  net: number; history: HistRow[];
}
/** one settled play, newest first (the chain version comes from the indexer: GET /bets?account=) */
export interface HistRow { t: number; game: string; wager: number; payout: number; detail: string; /** settling tx on chain */ tx?: string }
export interface Plot { id: number; owner: string; name: string; skin: string; bankroll: number; plays: number; earned: number; deed: string; /** chain: is it mine, and how many chips are not held for a spin */ mine?: boolean; free?: number }
const ECO_KEY = 'cnc.eco.v1';
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const KEY = 'cnc.profile.v1';
export function loadProfile(): Profile | null {
  try { const s = localStorage.getItem(KEY); return s ? JSON.parse(s) : null; } catch { return null; }
}
export function saveProfile(p: Profile) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode */ } }
export function clearProfile() { try { localStorage.removeItem(KEY); localStorage.removeItem(POS_KEY); } catch { /* */ } }
/** where the player last stood, so CONTINUE puts them back on the same spot (per device, like the profile) */
const POS_KEY = 'cnc.pos.v1';
export interface SavedPos { name: string; x: number; y: number; at: number }
export function loadPos(name: string): SavedPos | null {
  try { const p = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null') as SavedPos | null; return p && p.name === name && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null; } catch { return null; }
}
export function savePos(p: SavedPos) { try { localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch { /* private mode: start at the Crossroads next time */ } }

type Listener = () => void;
class Store {
  profile: Profile | null = loadProfile();
  eco: Economy = { chips: 500, bonus: 0, luck: 34, faith: 22, sol: 0.5 };
  stats: Stats = { spins: 0, flips: 0, dice: 0, roulette: 0, tithed: 0, candles: 0, converted: 0, wagered: 0, faithEarned: 0, claimed: {}, pool: 1280, jackpot: 2500, candleAt: 0, harmonyAt: 0, settledAt: Date.now(), nextBet: 1, net: 0, history: [] };
  plots: Record<number, Plot> = {};
  constructor() {
    try { const s = localStorage.getItem(ECO_KEY); if (s) { const j = JSON.parse(s); Object.assign(this.eco, j.eco); Object.assign(this.stats, j.stats); Object.assign(this.plots, j.plots ?? {}); } } catch { /* */ }
  }
  /** apply a delta to the economy (chips >= 0, LUCK/FAITH 0..100) and tell the HUD */
  change(d: Partial<Economy>) {
    const e = this.eco;
    if (d.chips) e.chips = Math.max(0, Math.round((e.chips + d.chips) * 100) / 100);
    if (d.bonus) e.bonus = Math.max(0, Math.round(e.bonus + d.bonus));
    if (d.luck) e.luck = clamp(e.luck + d.luck, 0, 100);
    if (d.faith) e.faith = clamp(e.faith + d.faith, 0, 100);
    this.saveEco(); this.emit();
  }
  saveEco() { try { localStorage.setItem(ECO_KEY, JSON.stringify({ eco: this.eco, stats: this.stats, plots: this.plots })); } catch { /* */ } }
  realm: Zone = 'casino';
  private ls = new Set<Listener>();
  on(l: Listener) { this.ls.add(l); return () => this.ls.delete(l); }
  emit() { this.ls.forEach(l => l()); }
  setRealm(r: Zone) { if (this.realm !== r) { this.realm = r; this.emit(); } }
  setProfile(p: Profile) { this.profile = p; saveProfile(p); this.emit(); }
}
export const store = new Store();
