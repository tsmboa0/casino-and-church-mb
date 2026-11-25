// Shared helpers for the M1 spike. Keys live outside the repo in ~/.config/casino-mb/devnet.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_SLOT_HASHES_PUBKEY } from '@solana/web3.js';
export { Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram };
export const PK = (s) => new PublicKey(s);
const KEYS = path.join(os.homedir(), '.config/casino-mb/devnet');
export const key = (n) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(KEYS, n + '.json'), 'utf8'))));
export const L1_URL = process.env.L1_URL ?? 'https://rpc.magicblock.app/devnet';
export const REGION = process.env.REGION ?? 'eu';
export const ER_URL = process.env.ER_URL ?? `https://devnet-${REGION}.magicblock.app`;
export const VALIDATOR = { eu: 'MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e', as: 'MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57', tee: 'MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo' }[REGION];
export const L1 = new Connection(L1_URL, 'confirmed'), ER = new Connection(ER_URL, 'confirmed');
export const PROGRAM = key('program').publicKey;
export const DLP = PK('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh'), HYDRA = PK('eHyd5BU8QffvHi4GnXwxrK4WpS7pM2x9UGKHBWii7mf');
export const FEED = PK('71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr'), QUEUE = PK('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc');
export const VRF = PK('Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz'), SESSION = PK('KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5');
export const MAGIC = PK('Magic11111111111111111111111111111111111111'), MAGIC_CTX = PK('MagicContext1111111111111111111111111111111'), EPH_VAULT = PK('MagicVau1t999999999999999999999999999999999');
export const pda = (seeds, prog = PROGRAM) => PublicKey.findProgramAddressSync(seeds.map((s) => typeof s === 'string' ? Buffer.from(s) : s instanceof PublicKey ? s.toBuffer() : Buffer.from(s)), prog)[0];
export const A = { config: pda(['config']), bank: pda(['bank']), house: pda(['house']), market: pda(['market']) };
export const purseOf = (w) => pda(['purse', w]), playerOf = (w) => pda(['player', w]);
export const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
export const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
export const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const disc = (ns, n) => crypto.createHash('sha256').update(`${ns}:${n}`).digest().subarray(0, 8);
const IDL = JSON.parse(fs.readFileSync(new URL('../target/idl/spike.json', import.meta.url)));
const FIXED = {
  config: A.config, bank: A.bank, house: A.house, market: A.market, system_program: SystemProgram.programId, owner_program: PROGRAM, delegation_program: DLP,
  magic_program: MAGIC, magic_context: MAGIC_CTX, program_id: PROGRAM, oracle_queue: QUEUE, vrf_program: VRF, slot_hashes: SYSVAR_SLOT_HASHES_PUBKEY, program_identity: pda(['identity']),
  eph_vault: EPH_VAULT, hydra: HYDRA, feed: FEED, instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
};
/** accounts follow the IDL order; delegation helper accounts are derived from the account they belong to */
export function ix(name, accts = {}, args = Buffer.alloc(0)) {
  const def = IDL.instructions.find((i) => i.name === name); if (!def) throw new Error('no ix ' + name);
  const keys = def.accounts.map((a) => {
    let k = accts[a.name] ?? FIXED[a.name]; let signer = !!a.signer, writable = !!a.writable;
    if (!k) {
      const m = a.name.match(/^(buffer|delegation_record|delegation_metadata)_(.+)$/);
      if (m) { const t = accts[m[2]] ?? FIXED[m[2]]; if (t) k = m[1] === 'buffer' ? pda(['buffer', t]) : pda([m[1] === 'delegation_record' ? 'delegation' : 'delegation-metadata', t], DLP); }
    }
    if (!k && a.optional) { k = PROGRAM; signer = false; writable = false; }
    if (!k && a.address) k = PK(a.address);
    if (!k) throw new Error(`${name}: missing account ${a.name}`);
    return { pubkey: k, isSigner: signer, isWritable: writable };
  });
  return new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.concat([disc('global', name), args]) });
}
export async function send(conn, ixs, signers, { feePayer, skipPreflight = false, timeoutMs = 45_000, label = '' } = {}) {
  const tx = new Transaction(); tx.add(...(Array.isArray(ixs) ? ixs : [ixs])); tx.feePayer = feePayer ?? signers[0].publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash; tx.sign(...signers);
  const t0 = Date.now(); const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight, preflightCommitment: 'confirmed', maxRetries: 5 }); const sentMs = Date.now() - t0;
  while (Date.now() - t0 < timeoutMs) {
    const s = (await conn.getSignatureStatuses([sig])).value[0];
    if (s?.err) { const e = new Error(`${label} failed: ${JSON.stringify(s.err)} ${sig}`); e.sig = sig; e.err = s.err; throw e; }
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized' || conn !== L1)) return { sig, ms: Date.now() - t0, sentMs, size: tx.serialize().length };
    await sleep(conn === L1 ? 500 : 60);
  }
  throw new Error(`${label} timed out ${sig}`);
}
const T = { pubkey: 32, u64: 8, i64: 8, u32: 4, u16: 2, u8: 1, bool: 1 };
/** minimal Borsh decode of our own accounts, driven by the IDL */
export function decode(type, data) {
  let o = 8; const def = (n) => IDL.types.find((t) => t.name === n);
  const read = (t) => {
    if (typeof t === 'string') { const at = o; o += T[t]; if (t === 'pubkey') return new PublicKey(data.subarray(at, at + 32)).toBase58(); if (t === 'u64') return Number(data.readBigUInt64LE(at)); if (t === 'i64') return Number(data.readBigInt64LE(at)); if (t === 'u32') return data.readUInt32LE(at); if (t === 'u16') return data.readUInt16LE(at); return data[at]; }
    if (t.array) { const [el, n] = t.array; if (el === 'u8') { const b = data.subarray(o, o + n); o += n; return b.toString('hex'); } return Array.from({ length: n }, () => read(el)); }
    if (t.defined) return Object.fromEntries(def(t.defined.name).type.fields.map((f) => [f.name, read(f.type)]));
    throw new Error('type ' + JSON.stringify(t));
  };
  return Object.fromEntries(def(type).type.fields.map((f) => [f.name, read(f.type)]));
}
export async function get(conn, type, k) { const a = await conn.getAccountInfo(k, 'confirmed'); return a ? { ...decode(type, a.data), _owner: a.owner.toBase58(), _lamports: a.lamports } : null; }
export async function until(fn, ms, every = 150) { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return { v, ms: Date.now() - t0 }; if (Date.now() - t0 > ms) return null; await sleep(every); } }
export const stats = (a) => { const s = [...a].sort((x, y) => x - y); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return s.length ? { n: s.length, min: s[0], p50: q(.5), p90: q(.9), p95: q(.95), max: s.at(-1) } : { n: 0 }; };
export function record(name, data) { fs.mkdirSync(new URL('../results/', import.meta.url), { recursive: true }); const f = new URL(`../results/${name}.json`, import.meta.url); fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), region: REGION, ...data }, null, 1)); console.log(name, JSON.stringify(data)); }
/** SessionTokenV2 (create_session_v2): authority, session signer and sponsor all sign */
export function createSessionV2({ authority, sessionSigner, feePayer, validUntil }) {
  const token = pda(['session_token_v2', PROGRAM, sessionSigner, authority], SESSION);
  const data = Buffer.concat([disc('global', 'create_session_v2'), Buffer.from([1, 0]), Buffer.from([1]), i64(validUntil), Buffer.from([0])]);
  const k = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });
  return { token, ix: new TransactionInstruction({ programId: SESSION, data, keys: [k(token, false, true), k(sessionSigner, true, true), k(feePayer, true, true), k(authority, true, false), k(PROGRAM, false, false), k(SystemProgram.programId, false, false)] }) };
}
