/**
 * Canonical game + economy rules (PURE functions, no UI, no randomness source of their own).
 * The Rust contract (contracts/realm) must reproduce every function here bit-for-bit; the
 * conformance vectors in scripts/rtp_check.py and BACKEND_PLAN.md §6 prove it.
 *
 * Randomness: every game consumes `draws` = eight little-endian u32 values taken from
 *   h = sha256(server_seed || client_seed || chain_seed || bet_id as u64 LE)   (32 bytes)
 *   draws[k] = u32 LE of h[4k .. 4k+4]
 * and maps a draw to [0, n) with mulShift (no modulo bias): floor(draw * n / 2^32).
 */
export const CHIPS_PER_SOL = 1000;                  // 1 chip = 0.001 SOL

export const mulShift = (draw: number, n: number) => Math.floor((draw * n) / 4294967296);
export const drawsOf = (h: Uint8Array) => Array.from({ length: 8 }, (_, k) => (h[4 * k] | (h[4 * k + 1] << 8) | (h[4 * k + 2] << 16) | (h[4 * k + 3] << 24)) >>> 0);
export const randomDraws = () => { const a = new Uint32Array(8); crypto.getRandomValues(a); return Array.from(a); };

// ------------------------------------------------------------------------------------------ slots
export const SLOT_SYMS = ['seven', 'diamond', 'clover', 'coin', 'cross'] as const;
export type SlotSym = (typeof SLOT_SYMS)[number];
export const SLOT_W = [4, 8, 14, 24, 50];                                        // per 100
export const SLOT_TRIPLE: Record<SlotSym, number> = { seven: 100, diamond: 40, clover: 15, coin: 8, cross: 3 };   // x wager
export const SLOT_PAIR = 1;                                                       // x wager: exactly two ADJACENT reels match
export function resolveSlots(d: number[]): { reels: SlotSym[]; payX: number } {
  const reels = [0, 1, 2].map((k) => {
    const r = mulShift(d[k], 100); let acc = 0;
    for (let i = 0; i < 5; i++) { acc += SLOT_W[i]; if (r < acc) return SLOT_SYMS[i]; }
    return SLOT_SYMS[4];
  });
  const [a, b, c] = reels;
  const payX = a === b && b === c ? SLOT_TRIPLE[a] : a === b || b === c ? SLOT_PAIR : 0;
  return { reels, payX };
}

// ------------------------------------------------------------------------------------------ coin flip
export const COIN_PAY_BPS = 19400;                                                // 1.94x on a win (RTP 97%)
export const resolveCoin = (d: number[]) => (mulShift(d[0], 2) === 0 ? 'H' : 'T') as 'H' | 'T';

// ------------------------------------------------------------------------------------------ dice (two dice, sum)
export const DICE_OU_BPS = 22800, DICE_SEVEN_BPS = 57000;                         // RTP 95% each
/** pick: 0 = under 7 (sum 2..6), 1 = exactly 7, 2 = over 7 (sum 8..12), 3 = field.
 *  Field pays 3x on 2 or 12 and 2x on 3, 4, 9, 10, 11 (RTP 34/36). The first three picks stay at 95%. */
export function resolveDice(d: number[], pick: number) {
  const a = mulShift(d[0], 6) + 1, b = mulShift(d[1], 6) + 1, sum = a + b;
  if (pick === 3) {
    const payX = sum === 2 || sum === 12 ? 3 : sum === 3 || sum === 4 || sum === 9 || sum === 10 || sum === 11 ? 2 : 0;
    return { dice: [a, b] as [number, number], sum, payBps: payX * 10000 };
  }
  const win = pick === 0 ? sum < 7 : pick === 1 ? sum === 7 : pick === 2 ? sum > 7 : false;
  return { dice: [a, b] as [number, number], sum, payBps: win ? (pick === 1 ? DICE_SEVEN_BPS : DICE_OU_BPS) : 0 };
}

// ------------------------------------------------------------------------------------------ roulette (single zero)
export const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
export const ROULETTE_PICK = { red: 100, black: 101, odd: 102, even: 103, low: 104, high: 105, dozen1: 110, dozen2: 111, dozen3: 112, col1: 120, col2: 121, col3: 122 } as const;
/** pick: 0..36 straight-up (pays 36x), 100..105 even-money (pays 2x; zero loses them all),
 *  110..112 dozens and 120..122 columns (pay 3x; zero loses them; RTP 36/37). */
