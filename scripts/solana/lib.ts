// helpers for the admin and test scripts. Keys live outside the repository.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildTx, compileMessage, Rpc, signerFrom, type Ix, type Signer } from '../../packages/realm/src/index.ts';
export const KEYS = path.join(os.homedir(), '.config/casino-mb/devnet');
export const key = (n: string): Signer => signerFrom(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(KEYS, n + '.json'), 'utf8'))));
export const cli = (): Signer => signerFrom(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8'))));
export const l1 = new Rpc(process.env.L1_RPC ?? 'https://rpc.magicblock.app/devnet', 'l1'), er = new Rpc(process.env.ER_RPC ?? 'https://devnet-eu.magicblock.app', 'er');
export const EU = 'MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e', BTC_FEED = '71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr';
export const send = async (rpc: Rpc, ixs: Ix[], signers: Signer[]) => rpc.send(buildTx(compileMessage(signers[0].address, ixs, await rpc.blockhash()), signers));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until<T>(f: () => Promise<T | null | undefined | false>, ms = 20_000, every = 200): Promise<T> { const t = Date.now(); for (;;) { const v = await f().catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await sleep(every); } }
