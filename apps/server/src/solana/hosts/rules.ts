import type { HostId } from '@cnc/shared';
import type { Snapshot } from './observe.ts';
import { checkDecision, type Plan } from './policy.ts';
import { templateLine } from './persona.ts';

/**
 * Deterministic fallback (R3-4) when the model is disabled, over the token budget or failing.
 * It proposes an action and runs it through the SAME guardrails as the model, so it can never do more.
 *   Don:    vault_free under 30% of the day's high -> lower max bet one step;
 *           the Church out-draws the Casino for 2 cycles and no event today -> Happy Hour 20 min +20%.
 *   Father: the Casino holds more than 2x the Church's players for 2 cycles -> Vigil 20 min +20%;
 *           an eligible player ran dry -> alms (30 chips, or what the day's budget allows).
 */
export interface RuleMemory {
  vaultHigh: { day: number; chips: number };
  streak: number;
}

export const newRuleMemory = (): RuleMemory => ({ vaultHigh: { day: 0, chips: 0 }, streak: 0 });

/** Lower the table one step when the free vault is thin. Returns the next max bet, or null to hold. */
export function nextTableLimit(vaultFree: number, dayHigh: number, maxBet: number, floor: number): number | null {
  if (dayHigh <= 0 || vaultFree >= dayHigh * 0.3) return null;
  const next = Math.max(floor, Math.ceil(maxBet * 0.8));
  return next < maxBet ? next : null;
}

export function rulesDecide(agent: HostId, s: Snapshot, mem: RuleMemory, seed = s.at): Plan {
  const none: Plan = { action: 'none', params: {}, line: templateLine(agent, 'none', seed), call: null };
  const attempt = (action: string, params: Record<string, number | string>): Plan | null => {
    const r = checkDecision(agent, { action, params, line: templateLine(agent, action, seed) }, s);
    return r.ok ? r.plan : null;
  };

  if (agent === 'fortuna') {
    const day = Math.floor(s.at / 86_400_000);
    if (mem.vaultHigh.day !== day) mem.vaultHigh = { day, chips: s.vault_free };
    mem.vaultHigh.chips = Math.max(mem.vaultHigh.chips, s.vault_free);
    const floor = Math.max(10, ...s.params.allowed_wagers);
    const lower = nextTableLimit(s.vault_free, mem.vaultHigh.chips, s.params.max_bet, floor);
    if (lower !== null) {
      const p = attempt('set_max_bet', { value: lower });
      if (p) return p;
    }
    mem.streak = s.players_online > 0 && s.in_church > s.in_casino ? mem.streak + 1 : 0;
    if (mem.streak >= 2 && s.events_today.casino === 0) {
      const p = attempt('start_happy_hour', { minutes: 20 });
      if (p) { mem.streak = 0; return p; }
    }
    return none;
  }

  mem.streak = s.in_casino > 0 && s.in_casino > 2 * s.in_church ? mem.streak + 1 : 0;
  if (mem.streak >= 2) {
    const p = attempt('start_vigil', { minutes: 20, boost_pct: 20 });
    if (p) { mem.streak = 0; return p; }
  }
  const poor = s.eligible_for_alms[0];
  const chips = Math.min(30, s.alms_budget_today);
  if (poor && chips >= 1) {
    const p = attempt('grant_alms', { account: poor.alias, chips });
    if (p) return p;
  }
  return none;
}
