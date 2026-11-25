/** Re-checks a settled bet in the browser, from the chain itself: not from our server. */
import { addr, b64decode, BJ, drawsOf, GAME_NAMES, handStepsFromLogs, P, settledFromLogs, Shoe, type HandStepEvent, type Rpc, type SettledEvent } from '@cnc/realm';
import { handTotal, HARMONY_PRIZES, pickWeighted, resolveCoin, resolveDice, resolveRoulette, resolveSlots, SLOT_SYMS, tenOrAce, WHEEL_PRIZES } from '../core/rules';
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
    case 'wheel': return `PRIZE ${pickWeighted(WHEEL_PRIZES, d[0])}`;
    case 'harmony': { const p = pickWeighted(HARMONY_PRIZES, d[0]); return p === 'JACKPOT' ? p : `PRIZE ${p}`; }
    default: return '';
  }
}
export function recordedText(game: number, o: number[]): string {
  switch (GAME_NAMES[game]) {
    case 'slots': return o.slice(0, 3).map((i) => SLOT_SYMS[i]).join(' ').toUpperCase();
    case 'coinflip': return o[0] === 0 ? 'HEADS' : 'TAILS';
    case 'dice': return `${o[0]} + ${o[1]}`;
    case 'roulette': return `${o[0]} ${['GREEN', 'RED', 'BLACK'][o[1]]}`;
    case 'wheel': return `PRIZE ${WHEEL_PRIZES[o[0]]?.[0]}`;
    case 'harmony': return o[0] === 255 ? 'JACKPOT' : `PRIZE ${HARMONY_PRIZES[o[0]]?.[0]}`;
    case 'blackjack': return `${o[0]} v ${o[1]}`;
    default: return '';
  }
}
/** deals a whole hand again from the oracle's answers; null when any card on chain differs, or a step is missing */
export function replayHand(steps: HandStepEvent[]): { player: number[]; dealer: number[] } | null {
  const player: number[] = [], dealer: number[] = []; let used = 0n;
  for (const [i, s] of [...steps].sort((a, b) => a.step - b.step).entries()) {
    if ((i === 0) !== (s.action === BJ.deal) || s.step !== player.length) return null;
    const shoe = new Shoe(s.randomness, used), total = (c: number[]) => handTotal(c).total; let dealerPlays = s.action === BJ.stand;
    if (s.action === BJ.deal) { player.push(shoe.draw()); dealer.push(shoe.draw()); player.push(shoe.draw()); if (total(player) === 21 && tenOrAce(dealer[0])) dealer.push(shoe.draw()); }
    else if (s.action !== BJ.stand) { player.push(shoe.draw()); const t = total(player); dealerPlays = t === 21 || (s.action === BJ.double && t < 21); }
    if (dealerPlays) while (total(dealer) < 17) dealer.push(shoe.draw());
    used = shoe.used; if (String(player) !== String(s.player) || String(dealer) !== String(s.dealer)) return null;
  }
  return player.length ? { player, dealer } : null;
}
export async function checkBet(er: Rpc, wallet: string, proof: BetProof): Promise<BetCheck> {
  const sigs = await er.call<{ signature: string; err: unknown }[]>('getSignaturesForAddress', [addr.player(wallet), { limit: 60, commitment: 'confirmed' }]);
  let end: { e: SettledEvent; tx: string } | null = null, fromVrf = true; const steps: HandStepEvent[] = [];
  for (const s of sigs) {
    if (s.err) continue;
    const t = await er.call('getTransaction', [s.signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]); const logs: string[] = t?.meta?.logMessages ?? [];
    const e = settledFromLogs(logs, b64decode).find((x) => x.wallet === wallet && String(x.seq) === proof.seq), step = handStepsFromLogs(logs, b64decode).find((x) => x.wallet === wallet && String(x.seq) === proof.seq);
    if (!e && !step) continue;
    // the VRF program ran first, checked the oracle's proof, and called ours: that is the only way in
    const top = logs.find((l) => / invoke \[1\]/.test(l) && !l.includes(P.computeBudget)) ?? ''; fromVrf &&= top.includes(P.vrf) && logs.some((l) => /Instruction: (SettleBet|BjSettle|SettleMachineBet)/.test(l));
    if (e) end = { e, tx: s.signature }; if (step) steps.push(step);
    if (end && (GAME_NAMES[end.e.game] !== 'blackjack' || steps.some((x) => x.action === BJ.deal))) break;
  }
  if (!end) return { found: false, tx: null, randomness: proof.randomness, fromVrf: false, recomputed: '', recorded: '', matches: false };
  const { e, tx } = end, recorded = recordedText(e.game, e.outcome); let recomputed = outcomeText(e.game, e.randomness);
  if (GAME_NAMES[e.game] === 'blackjack') { const h = replayHand(steps); recomputed = h ? `${handTotal(h.player).total} v ${handTotal(h.dealer).total}` : 'NOT THE SAME CARDS'; }
  return { found: true, tx, randomness: hex(e.randomness), fromVrf, recomputed, recorded, matches: recomputed === recorded, answers: Math.max(1, steps.length) };
}
