import { b64decode, b64encode } from './bytes.ts';
import { firstSignature } from './tx.ts';
import { errorName } from './program.ts';

export class ChainError extends Error { constructor(message: string, public code: string, public signature?: string) { super(message); } }
export interface AccountInfo { data: Uint8Array; owner: string; lamports: number }

/** one JSON-RPC endpoint: L1 or the rollup */
export class Rpc {
  constructor(public url: string, public kind: 'l1' | 'er') {}
  async call<T = any>(method: string, params: unknown[] = [], timeoutMs = 15_000): Promise<T> {
    let res: Response;
    try { res = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw new ChainError(this.kind === 'er' ? 'The rollup is not answering.' : 'Solana is not answering.', this.kind === 'er' ? 'rollup_down' : 'l1_down'); }
    if (res.status === 429) throw new ChainError('Too many requests. Try again in a moment.', 'rate_limited');
    if (res.status >= 500) throw new ChainError(this.kind === 'er' ? 'The rollup is not answering.' : 'Solana is not answering.', this.kind === 'er' ? 'rollup_down' : 'l1_down');
    const j = await res.json() as { result?: T; error?: { code: number; message: string; data?: any } };
    if (j.error) throw toError(j.error.message, j.error.data?.err);
    return j.result as T;
  }
  async blockhash(): Promise<string> { return (await this.call('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash; }
  async account(address: string): Promise<AccountInfo | null> { const v = (await this.call('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }])).value; return v ? { data: b64decode(v.data[0]), owner: v.owner, lamports: v.lamports } : null; }
  async balance(address: string): Promise<bigint> { return BigInt((await this.call('getBalance', [address, { commitment: 'confirmed' }])).value); }
  async slot(): Promise<number> { return this.call('getSlot', [{ commitment: 'confirmed' }]); }
  /** sends and waits for confirmation; throws a ChainError named after the program's error */
  async send(wire: Uint8Array, timeoutMs = this.kind === 'er' ? 20_000 : 60_000): Promise<string> {
    const raw = b64encode(wire), sig = firstSignature(wire); const opts = { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 5 };
    await this.call('sendTransaction', [raw, opts]);
    const t0 = Date.now(); let again = t0;
    while (Date.now() - t0 < timeoutMs) {
      const s = (await this.call('getSignatureStatuses', [[sig]]).catch(() => null))?.value?.[0];
      if (s?.err) throw toError('The transaction failed.', s.err, sig);
      if (s && (this.kind === 'er' || s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return sig;
      if (this.kind === 'l1' && Date.now() - again > 4000) { again = Date.now(); await this.call('sendTransaction', [raw, { ...opts, skipPreflight: true }]).catch(() => {}); }
      await new Promise((r) => setTimeout(r, this.kind === 'er' ? 70 : 600));
    }
    throw new ChainError('The network is taking too long. Check again in a moment.', 'timeout', sig);
  }
}
function toError(message: string, err: any, sig?: string): ChainError {
  let n: number | undefined = err?.InstructionError?.[1]?.Custom;
  if (n === undefined) { const m = /custom program error: 0x([0-9a-f]+)/i.exec(message) ?? /"Custom":(\d+)/.exec(message); if (m) n = m[0].includes('0x') ? parseInt(m[1], 16) : Number(m[1]); }
  const name = n !== undefined ? errorName(n) : null;
  return new ChainError(name ?? message.slice(0, 200), name ?? (n !== undefined ? `custom_${n}` : 'rpc'), sig);
}
