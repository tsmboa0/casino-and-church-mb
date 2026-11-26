import type { HostId } from '@cnc/shared';
import { addr, b64decode, CHIP, decodeHouse, decodePlayer, type HouseState, type PlayerState, type Rpc } from '@cnc/realm';
import type { DecisionRow, SolStore } from '../store.ts';

/**
 * What a host decides on: the House as the rollup has it, the players' own accounts, and our copy of the bets. Under
 * ~600 tokens as JSON; whole chips. Accounts never go to the model: alms candidates get aliases (p1, p2...).
 */
export interface Snapshot {
  at: number;
  vault: number; vault_free: number; reserved: number; treasury: number; jackpot: number;
  players_online: number; in_casino: number; in_church: number; in_plaza: number;
  volume_1h: number; volume_24h: number; house_net_1h: number; house_net_24h: number; timeouts_24h: number;
  biggest_win_24h: { chips: number; game: string } | null;
  tithes_24h: number; candles_24h: number; alms_24h: number;
  params: { max_bet: number; luck_per_chip_milli: number; blessing_cap_bps: number; candle_faith_milli: number; allowed_wagers: number[] };
  active_events: { kind: string; realm: 'casino' | 'church'; minutes_left: number; boost_pct: number; by: string }[];
  events_today: { casino: number; church: number };
  minutes_since_event_start: { casino: number; church: number };
  minutes_since_param_change: number;
  minutes_since_church_change: number;
  jackpot_topup_max_now: number;
  alms_budget_today: number;
  eligible_for_alms: { alias: string; chips: number }[];
  alias_to_account: Record<string, string>;
  rival_last_3: { action: string; line: string; minutes_ago: number }[];
  your_last_3: { action: string; line: string; applied: boolean; minutes_ago: number }[];
}
const DAY = 86_400_000, HOUR = 3_600_000, ONLINE = 15 * 60_000;
const c = (v: bigint) => Number(v / CHIP);

/** every known player's account on the rollup, a hundred at a time */
export async function players(er: Rpc, wallets: string[]): Promise<{ wallet: string; p: PlayerState }[]> {
  const out: { wallet: string; p: PlayerState }[] = [];
  for (let i = 0; i < wallets.length; i += 100) {
    const part = wallets.slice(i, i + 100), r = await er.call('getMultipleAccounts', [part.map(addr.player), { encoding: 'base64', commitment: 'confirmed' }]);
    part.forEach((w, k) => { const v = r.value[k], p = v && decodePlayer(b64decode(v.data[0])); if (p) out.push({ wallet: w, p }); });
  }
  return out;
}
export function presence(ps: { p: PlayerState }[], now = Date.now()) {
  const on = ps.filter(({ p }) => now - p.lastUpdate * 1000 < ONLINE);
  const n = (r: number) => on.filter(({ p }) => p.realm === r).length;
  return { online: on.length, casino: n(1), church: n(2), plaza: n(0) };
}

