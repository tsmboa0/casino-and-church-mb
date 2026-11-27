// The market's delegated fee payer. MagicBlock allows 10 free saves to L1 per delegation; past them a save must be paid
// by a delegated account that signs (and name the validator's magic fee vault). Ours is a plain wallet, `feepayer`
// (~/.config/casino-mb/devnet/feepayer.json; FEEPAYER_KEY on the server), delegated to our rollup.
//   feepayer.ts              report
//   feepayer.ts up [SOL]     fund it from the CLI wallet and delegate it (default 0.3 SOL)
//   feepayer.ts test N       N saves of the market in a row, paid by it
import { addr, b58decode, concat, decodeMarket, ix, P, pda, u32, u64, u8, type Ix } from '../../packages/realm/src/index.ts';
import { cli, er, EU, key, l1, send, sleep, until } from './lib.ts';
const DLP = P.delegation, SYS = P.system, keeper = key('keeper'), payer = key('feepayer');
/** the validator's magic fee vault */
export const VAULT = pda(['magic-fee-vault', b58decode(EU)], DLP);
const report = async () => ({ feepayer: payer.address, vault: VAULT, l1: await l1.account(payer.address).then((a) => a && { lamports: a.lamports, owner: a.owner }), rollup: await er.account(payer.address).then((a) => a && { lamports: a.lamports, owner: a.owner }) });
const cmd = process.argv[2];
if (cmd === 'up') {
  const lamports = BigInt(Math.round(Number(process.argv[3] ?? 0.3) * 1e9));
  const a = await l1.account(payer.address);
  if (a?.owner === DLP) console.log('already delegated');
  else {
    if (!a || BigInt(a.lamports) < lamports) await send(l1, [ix.transfer(cli().address, payer.address, lamports - BigInt(a?.lamports ?? 0))], [cli()]);
    // a wallet is delegated by handing it to the delegation program, which records the system program as its owner
    const assign: Ix = { program: SYS, accounts: [{ address: payer.address, signer: true, writable: true }], data: concat(u32(1), b58decode(DLP)) };
    const args = concat(u32(0), u32(0), u8(1), b58decode(EU));                 // commit_frequency_ms 0, no seeds, our validator
    const buffer = pda(['buffer', b58decode(payer.address)], SYS), record = pda(['delegation', b58decode(payer.address)], DLP), meta = pda(['delegation-metadata', b58decode(payer.address)], DLP);
    const delegate: Ix = { program: DLP, accounts: [{ address: cli().address, signer: true, writable: true }, { address: payer.address, signer: true, writable: true }, { address: SYS, signer: false, writable: false }, { address: buffer, signer: false, writable: true }, { address: record, signer: false, writable: true }, { address: meta, signer: false, writable: true }, { address: SYS, signer: false, writable: false }], data: concat(u64(0), args) };
    await send(l1, [assign, delegate], [cli(), payer]); console.log('delegated to', EU);
    await until(() => er.account(payer.address), 30_000, 500);
  }
}
if (cmd === 'test') {
  const n = Number(process.argv[3] ?? 2), M = async () => decodeMarket((await er.account(addr.market()))!.data)!;
  const save = (): Ix => { const x = ix.marketCheckpoint(keeper.address); return { ...x, accounts: [...x.accounts.map((m) => (m.address === keeper.address ? { ...m, writable: false } : m)), { address: VAULT, signer: false, writable: true }, { address: payer.address, signer: true, writable: true }] }; };
  for (let i = 0; i < n; i++) {
    const before = await M();
    try { const sig = await send(er, [save()], [payer, keeper]); await sleep(4000); console.log(`save ${before.commits + 1}: ok`, sig.slice(0, 12), 'still on the rollup:', (await l1.account(addr.market()))?.owner === P.delegation, 'crank ticks', Number((await M()).crankTicks)); }
    catch (e: any) { console.log(`save ${before.commits + 1}: REFUSED`, e.code, String(e.message).slice(0, 200)); }
    await sleep(2000);
  }
}
console.log(JSON.stringify(await report()));
process.exit(0);
