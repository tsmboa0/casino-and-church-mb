/**
 * The session key: a throwaway key that may PLAY for one wallet for up to a week, and nothing else (it can never cash out
 * or buy). Sealed with a non-extractable AES key in IndexedDB; only the ciphertext is stored.
 */
import { b64decode, b64encode, newSigner, signerFrom, type Signer } from '@cnc/realm';

const DB = 'cnc-session', STORE = 'kv';
function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { const tx = open.result.transaction(STORE, mode); const r = fn(tx.objectStore(STORE)); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); tx.oncomplete = () => open.result.close(); };
  });
}
async function wrapKey(): Promise<CryptoKey> {
  const have = await idb<CryptoKey | undefined>('readonly', (s) => s.get('wrap') as IDBRequest<CryptoKey | undefined>); if (have) return have;
  const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); await idb('readwrite', (s) => s.put(k, 'wrap')); return k;
}
interface Sealed { iv: string; ct: string; until: number }
let memory: { wallet: string; signer: Signer; until: number } | null = null;

export async function loadSession(wallet: string): Promise<{ signer: Signer; until: number } | null> {
  if (memory?.wallet === wallet) return memory;
  try {
    const s = await idb<Sealed | undefined>('readonly', (x) => x.get(`s:${wallet}`) as IDBRequest<Sealed | undefined>); if (!s) return null;
    const seed = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64decode(s.iv) as BufferSource }, await wrapKey(), b64decode(s.ct) as BufferSource));
    memory = { wallet, signer: signerFrom(seed), until: s.until }; return memory;
  } catch { return null; }
}
export const freshSession = (): Signer => newSigner();
/** keep it only once the chain has accepted it */
export async function saveSession(wallet: string, signer: Signer, until: number): Promise<void> {
  memory = { wallet, signer, until };
  try { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await wrapKey(), signer.secret as BufferSource)); await idb('readwrite', (s) => s.put({ iv: b64encode(iv), ct: b64encode(ct), until } satisfies Sealed, `s:${wallet}`)); }
  catch { /* private mode: it lives in memory, and the next visit asks for one popup */ }
}
export async function dropSession(wallet: string): Promise<void> { memory = null; try { await idb('readwrite', (s) => s.delete(`s:${wallet}`)); } catch { /* */ } }
