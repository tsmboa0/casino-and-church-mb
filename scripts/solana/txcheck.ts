// Does each signature still resolve, and where (rollup or L1)? Reads signatures from stdin, one per line.
import { er, l1 } from './lib.ts';
const sigs = (await new Response(process.stdin as any).text()).split('\n').map((s) => s.trim()).filter(Boolean);
for (const s of sigs) {
  const on = async (rpc: typeof er) => rpc.call('getTransaction', [s, { maxSupportedTransactionVersion: 1, encoding: 'json' }]).catch(() => null) as Promise<any>;
  const a = await on(er), b = a ? null : await on(l1), t = a ?? b;
  const ix = (t?.meta?.logMessages ?? []).map((l: string) => /Instruction: (\w+)/.exec(l)?.[1]).filter(Boolean).slice(0, 3).join(',');
  console.log(s.slice(0, 16), a ? 'ROLLUP' : b ? 'L1' : 'MISSING', t?.meta?.err ? 'ERR' : 'ok', ix);
}
process.exit(0);