export function resolveRoulette(d: number[], pick: number) {
  const n = mulShift(d[0], 37);
  const color = n === 0 ? 'green' : RED.has(n) ? 'red' : 'black';
  let win = false, payX = 0;
  if (pick >= 0 && pick <= 36) { win = n === pick; payX = 36; }
  else if (n !== 0 && pick >= 100 && pick <= 105) {
    win = pick === 100 ? RED.has(n) : pick === 101 ? !RED.has(n) : pick === 102 ? n % 2 === 1 : pick === 103 ? n % 2 === 0 : pick === 104 ? n <= 18 : n >= 19;
    payX = 2;
  } else if (n !== 0 && pick >= 110 && pick <= 112) {
    win = pick === 110 ? n <= 12 : pick === 111 ? n >= 13 && n <= 24 : n >= 25;
    payX = 3;
  } else if (n !== 0 && pick >= 120 && pick <= 122) {
    win = pick === 120 ? n % 3 === 1 : pick === 121 ? n % 3 === 2 : n % 3 === 0;
    payX = 3;
  }
  return { n, color, payX: win ? payX : 0 };
}

// ------------------------------------------------------------------------------------------ wheels
export const WHEEL_PRIZES: [number, number][] = [[10, 30], [25, 30], [50, 20], [100, 15], [250, 4], [500, 1]];      // [chips, weight per 100]
export const HARMONY_PRIZES: [number | 'JACKPOT', number][] = [[150, 40], [300, 30], [600, 20], [1500, 9], ['JACKPOT', 1]];
export function pickWeighted<T>(table: [T, number][], draw: number): T {
  const r = mulShift(draw, 100); let acc = 0;
  for (const [v, w] of table) { acc += w; if (r < acc) return v; }
  return table[table.length - 1][0];
}

// ------------------------------------------------------------------------------------------ economy parameters (defaults; the contract exposes them as bounded params)
export const PARAMS = {
  luckPerChipMilli: 80,            // LUCK per chip wagered x1000 (0.08). Mainnet recommendation: 40.
  luckPerBetCapMilli: 8000,        // max LUCK from a single bet (8.0)
  decayPerMinMilli: 500,           // the meter of the realm you are NOT in loses 0.5 per minute
  maxDecayWindowS: 900,            // offline protection: never settle more than 15 minutes of decay
  offerRatioBps: 8000,             // 1 LUCK offered at the altar -> 0.8 FAITH
  tithePerTenChipsFaithMilli: 1000,// 10 chips tithed -> 1 FAITH before diminishing returns
  candleFaithMilli: 3000,
  candleCooldownS: 15,             // DEMO value. Production: 86_400 (daily)
  harmonyCostMilli: 20000,         // consumes 20 LUCK and 20 FAITH
  harmonyCooldownS: 120,           // DEMO value. Production: 86_400
  harmonyMinMilli: 50000,
  welcomeGrantChips: 500,
  treasuryBpsOfWager: 50,          // 0.5% of every wager -> church treasury
  jackpotBpsOfWager: 25,           // 0.25% of every wager -> jackpot pool
  quoteBets: [10, 25, 50, 100],
};

/**
 * The chips the panels offer. Offline it is PARAMS.quoteBets; in chain mode ChainBackend replaces it with the
 * contract's `allowed_wagers` (only those at or under the effective max bet), so a panel can never offer a bet
 * the contract would refuse.
 */
export const TABLE = { bets: [...PARAMS.quoteBets] as number[] };
export function setTableBets(bets: number[]) {
  const clean = [...new Set(bets.filter((b) => Number.isInteger(b) && b > 0))].sort((a, b) => a - b);
  if (clean.length) TABLE.bets = clean;
}
/** the allowed chip closest to what a panel would like to start with */
export const tableBet = (want: number) => (TABLE.bets.includes(want) ? want : TABLE.bets.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a)));


/** FAITH tiers: payout bonus in basis points, paid from the church treasury */
export const BLESSING = [
  { min: 0, title: 'Wanderer', bps: 0 }, { min: 25, title: 'Believer', bps: 50 }, { min: 50, title: 'Devout', bps: 150 },
  { min: 75, title: 'Zealot', bps: 250 }, { min: 100, title: 'Saint', bps: 300 },
];
export const blessingOf = (faith: number) => [...BLESSING].reverse().find((t) => faith >= t.min)!;
/** payout (chips) for a winning bet: base x (10000 + blessing) / 10000, rounded down */
export const withBlessing = (base: number, faith: number) => Math.floor((base * (10000 + blessingOf(faith).bps)) / 10000);

