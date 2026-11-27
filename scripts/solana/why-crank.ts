// When the crank stopped (STOP, unix seconds): what happened to the market on L1 around then? Delegations and
// commits show a rotation; nothing at all points to the rollup itself.
import { addr } from '../../packages/realm/src/index.ts';
import { l1 } from './lib.ts';
const STOP = Number(process.env.STOP ?? 1795722452);
let before: string | undefined; const rows: { t: number; sig: string; err: boolean }[] = [];
for (let k = 0; k < 10; k++) {
  const page = await l1.call('getSignaturesForAddress', [addr.market(), { limit: 1000, ...(before ? { before } : {}) }]) as { signature: string; blockTime: number; err: unknown }[];
  if (!page.length) break; for (const s of page) rows.push({ t: s.blockTime, sig: s.signature, err: !!s.err }); before = page[page.length - 1].signature;
  if (page[page.length - 1].blockTime < STOP - 6 * 3600) break;
}
const near = rows.filter((r) => Math.abs(r.t - STOP) < 3 * 3600).sort((a, b) => a.t - b.t);
for (const r of near) {
  const tx = await l1.call('getTransaction', [r.sig, { maxSupportedTransactionVersion: 1, encoding: 'json' }]) as any;
  const logs: string[] = tx?.meta?.logMessages ?? []; const what = logs.filter((l) => /Instruction: |delegat|undelegat|commit/i.test(l)).map((l) => l.replace(/^Program log: /, '')).slice(0, 4).join(' | ');
  console.log(new Date(r.t * 1000).toISOString(), `${r.t - STOP >= 0 ? '+' : ''}${r.t - STOP}s`, r.err ? 'FAILED' : 'ok', what.slice(0, 160));
}
console.log('L1 transactions on the market within 3 h of the stop:', near.length); process.exit(0);
