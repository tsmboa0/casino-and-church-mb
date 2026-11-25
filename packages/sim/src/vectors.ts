import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { drawsOf, pickWeighted, resolveCoin, resolveDice, resolveRoulette, resolveSlots, HARMONY_PRIZES as HARMONY_NOW, WHEEL_PRIZES } from '../../../apps/client/src/core/rules.ts';

// the vectors hold the first version's Harmony prizes; the slices are the same, the prizes became free chips and smaller
const HARMONY_PRIZES = HARMONY_NOW.map(([p, w], i) => [p === 'JACKPOT' ? p : [150, 300, 600, 1500][i], w]) as typeof HARMONY_NOW;
const doc = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../onchain/programs/realm/vectors.json'), 'utf8'));
const cases = [...doc.fixed, ...doc.random];
let bad = 0;
for (const row of cases) {
  const h = Uint8Array.from(Buffer.from(row.h, 'hex'));
  const draws = drawsOf(h);
  const slots = resolveSlots(draws);
  const coin = resolveCoin(draws);
  const dice = resolveDice(draws, 0).dice;
  const roulette = resolveRoulette(draws, 0);
  const wheel = pickWeighted(WHEEL_PRIZES, draws[0]);
  const harmony = pickWeighted(HARMONY_PRIZES, draws[0]);
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(BigInt(row.bet_id));
  const again = createHash('sha256')
    .update(Buffer.from(row.server, 'hex'))
    .update(Buffer.from(row.client, 'hex'))
    .update(Buffer.from(row.chain, 'hex'))
    .update(id)
    .digest('hex');
  const ok = again === row.h
    && slots.reels.join() === row.slots.join()
    && slots.payX === row.slots_pay_x
    && coin === row.coin
    && dice.join() === row.dice.join()
    && roulette.n === row.roulette_n
    && roulette.color === row.roulette_color
    && wheel === row.wheel
    && String(harmony) === String(row.harmony);
  if (!ok) bad++;
}
if (bad) {
  console.error(`${bad} vector mismatches`);
  process.exit(1);
}
console.log(`ts vectors ok: ${cases.length}`);