/** LUCK granted by one bet, in LUCK units */
export const luckForBet = (wager: number) => Math.min(PARAMS.luckPerBetCapMilli, wager * PARAMS.luckPerChipMilli) / 1000;
/** FAITH granted by tithing `chips` chips at current faith (diminishing: full value at 0 faith, half at 100) */
export const faithForTithe = (chips: number, faith: number) => (chips / 10) * (PARAMS.tithePerTenChipsFaithMilli / 1000) * (1 - faith / 200);

// ------------------------------------------------------------------------------------------ plots (founders' row)
export const PLOT_GATE = { wagered: 100, faithEarned: 5 };          // reputation gate (contract v3: 100 chips wagered + 5 FAITH earned)
export const PLOT_MIN_BANKROLL = 100;                              // contract minimum
/** a machine must cover a spin's top prize (slots pay up to 100x) at the smallest table bet to take any bet at all */
export function plotPlayableBankroll() { return Math.max(PLOT_MIN_BANKROLL, Math.min(...TABLE.bets) * 100); }
export const MACHINE_SKINS = ['gold', 'purple', 'red', 'blue'] as const;

// ------------------------------------------------------------------------------------------ quests (all verified from on-chain counters; no oracle needed)
export type Counter = 'spins' | 'flips' | 'tithed' | 'candles' | 'converted';
export interface QuestDef { id: string; bit: number; title: string; desc: string; counter: Counter; goal: number; reward: { chips?: number; faith?: number; luck?: number }; rewardText: string }
export const QUESTS: QuestDef[] = [
  { id: 'q-spin', bit: 0, title: 'First Spins', desc: 'Spin the slots 3 times.', counter: 'spins', goal: 3, reward: { chips: 50 }, rewardText: '50 chips' },
  { id: 'q-flip', bit: 1, title: 'Heads or Tails', desc: 'Flip a coin once.', counter: 'flips', goal: 1, reward: { chips: 40 }, rewardText: '40 chips' },
  { id: 'q-tithe', bit: 2, title: 'Generous Soul', desc: 'Tithe 50 chips at the Offering Box.', counter: 'tithed', goal: 50, reward: { faith: 5 }, rewardText: '+5 FAITH' },
  { id: 'q-candle', bit: 3, title: 'Keep the Flame', desc: 'Light 2 votive candles.', counter: 'candles', goal: 2, reward: { luck: 4 }, rewardText: '+4 LUCK' },
  { id: 'q-altar', bit: 4, title: 'Turn Luck to Faith', desc: 'Convert 20 LUCK at the Altar.', counter: 'converted', goal: 20, reward: { chips: 100 }, rewardText: '100 chips' },
];

// ------------------------------------------------------------------------------------------ blackjack (mirrors contract blackjack.rs)
/** cards are 0..51: rank = c % 13 (0 = A, 9..12 = T J Q K), suit = floor(c / 13) in C D H S. Names like "AS", "TD". */
export const cardName = (c: number) => 'A23456789TJQK'[c % 13] + 'CDHS'[Math.floor(c / 13)];
export function handTotal(cards: number[]): { total: number; soft: boolean } {
  let sum = 0, aces = 0;
  for (const c of cards) { const r = c % 13; if (r === 0) { aces++; sum += 11; } else sum += r >= 9 ? 10 : r + 1; }
  while (sum > 21 && aces > 0) { sum -= 10; aces--; }
  return { total: sum, soft: aces > 0 };
}
export const tenOrAce = (c: number) => c % 13 === 0 || c % 13 >= 9;
/** chips back (before blessing) for a finished hand; stake = chips in play (2x the original if doubled) */
export function blackjackPayout(player: number[], dealer: number[], original: number, stake: number): { pay: number; label: 'natural' | 'win' | 'push' | 'lose' } {
  const pt = handTotal(player).total, dt = handTotal(dealer).total;
  const pn = player.length === 2 && pt === 21, dn = dealer.length === 2 && dt === 21;
  if (pn && dn) return { pay: original, label: 'push' };
  if (pn) return { pay: Math.floor((original * 5) / 2), label: 'natural' };
  if (dn) return { pay: Math.max(0, stake - original), label: 'lose' };
  if (pt > 21) return { pay: 0, label: 'lose' };
  if (dt > 21 || pt > dt) return { pay: stake * 2, label: 'win' };
  if (pt === dt) return { pay: stake, label: 'push' };
  return { pay: 0, label: 'lose' };
}
