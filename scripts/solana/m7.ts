// M7 on devnet: every host tool through the real program (written on L1, acted on the rollup), the bounds, then live
// decision cycles with NEAR AI Cloud and a chat. Changes it makes stay within the bounds the hosts use anyway.
import fs from 'node:fs'; import crypto from 'node:crypto'; import os from 'node:os'; import path from 'node:path';
import { addr, anchoredFromLogs, b64decode, buildTx, CHIP, compileMessage, decisionHash, decodeHouse, decodePlayer, ix, type HostCallInput, type Signer } from '../../packages/realm/src/index.ts';
import { cli, er, key, l1, send, sleep, testKey as newSigner, until } from './lib.ts';
import { Hosts } from '../../apps/server/src/solana/hosts/service.ts'; import { config } from '../../apps/server/src/solana/config.ts'; import { FileStore } from '../../apps/server/src/solana/store.ts';
const F = key('fortuna'), N = key('nakamoto'), sponsor = key('sponsor'); let failed = 0; const out: Record<string, unknown> = {}; const J = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? Number(x) : x));
const check = (n: string, pass: boolean, info: unknown = '') => { out[n] = { pass, info }; if (!pass) failed++; console.log(pass ? 'ok  ' : 'FAIL', n, typeof info === 'string' ? info : J(info)); };
const H = async () => decodeHouse((await er.account(addr.house()))!.data)!;
/** what a host does: write on L1, then act (retrying while the rollup catches up) */
async function decide(host: Signer, agent: number, call: HostCallInput, player?: string, tamper?: HostCallInput) {
  const id = crypto.randomBytes(16), resp = crypto.randomBytes(32), hash = decisionHash(id, agent, resp, call);
  const tx = await send(l1, [ix.anchorDecision(host.address, agent, hash, { id, policy: 1, action: call.do, model: '', signedText: '', signature: new Uint8Array(65), signingAddress: new Uint8Array(20), requestSha256: new Uint8Array(32), responseSha256: resp })], [host]);
  for (let i = 0; ; i++) { try { return { anchor: tx, act: await send(er, [ix.hostAct(host.address, agent, id, resp, tamper ?? call, player)], [host]) }; } catch (e: any) { if (e.code === 'NotAllowed' && i < 30 && !tamper) { await sleep(500); continue; } throw e; } }
}
const refused = async (n: string, f: () => Promise<unknown>, want?: string) => { try { await f(); check(n, false, 'ACCEPTED'); } catch (e: any) { check(n, !want || e.code === want, e.code); } };
// ---- the tools
await refused('an action other than the one written down', () => decide(N, 1, { do: 'start_event', kind: 1, minutes: 10, boost_bps: 1000 }, undefined, { do: 'start_event', kind: 1, minutes: 60, boost_bps: 5000 }), 'NotAllowed');
await refused('the Father calling a Happy Hour', () => decide(N, 1, { do: 'start_event', kind: 0, minutes: 10, boost_bps: 0 }), 'NotAllowed');
await refused('the Don giving alms', () => decide(F, 0, { do: 'grant_alms', chips: 5 }), 'NotAllowed');
await refused('a LUCK rate above 80', () => decide(F, 0, { do: 'set_luck_rate', milli: 81 }), 'BadArgs');
await refused('a Vigil of 61 minutes', () => decide(N, 1, { do: 'start_event', kind: 1, minutes: 61, boost_bps: 2000 }), 'BadArgs');
await refused('a candle worth 5 FAITH', () => decide(N, 1, { do: 'set_candle_faith', milli: 5000 }), 'BadArgs');
let h = await H(); const vigilNow = h.hosts.events[1].active && h.hosts.events[1].ends > Date.now() / 1000;
if (!vigilNow && Date.now() / 1000 > h.hosts.lastEventStart[1] + 5400) { const r = await decide(N, 1, { do: 'start_event', kind: 1, minutes: 10, boost_bps: 2000 }); h = await H(); check('a Vigil, written on L1 first', h.hosts.events[1].active && h.hosts.events[1].boostBps === 2000, r); const tx = await l1.call('getTransaction', [r.anchor, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]); const ev = anchoredFromLogs(tx.meta.logMessages, b64decode)[0]; check('the L1 record carries the action and the proof fields', ev?.agent === 1 && ev.action === 'start_event'); await refused('a second Vigil at once', () => decide(N, 1, { do: 'start_event', kind: 1, minutes: 10, boost_bps: 2000 }), 'CampaignClosed'); await decide(N, 1, { do: 'end_event', kind: 1 }); check('and its end', !(await H()).hosts.events[1].active); }
else check('a Vigil (skipped: one ran in the last 90 minutes)', true);
const j0 = (await H()).jackpot; await decide(F, 0, { do: 'top_up_jackpot', chips: 1 }); check('the jackpot topped up from the vault', (await H()).jackpot - j0 === CHIP);
// alms for a broke, active player
const w = newSigner(), s = newSigner(); await l1.send(buildTx(compileMessage(sponsor.address, [ix.openAccount(sponsor.address, w.address), ix.delegatePlayer(sponsor.address, w.address), ix.createSession(w.address, s.address, sponsor.address, Math.floor(Date.now() / 1000) + 86400)], await l1.blockhash()), [sponsor, w, s])); await until(async () => er.account(addr.player(w.address)), 60_000);
await refused('alms for someone who never played', () => decide(N, 1, { do: 'grant_alms', chips: 10 }, w.address), 'NotAllowed'); await send(er, [ix.lightCandle(w.address, s.address)], [s]);
const tr = (await H()).treasury; await decide(N, 1, { do: 'grant_alms', chips: 10 }, w.address); const p = decodePlayer((await er.account(addr.player(w.address)))!.data)!; check('alms: bonus chips from the treasury', p.bonus === 10n * CHIP && p.chips === 0n && tr - (await H()).treasury === 10n * CHIP);
await refused('alms twice in a day', () => decide(N, 1, { do: 'grant_alms', chips: 5 }, w.address), 'Cooldown');
const cf = (await H()).hosts.candleFaithMilli; if (Date.now() / 1000 > (await H()).hosts.lastPriestChange + 1800) { const next = cf >= 3600 ? cf - 200 : cf + 200; await decide(N, 1, { do: 'set_candle_faith', milli: next }); check('a candle’s FAITH, one small step', (await H()).hosts.candleFaithMilli === next, { from: cf, to: next }); await refused('a second change within half an hour', () => decide(N, 1, { do: 'set_candle_faith', milli: cf }), 'TooEarly'); }
// ---- live cycles with the model
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosts-')), store = new FileStore(path.join(dir, 'store.json')); for (const x of [w.address]) await store.link(`did:test:${x}`, x);
const hosts = new Hosts(config.hosts, l1, er, store, { fortuna: F, nakamoto: N }); check('NEAR AI is configured', !!hosts.ai?.enabled, hosts.ai?.model ?? 'no key');
for (const a of ['fortuna', 'nakamoto'] as const) { const t = Date.now(); const row = await hosts.hosts[a].cycle('test'); const dto = row && await hosts.toDTO(row); check(`${a}: a decision, signed in the enclave`, !!row && row.policy === 'llm' && !!dto?.proof && (!row.reason || /guardrail|refused/.test(row.reason)), { ms: Date.now() - t, action: row?.action, applied: row?.applied, line: row?.line, reason: row?.reason, anchor: row?.anchorTx?.slice(0, 10) }); }
const chat = await hosts.ask('nakamoto', 'What did you decide last, Father?', 'test', '127.0.0.1'); check('a chat answer, on topic', chat.relevant && chat.answer.length > 5, { answer: chat.answer, signed: !!chat.proof }); const off = await hosts.ask('fortuna', 'What is the capital of France?', 'test', '127.0.0.1'); check('off-topic questions are refused in character', !off.relevant, off.answer);
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED', Object.keys(out).length); fs.writeFileSync('docs/e2e-m7.json', JSON.stringify({ at: new Date().toISOString(), checks: out }, null, 1)); void cli; process.exit(failed ? 1 : 0);
