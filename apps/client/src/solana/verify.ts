/** Re-checks a settled bet in the browser, from the chain itself: not from our server. */
import { addr, b64decode, drawsOf, GAME_NAMES, P, settledFromLogs, type Rpc } from '@cnc/realm';
import { resolveCoin, resolveDice, resolveRoulette, resolveSlots, SLOT_SYMS } from '../core/rules';
import type { BetCheck, BetProof } from '../core/backend';

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
/** what these random bytes must give, worked out here with the same rules the panels use */
export function outcomeText(game: number, randomness: Uint8Array): string {
  const d = drawsOf(randomness);
  switch (GAME_NAMES[game]) {
    case 'slots': return resolveSlots(d).reels.join(' ').toUpperCase();
    case 'coinflip': return resolveCoin(d) === 'H' ? 'HEADS' : 'TAILS';
    case 'dice': { const r = resolveDice(d, 0); return `${r.dice[0]} + ${r.dice[1]}`; }
    case 'roulette': { const r = resolveRoulette(d, 0); return `${r.n} ${r.color.toUpperCase()}`; }
    default: return '';
  }
}
export function recordedText(game: number, o: number[]): string {
  switch (GAME_NAMES[game]) {
    case 'slots': return o.slice(0, 3).map((i) => SLOT_SYMS[i]).join(' ').toUpperCase();
    case 'coinflip': return o[0] === 0 ? 'HEADS' : 'TAILS';
    case 'dice': return `${o[0]} + ${o[1]}`;
    case 'roulette': return `${o[0]} ${['GREEN', 'RED', 'BLACK'][o[1]]}`;
    default: return '';
  }
}
export async function checkBet(er: Rpc, wallet: string, proof: BetProof): Promise<BetCheck> {
  const sigs = await er.call<{ signature: string; err: unknown }[]>('getSignaturesForAddress', [addr.player(wallet), { limit: 40, commitment: 'confirmed' }]);
  for (const s of sigs) {
    if (s.err) continue;
    const t = await er.call('getTransaction', [s.signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]); const logs: string[] = t?.meta?.logMessages ?? [];
    const e = settledFromLogs(logs, b64decode).find((x) => x.wallet === wallet && String(x.seq) === proof.seq); if (!e) continue;
    // the VRF program ran first, checked the oracle's proof, and called ours: that is the only way in
    const top = logs.find((l) => / invoke \[1\]/.test(l) && !l.includes(P.computeBudget)) ?? ''; const inside = logs.some((l) => /Instruction: SettleBet/.test(l));
    const mine = outcomeText(e.game, e.randomness), onChain = recordedText(e.game, e.outcome);
    return { found: true, tx: s.signature, randomness: hex(e.randomness), fromVrf: top.includes(P.vrf) && inside, recomputed: mine, recorded: onChain, matches: mine === onChain };
  }
  return { found: false, tx: null, randomness: proof.randomness, fromVrf: false, recomputed: '', recorded: '', matches: false };
}
