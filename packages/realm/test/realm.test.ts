import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Shoe, addSignatures, addr, b58decode, b58encode, buildTx, compileMessage, fullySigned, ix, newSigner, parseTx, pda, P, REALM } from '../src/index.ts';
test('base58 and pda agree with Solana', () => {
  assert.equal(b58encode(b58decode(REALM)), REALM); assert.equal(b58encode(b58decode('11111111111111111111111111111111')), '11111111111111111111111111111111');
  // the BTC feed, derived independently from MagicBlock's documented seeds and read live
  assert.equal(pda(['price_feed', 'pyth-lazer', '1'], 'PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd'), '71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr');
});
test('a setup transaction: three signers, each signs its own slot, and it fits', () => {
  const sponsor = newSigner(), w = newSigner(), s = newSigner(); const bh = b58encode(new Uint8Array(32).fill(7));
  const msg = compileMessage(sponsor.address, [ix.openAccount(sponsor.address, w.address), ix.delegatePlayer(sponsor.address, w.address), ix.createSession(w.address, s.address, sponsor.address, 1)], bh);
  let wire = buildTx(msg, [sponsor]); assert.equal(fullySigned(wire), false); wire = addSignatures(wire, [s]); assert.equal(fullySigned(wire), false); wire = addSignatures(wire, [w]); assert.equal(fullySigned(wire), true);
  const p = parseTx(wire); assert.equal(p.numSigners, 3); assert.equal(p.keys[0], sponsor.address); assert.equal(p.blockhash, bh); assert.deepEqual([...new Set(p.programs)].sort(), [REALM, P.session].sort()); assert.ok(wire.length <= 1232, `size ${wire.length}`);
  wire[wire.length - 1] ^= 1; assert.equal(fullySigned(wire), false);
});
test('addresses are stable and distinct', () => { const w = newSigner().address; assert.equal(addr.player(w), addr.player(w)); assert.equal(new Set([addr.player(w), addr.purse(w), addr.config(), addr.bank(), addr.house(), addr.housePurse()]).size, 6); });
test('blackjack cards: the same vectors the program is tested with', () => {
  const all = JSON.parse(fs.readFileSync(new URL('../../../onchain/programs/realm/bj_vectors.json', import.meta.url), 'utf8')) as { r: string; used: string; cards: number[] }[]; assert.ok(all.length >= 500);
  for (const v of all) { const s = new Shoe(Uint8Array.from(Buffer.from(v.r, 'hex')), BigInt(v.used)); assert.deepEqual(v.cards.map(() => s.draw()), v.cards); }
});
