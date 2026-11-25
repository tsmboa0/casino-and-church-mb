import { sha256 } from '@noble/hashes/sha2';
import { ed25519 } from '@noble/curves/ed25519';

const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58encode(b: Uint8Array): string {
  let z = 0; while (z < b.length && b[z] === 0) z++;
  const d: number[] = [];
  for (let i = z; i < b.length; i++) { let c = b[i]; for (let j = 0; j < d.length; j++) { c += d[j] << 8; d[j] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } }
  return '1'.repeat(z) + d.reverse().map((x) => A[x]).join('');
}
export function b58decode(s: string): Uint8Array {
  let z = 0; while (z < s.length && s[z] === '1') z++;
  const d: number[] = [];
  for (let i = z; i < s.length; i++) { let c = A.indexOf(s[i]); if (c < 0) throw new Error('bad base58'); for (let j = 0; j < d.length; j++) { c += d[j] * 58; d[j] = c & 255; c >>= 8; } while (c) { d.push(c & 255); c >>= 8; } }
  return Uint8Array.from([...new Array(z).fill(0), ...d.reverse()]);
}
export const concat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
export const utf8 = (s: string) => new TextEncoder().encode(s);
export const u8 = (n: number) => Uint8Array.of(n);
export const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
export const u64 = (n: bigint | number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
export const i64 = (n: bigint | number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(n), true); return b; };
export const str = (s: string) => { const b = utf8(s); return concat(u32(b.length), b); };
export const b64encode = (b: Uint8Array) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
export const b64decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const onCurve = (b: Uint8Array) => { try { ed25519.ExtendedPoint.fromHex(b); return true; } catch { return false; } };
const cache = new Map<string, string>();
/** program-derived address */
export function pda(seeds: (string | Uint8Array)[], program: string): string {
  const parts = seeds.map((s) => (typeof s === 'string' ? utf8(s) : s));
  const key = program + ':' + parts.map((p) => b58encode(p)).join('.');
  const hit = cache.get(key); if (hit) return hit;
  const prog = b58decode(program);
  for (let bump = 255; bump >= 0; bump--) { const h = sha256(concat(...parts, u8(bump), prog, utf8('ProgramDerivedAddress'))); if (!onCurve(h)) { const a = b58encode(h); cache.set(key, a); return a; } }
  throw new Error('no pda');
}
export { sha256 };
