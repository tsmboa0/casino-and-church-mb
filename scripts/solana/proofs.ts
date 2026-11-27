// Finds one recent, successful transaction of each instruction of our program, on the rollup and on L1, for the
// README's proof table. Prints JSON: { er: { Name: [sig, unix] }, l1: { ... } }.
//   PAGES=8 tsx scripts/solana/proofs.ts > docs/proofs.json
import { REALM } from '../../packages/realm/src/index.ts';
import { er, l1 } from './lib.ts';
import type { Rpc } from '../../packages/realm/src/index.ts';
const PAGES = Number(process.env.PAGES ?? 6);
async function scan(rpc: Rpc, label: string, address = REALM) {
  const found: Record<string, [string, number]> = {}; let before: string | undefined;
  for (let p = 0; p < PAGES; p++) {
    const page = await rpc.call('getSignaturesForAddress', [address, { limit: 1000, ...(before ? { before } : {}) }]).catch((e: any) => { console.error(label, 'signatures', e.message); return []; }) as { signature: string; blockTime: number | null; err: unknown }[];
    if (!page.length) break; before = page[page.length - 1].signature;
    const todo = page.filter((s) => !s.err);
    for (let i = 0; i < todo.length; i += 25) {
      await Promise.all(todo.slice(i, i + 25).map(async (s) => {
        const tx = await rpc.call('getTransaction', [s.signature, { maxSupportedTransactionVersion: 1, encoding: 'json', commitment: 'confirmed' }]).catch(() => null) as any;
        const logs: string[] = tx?.meta?.logMessages ?? []; if (tx?.meta?.err) return;
        // the first instruction of OUR program in this transaction
        for (let k = 0; k < logs.length; k++) if (logs[k].startsWith(`Program ${REALM} invoke`)) { const m = /Instruction: (\w+)/.exec(logs[k + 1] ?? ''); if (m && !found[m[1]]) found[m[1]] = [s.signature, s.blockTime ?? tx?.blockTime ?? 0]; break; }
      }));
    }
    console.error(label, 'page', p + 1, 'kinds', Object.keys(found).length);
  }
  return found;
}
// ADDRS=a,b,c: scan those accounts' histories instead of the program's (a player, the boards, the plots)
const addrs = (process.env.ADDRS ?? '').split(',').filter(Boolean);
const merge = async (rpc: Rpc, label: string) => { const all: Record<string, [string, number]> = {}; for (const a of addrs.length ? addrs : [REALM]) for (const [k, v] of Object.entries(await scan(rpc, label + ' ' + a.slice(0, 6), a))) if (!all[k] || all[k][1] < v[1]) all[k] = v; return all; };
const out = { er: await merge(er, 'rollup'), l1: await merge(l1, 'L1') };
console.log(JSON.stringify(out, null, 1)); process.exit(0);
