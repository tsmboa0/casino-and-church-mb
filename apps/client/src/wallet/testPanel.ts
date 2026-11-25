/** ?wallettest=1: checks signing over the real game (M1 test 12). Nothing is sent to any chain. Removed after the spike. */
import { address, appendTransactionMessageInstruction, AccountRole, blockhash, compileTransaction, createTransactionMessage, getTransactionDecoder, getTransactionEncoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from '@solana/kit';
import { ER_RPC, L1_RPC, loadWallet } from './index';

const claims = (t: string | null) => { try { return JSON.parse(atob(t!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; } };

export function mountTestPanel() {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:8px;top:8px;z-index:9000;background:#14101cee;color:#f4ead5;font:12px/1.4 ui-monospace,monospace;padding:8px;max-width:340px;border:1px solid #f5c542;user-select:text;-webkit-user-select:text';
  el.innerHTML = '<b>wallet test</b><div style="margin:6px 0"><button data-a="l1">SIGN L1</button> <button data-a="er">SIGN ROLLUP</button> <button data-a="tok">TOKENS</button> <button data-a="copy">COPY</button></div><pre style="white-space:pre-wrap;margin:0;max-height:40vh;overflow:auto">sign in with PLAY first</pre>';
  el.querySelectorAll('button').forEach((b) => { b.style.cssText = 'color:#14101c;background:#f5c542;border:0;padding:5px 8px;cursor:pointer'; });
  document.body.appendChild(el);
  const pre = el.querySelector('pre')!, lines: string[] = [];
  const say = (k: string, v: unknown) => { lines.push(`${k}: ${JSON.stringify(v)}`); pre.textContent = lines.join('\n'); };
  const sign = async (url: string) => {
    const w = await loadWallet(), a = w.address(); if (!a) throw new Error('not signed in');
    const { result } = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }] }) })).json();
    const me = address(a), v = result.value;
    const tx = pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayer(me, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(v.blockhash), lastValidBlockHeight: BigInt(v.lastValidBlockHeight) }, m),
      (m) => appendTransactionMessageInstruction({ programAddress: address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), accounts: [{ address: me, role: AccountRole.READONLY_SIGNER }], data: new TextEncoder().encode('casino and church spike') }, m), compileTransaction);
    const signed = await w.signTransaction(new Uint8Array(getTransactionEncoder().encode(tx)));
    return { bytes: signed.length, signed: Object.values(getTransactionDecoder().decode(signed).signatures).every(Boolean) };
  };
  const act: Record<string, () => Promise<unknown>> = {
    l1: () => sign(L1_RPC), er: () => sign(ER_RPC),
    tok: async () => {
      const w = await loadWallet(), a = claims(await w.accessToken()), i = claims(await w.identityToken());
      return { access: a && { iss: a.iss, aud: a.aud, hasSub: !!a.sub, ttl: a.exp - a.iat }, identity: i ? { iss: i.iss, aud: i.aud, linked: JSON.parse(i.linked_accounts ?? '[]').map((x: { type: string; chain_type?: string }) => `${x.type}:${x.chain_type ?? ''}`) } : null };
    },
    copy: () => navigator.clipboard.writeText(lines.join('\n')).then(() => 'copied'),
  };
  el.addEventListener('click', async (e) => {
    const k = (e.target as HTMLElement).dataset.a; if (!k) return;
    const t = performance.now(); try { const r = await act[k](); if (k !== 'copy') say(k, { ok: true, ms: Math.round(performance.now() - t), ...(r as object) }); } catch (err) { say(k, { ok: false, error: String((err as Error)?.message ?? err).slice(0, 200) }); }
  });
}
