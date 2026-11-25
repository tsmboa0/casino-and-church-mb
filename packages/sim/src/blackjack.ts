/** Blackjack on an ordinary shuffled deck with the panel's rules: a second opinion on the program's own 400,000-hand test. */
import { blackjackPayout, handTotal, tenOrAce } from '../../../apps/client/src/core/rules.ts';
import { randomInt } from 'node:crypto';
const N = Number(process.env.HANDS ?? 1_000_000); let staked = 0, back = 0, sq = 0; const tally: Record<string, number> = {};
for (let i = 0; i < N; i++) {
  const gone = new Set<number>(), draw = () => { for (;;) { const c = randomInt(52); if (!gone.has(c)) { gone.add(c); return c; } } };
  const player = [draw()], dealer = [draw()]; player.push(draw()); let stake = 10, dealerPlays = true, over = false;
  if (handTotal(player).total === 21) { if (tenOrAce(dealer[0])) dealer.push(draw()); over = true; dealerPlays = false; }
  while (!over) {
    const { total: t, soft } = handTotal(player), up = dealer[0] % 13;
    if (player.length === 2 && !soft && (t === 10 || t === 11) && up >= 1 && up <= 8) { stake = 20; player.push(draw()); over = true; dealerPlays = handTotal(player).total <= 21; }
    else if (t >= 17 || (t >= 13 && up >= 1 && up <= 5 && !soft)) over = true;
    else { player.push(draw()); const n = handTotal(player).total; if (n >= 21) { over = true; dealerPlays = n === 21; } }
  }
  if (dealerPlays) while (handTotal(dealer).total < 17) dealer.push(draw());
  const r = blackjackPayout(player, dealer, 10, stake); staked += stake; back += r.pay; sq += ((r.pay - stake) / 10) ** 2; tally[r.label] = (tally[r.label] ?? 0) + 1;
}
const per = (back - staked) / (N * 10), se = Math.sqrt(sq / N / N); console.log(JSON.stringify({ hands: N, perBet: +per.toFixed(4), standardError: +se.toFixed(4), returnedOfChipsInPlay: +(back / staked).toFixed(4), tally }));
