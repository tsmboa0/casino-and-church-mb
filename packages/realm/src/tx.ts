import { ed25519 } from '@noble/curves/ed25519';
import { b58decode, b58encode, concat } from './bytes.ts';

export interface Meta { address: string; signer: boolean; writable: boolean }
export interface Ix { program: string; accounts: Meta[]; data: Uint8Array }
export interface Signer { address: string; secret: Uint8Array }

/** from a 32-byte seed, or a 64-byte Solana secret key */
export function signerFrom(secret: Uint8Array): Signer { const seed = secret.slice(0, 32); return { address: b58encode(ed25519.getPublicKey(seed)), secret: seed }; }
export const newSigner = () => signerFrom(ed25519.utils.randomPrivateKey());

const short = (n: number) => { const o: number[] = []; for (;;) { const b = n & 127; n >>= 7; if (!n) { o.push(b); return Uint8Array.from(o); } o.push(b | 128); } };
const unshort = (b: Uint8Array, at: number): [number, number] => { let n = 0, s = 0, i = at; for (;;) { const x = b[i++]; n |= (x & 127) << s; if (!(x & 128)) return [n, i]; s += 7; } };

/** a legacy transaction message */
export function compileMessage(feePayer: string, ixs: Ix[], blockhash: string): Uint8Array {
  const m = new Map<string, { s: boolean; w: boolean }>([[feePayer, { s: true, w: true }]]);
  for (const ix of ixs) {
    for (const a of ix.accounts) { const e = m.get(a.address) ?? { s: false, w: false }; m.set(a.address, { s: e.s || a.signer, w: e.w || a.writable }); }
    if (!m.has(ix.program)) m.set(ix.program, { s: false, w: false });
  }
  const all = [...m.entries()], rank = (e: { s: boolean; w: boolean }) => (e.s ? 0 : 2) + (e.w ? 0 : 1);
  const keys = all.sort((x, y) => (x[0] === feePayer ? -1 : y[0] === feePayer ? 1 : rank(x[1]) - rank(y[1]))).map((x) => x[0]);
  const nSig = all.filter((x) => x[1].s).length, roSig = all.filter((x) => x[1].s && !x[1].w).length, roUn = all.filter((x) => !x[1].s && !x[1].w).length;
  const at = new Map(keys.map((k, i) => [k, i]));
  return concat(Uint8Array.of(nSig, roSig, roUn), short(keys.length), ...keys.map(b58decode), b58decode(blockhash), short(ixs.length),
    ...ixs.map((ix) => concat(Uint8Array.of(at.get(ix.program)!), short(ix.accounts.length), Uint8Array.from(ix.accounts.map((a) => at.get(a.address)!)), short(ix.data.length), ix.data)));
}
export interface Parsed { message: Uint8Array; signatures: Uint8Array[]; keys: string[]; numSigners: number; blockhash: string; programs: string[] }
export function parseTx(wire: Uint8Array): Parsed {
  const [n, o] = unshort(wire, 0); const signatures: Uint8Array[] = []; let i = o;
  for (let k = 0; k < n; k++) { signatures.push(wire.slice(i, i + 64)); i += 64; }
  const message = wire.slice(i); if (message[0] & 128) throw new Error('versioned transactions are not used here');
  let [nk, p] = unshort(message, 3); const keys: string[] = [];
  for (let k = 0; k < nk; k++) { keys.push(b58encode(message.slice(p, p + 32))); p += 32; }
  const blockhash = b58encode(message.slice(p, p + 32)); p += 32;
  let ni: number; [ni, p] = unshort(message, p); const programs: string[] = [];
  for (let k = 0; k < ni; k++) { programs.push(keys[message[p++]]); let len: number; [len, p] = unshort(message, p); p += len; [len, p] = unshort(message, p); p += len; }
  return { message, signatures, keys, numSigners: message[0], blockhash, programs };
}
/** signs with the keys we hold; the other slots stay empty for whoever signs next */
export function buildTx(message: Uint8Array, signers: Signer[]): Uint8Array {
  const n = message[0]; const [, at] = unshort(message, 3); const sigs: Uint8Array[] = [];
  for (let k = 0; k < n; k++) { const key = b58encode(message.slice(at + 32 * k, at + 32 * k + 32)); const s = signers.find((x) => x.address === key); sigs.push(s ? ed25519.sign(message, s.secret) : new Uint8Array(64)); }
  return concat(short(n), ...sigs, message);
}
/** adds our signatures to a transaction somebody else started */
export function addSignatures(wire: Uint8Array, signers: Signer[]): Uint8Array {
  const p = parseTx(wire); const sigs = p.signatures.map((s, i) => { const m = signers.find((x) => x.address === p.keys[i]); return m ? ed25519.sign(p.message, m.secret) : s; });
  return concat(short(sigs.length), ...sigs, p.message);
}
/** true when every required signature is present and valid */
export function fullySigned(wire: Uint8Array): boolean {
  const p = parseTx(wire); if (p.signatures.length !== p.numSigners) return false;
  return p.signatures.every((s, i) => { try { return ed25519.verify(s, p.message, b58decode(p.keys[i])); } catch { return false; } });
}
export const firstSignature = (wire: Uint8Array) => b58encode(parseTx(wire).signatures[0]);
