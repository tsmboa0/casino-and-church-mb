// The card rule written a second time, from its description, to check the program and the browser against.
// card k of an answer = sha256(randomness || k); first 4 bytes little-endian, scaled to the cards left, picks one of them
import { createHash } from 'node:crypto'; import fs from 'node:fs';
const h = (s) => createHash('sha256').update(s).digest(), out = [];
for (let i = 0; i < 600; i++) {
  const r = h(`blackjack vector ${i}`); let deck = Array.from({ length: 52 }, (_, c) => c), used = 0n;
  const gone = i % 3 === 0 ? 0 : h(`gone ${i}`)[0] % 20; for (let g = 0; g < gone; g++) { const c = deck.splice(h(`g ${i} ${g}`).readUInt32LE() % deck.length, 1)[0]; used |= 1n << BigInt(c); }
  const start = String(used), cards = []; for (let k = 0; k < 1 + (i % 12); k++) { const d = h(Buffer.concat([r, Buffer.from([k])])).readUInt32LE(); cards.push(deck.splice(Number((BigInt(d) * BigInt(deck.length)) >> 32n), 1)[0]); }
  out.push({ r: r.toString('hex'), used: start, cards });
}
fs.writeFileSync(new URL('../../onchain/programs/realm/bj_vectors.json', import.meta.url), '[\n' + out.map((o) => JSON.stringify(o)).join(',\n') + '\n]\n'); console.log(out.length);
