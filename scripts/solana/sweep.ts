// Brings test money home: cashes out the chips of every saved throwaway wallet and returns its SOL. Keeps only wallets
// that still have something. Run it after a test session (`sweep.ts` skips wallets that a running script is using? no:
// do not run it while one is).
import fs from 'node:fs'; import path from 'node:path'; import { addr, CHIP, decodePlayer, decodePurse, ix, signerFrom } from '../../packages/realm/src/index.ts'; import { cli, er, KEYS, l1, send, until } from './lib.ts';
const F = path.join(KEYS, 'test-keys.jsonl'); if (!fs.existsSync(F)) process.exit(0); const keys = fs.readFileSync(F, 'utf8').trim().split('\n').filter(Boolean).map((l) => signerFrom(Uint8Array.from(JSON.parse(l)))); let back = 0n; const left: typeof keys = [];
for (const w of keys) try {
  const a = await er.account(addr.player(w.address)); const p = a && decodePlayer(a.data); const chips = p ? Number(p.chips / CHIP) : 0;
  if (chips > 0) { await send(er, [ix.cashOut(w.address, chips)], [w]); const want = p!.withdrawn + BigInt(chips) * CHIP; await until(async () => (decodePurse((await l1.account(addr.purse(w.address)))!.data)?.paidOut ?? 0n) >= want, 45_000, 800); }
  const b = await l1.balance(w.address); if (b > 10_000n) { await send(l1, [ix.transfer(w.address, cli().address, b - 5_000n)], [w]); back += b - 5_000n; }
} catch (e: any) { left.push(w); console.log(w.address, e.code ?? e.message); }
fs.writeFileSync(F, left.map((w) => JSON.stringify([...w.secret]) + '\n').join(''), { mode: 0o600 }); console.log('back', Number(back) / 1e9, 'SOL; still to do', left.length); process.exit(0);