export interface ObserveDeps { er: Rpc; store: SolStore; church: () => { tithes: number; candles: number } }
export async function observe(deps: ObserveDeps, agent: HostId, now = Date.now()): Promise<Snapshot> {
  const { er, store } = deps;
  const [acct, wallets, day, hour, history] = await Promise.all([er.account(addr.house()), store.wallets(), store.betStats(now - DAY), store.betStats(now - HOUR), store.decisions('all', 60)]);
  const h = decodeHouse(acct!.data) as HouseState, x = h.hosts, sec = now / 1000;
  const ps = await players(er, wallets), on = presence(ps, now);
  const applied = history.filter((d) => d.applied);
  const ago = (t: number) => Math.floor((now - t) / 60_000), since = (t: number) => (t > 0 ? Math.floor((sec - t) / 60) : 9_999);
  const today = Math.floor(sec / 86_400);
  const vault = c(h.vault), reserved = c(h.reserved), free = Math.max(0, vault - reserved), treasury = c(h.treasury);
  // alms: players active today who ran dry, by the program's own rule
  const eligible: { alias: string; chips: number }[] = [], alias: Record<string, string> = {};
  if (agent === 'nakamoto') for (const { wallet, p } of ps.sort((a, b) => b.p.lastUpdate - a.p.lastUpdate)) {
    if (eligible.length >= 5 || sec - p.lastUpdate > 86_400) break;
    if (p.chips + p.bonus < 50n * CHIP && (p.wagered >= 100n * CHIP || p.candles >= 1) && (p.lastAlms === 0 || sec >= p.lastAlms + 86_400)) { const a = `p${eligible.length + 1}`; eligible.push({ alias: a, chips: c(p.chips + p.bonus) }); alias[a] = wallet; }
  }
  const almsBase = x.almsDay === today ? x.almsBase : h.treasury, almsSpent = x.almsDay === today ? x.almsSpent : 0n;
  const almsCap = (almsBase * 200n / 10_000n > 100n * CHIP ? almsBase * 200n / 10_000n : 100n * CHIP);
  const topupSpent = x.topupDay === today ? Number(x.topupSpent) : 0;
  const rival: HostId = agent === 'fortuna' ? 'nakamoto' : 'fortuna';
  const ch = deps.church();
  return {
    at: now, vault, vault_free: free, reserved, treasury, jackpot: c(h.jackpot),
    players_online: on.online, in_casino: on.casino, in_church: on.church, in_plaza: on.plaza,
    volume_1h: Math.round(hour.volume), volume_24h: Math.round(day.volume), house_net_1h: Math.round(hour.houseNet), house_net_24h: Math.round(day.houseNet), timeouts_24h: 0,
    biggest_win_24h: day.biggest ? { chips: Math.round(day.biggest.payout), game: day.biggest.game } : null,
    tithes_24h: ch.tithes, candles_24h: ch.candles, alms_24h: Number(almsSpent / CHIP),
    params: { max_bet: h.maxBetChips, luck_per_chip_milli: x.luckPerChipMilli, blessing_cap_bps: x.blessingCapBps, candle_faith_milli: x.candleFaithMilli, allowed_wagers: h.allowedWagers },
    active_events: x.events.map((e, i) => ({ e, i })).filter(({ e }) => e.active && e.ends > sec).map(({ e, i }) => ({ kind: i ? 'vigil' : 'happy_hour', realm: (i ? 'church' : 'casino') as 'casino' | 'church', minutes_left: Math.ceil((e.ends - sec) / 60), boost_pct: i ? Math.round(e.boostBps / 100) : 100, by: i ? 'nakamoto' : 'fortuna' })),
    events_today: { casino: x.eventsDay === today ? x.eventsToday[0] : 0, church: x.eventsDay === today ? x.eventsToday[1] : 0 },
    minutes_since_event_start: { casino: since(x.lastEventStart[0]), church: since(x.lastEventStart[1]) },
    minutes_since_param_change: since(x.lastAgentChange), minutes_since_church_change: since(x.lastPriestChange),
    // the program: vault_free >= 3 x (reserved + chips), at most 500 a call and 2,000 a day
    jackpot_topup_max_now: Math.max(0, Math.min(500, 2_000 - topupSpent, Math.floor(free / 3) - reserved)),
    alms_budget_today: Math.max(0, Math.min(Number((almsCap - almsSpent) / CHIP), treasury)),
    eligible_for_alms: eligible, alias_to_account: alias,
    rival_last_3: history.filter((d: DecisionRow) => d.agent === rival).slice(0, 3).map((d) => ({ action: d.action, line: d.line, minutes_ago: ago(d.at) })),
    your_last_3: history.filter((d) => d.agent === agent).slice(0, 3).map((d) => ({ action: d.action, line: d.line, applied: d.applied, minutes_ago: ago(d.at) })),
  };
  void applied;
}

/** what the model sees: no account map */
export function forModel(s: Snapshot, agent: HostId) {
  const { alias_to_account: _a, at: _t, eligible_for_alms, alms_budget_today, jackpot_topup_max_now, minutes_since_church_change, minutes_since_param_change, ...rest } = s;
  return agent === 'fortuna' ? { ...rest, jackpot_topup_max_now, minutes_since_param_change } : { ...rest, eligible_for_alms, alms_budget_today, minutes_since_church_change };
}
