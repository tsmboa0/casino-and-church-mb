import cors from '@fastify/cors'; import Fastify from 'fastify'; import type { FastifyRequest } from 'fastify';
import { addr, b58decode, b64decode, b64encode, CHIP, decodeHouse, ix, REALM, type Rpc } from '@cnc/realm';
import { cleanName, nameKey, nameProblem } from '@cnc/shared';
import { verifyPrivy } from './privy.ts'; import { FAUCET_FLOOR, SETUP_FLOOR, type Config } from './config.ts'; import { HttpError, type Sponsor } from './sponsor.ts'; import type { Keeper } from './keeper.ts'; import type { Indexer } from './indexer.ts'; import type { SolStore } from './store.ts';

export interface Deps { config: Config; store: SolStore; l1: Rpc; er: Rpc; sponsor: Sponsor | null; keeper: Keeper | null; indexer?: Indexer | null }
const DAY = 86_400_000;
const wallet = (v: unknown) => { const s = String(v ?? ''); try { if (b58decode(s).length === 32) return s; } catch { /* */ } throw new HttpError(400, 'bad_args', 'That is not a Solana address.'); };
export function buildApp(d: Deps) {
  const app = Fastify({ trustProxy: true, bodyLimit: 32_768 }); void app.register(cors, { origin: d.config.origins, maxAge: 600 });
  app.setErrorHandler((e, _q, reply) => { if (e instanceof HttpError) return reply.code(e.status).send({ error: e.code, message: e.message }); const c = e as any; if (c.code && typeof c.code === 'string' && !c.statusCode) return reply.code(502).send({ error: c.code, message: c.message }); console.error(e); return reply.code(c.statusCode ?? 500).send({ error: 'server', message: 'The server failed. Try again.' }); });
  const did = (q: FastifyRequest) => { const t = verifyPrivy(q.headers.authorization?.replace(/^Bearer /, ''), d.config.privyAppId, d.config.privyKey); if (!t) throw new HttpError(401, 'signed_out', 'Sign in again.'); return t; };
  const sponsor = () => { if (!d.sponsor) throw new HttpError(503, 'no_sponsor', 'New accounts are closed right now.'); return d.sponsor; };
  const limit = async (kind: string, id: string, max: number, message: string, window = DAY) => { if (await d.store.hits(kind, id, Date.now() - window) >= max) throw new HttpError(429, 'quota', message); };
  /** this Privy user may act for this wallet: it is theirs, or neither is taken yet */
  const mayUse = async (who: string, w: string) => { const a = await d.store.byDid(who), b = await d.store.byWallet(w); if ((a && a.wallet !== w) || (b && b.did !== who)) throw new HttpError(403, 'not_yours', 'That wallet belongs to another account.'); return a; };

  let health: { at: number; body: unknown } | null = null;
  app.get('/healthz', async () => {
    if (health && Date.now() - health.at < 5_000) return health.body;
    const safe = async <T>(f: () => Promise<T>) => { try { return await f(); } catch { return null; } };
    const [l1Slot, erSlot, bal, house] = await Promise.all([safe(() => d.l1.slot()), safe(() => d.er.slot()), safe(() => d.l1.balance(d.config.sponsor?.address ?? '')), safe(async () => decodeHouse((await d.er.account(addr.house()))!.data))]);
    const body = { ok: l1Slot !== null && erSlot !== null && !!house && !house.paused, program: REALM, l1: { up: l1Slot !== null, slot: l1Slot }, rollup: { up: erSlot !== null, slot: erSlot, url: d.config.er }, paused: house?.paused ?? null, sponsor: { address: d.config.sponsor?.address ?? null, sol: bal === null ? null : Number(bal) / 1e9, faucet: bal !== null && bal > FAUCET_FLOOR, accounts: bal !== null && bal > SETUP_FLOOR }, keeper: d.keeper?.status ?? null, books: d.keeper?.books ?? null, indexer: d.indexer?.status ?? null, vault_chips: house ? Number(house.vault / CHIP) : null, players: await d.store.count() };
    health = { at: Date.now(), body }; return body;
  });
  app.get('/me', async (q) => { const r = await d.store.byDid(did(q)); return r ? { wallet: r.wallet, name: r.name, avatar: r.avatar } : { wallet: null, name: null, avatar: null }; });

  app.post('/account/prepare', async (q) => {
    const who = did(q), b = (q.body ?? {}) as any, w = wallet(b.wallet), s = wallet(b.session); const known = await mayUse(who, w);
    if (w === s) throw new HttpError(400, 'bad_args', 'The session key must be a new key.');
    if (!known) {
      if (await d.store.count() >= d.config.accountsTotal) throw new HttpError(429, 'quota', 'Account creation is full.');
      await limit('account', q.ip, d.config.accountsPerIpDay, 'Too many new accounts from this network today.');
    }
    await limit('session', who, 12, 'Too many sign-ins today. Try again tomorrow.');
    if (await d.l1.balance(sponsor().key.address) < SETUP_FLOOR) throw new HttpError(503, 'no_sponsor', 'New accounts are closed right now.');
    const r = await sponsor().prepareSetup(who, w, s, d.config.sessionDays); return { tx: b64encode(r.tx), kind: r.kind };
  });
  app.post('/buy/prepare', async (q) => {
    const who = did(q), b = (q.body ?? {}) as any, w = wallet(b.wallet), chips = Number(b.chips); await mayUse(who, w);
    if (!Number.isInteger(chips) || chips < 10 || chips > 5000) throw new HttpError(400, 'bad_args', 'Buy between 10 and 5,000 chips.');
    const lamports = BigInt(chips) * CHIP; if (await d.l1.balance(w) < lamports) throw new HttpError(400, 'no_sol', 'Not enough test SOL in your wallet.');
    await limit('buy', who, 40, 'Too many purchases today.');
    return { tx: b64encode(await sponsor().prepareBuy(who, w, lamports)) };
  });
  /** the signed transaction comes back here, whatever it was for */
  app.post('/tx/submit', async (q) => {
    const who = did(q); let wire: Uint8Array; try { wire = b64decode(String((q.body as any)?.tx ?? '')); } catch { throw new HttpError(400, 'bad_tx', 'That is not a transaction we know.'); }
    const r = await sponsor().submit(who, wire);
    // the wallet signed it and the user's token came with it: that is the proof they belong together
    if (r.kind !== 'buy') { if (!(await d.store.link(who, r.wallet))) throw new HttpError(403, 'not_yours', 'That wallet belongs to another account.'); await d.store.hit('session', who); if (r.kind === 'setup') await d.store.hit('account', q.ip); } else await d.store.hit('buy', who);
    return r;
  });
  app.post('/faucet', async (q) => {
    const row = await d.store.byDid(did(q)); if (!row) throw new HttpError(403, 'no_account', 'Finish signing in first.');
    await limit('faucet', row.wallet, 1, 'The faucet already paid you today.'); await limit('faucet-ip', q.ip, d.config.faucetPerIpDay, 'The faucet is busy on this network.');
    if (await d.l1.balance(sponsor().key.address) < FAUCET_FLOOR + d.config.faucetLamports) throw new HttpError(503, 'faucet_dry', 'The faucet is dry right now. Your chips still work.');
    await d.store.hit('faucet', row.wallet); await d.store.hit('faucet-ip', q.ip);      // counted first: a slow send must not pay twice
    return { signature: await sponsor().send([ix.transfer(sponsor().key.address, row.wallet, d.config.faucetLamports)]), sol: Number(d.config.faucetLamports) / 1e9 };
  });

  app.get('/bets', async (q) => ({ bets: await d.store.bets(wallet((q.query as any).wallet), 50) }));
  let board: { at: number; rows: unknown[] } | null = null;
  app.get('/leaderboard', async () => { if (board && Date.now() - board.at < 10_000) return { rows: board.rows }; const rows = []; for (const [w, n] of await d.store.nets()) { const r = await d.store.byWallet(w); if (r?.name) rows.push({ wallet: w, name: r.name, wagered: Math.round(n.wagered), net: Math.round(n.net) }); } rows.sort((a, b) => b.wagered - a.wagered); board = { at: Date.now(), rows: rows.slice(0, 20).map((r, i) => ({ rank: i + 1, ...r })) }; return { rows: board.rows }; });
  app.get('/names/check', async (q) => { const n = cleanName(String((q.query as any).name ?? '')), problem = nameProblem(n); if (problem) return { available: false, reason: problem }; const o = await d.store.byNameKey(nameKey(n)); return o && o.wallet !== (q.query as any).wallet ? { available: false, reason: 'That name is taken' } : { available: true }; });
  app.post('/names', async (q) => {
    const row = await d.store.byDid(did(q)); if (!row) throw new HttpError(403, 'no_account', 'Finish signing in first.');
    const b = (q.body ?? {}) as any, n = cleanName(String(b.name ?? '')), problem = nameProblem(n); if (problem) throw new HttpError(400, 'bad_name', problem);
    const avatar = /^[a-z_]{1,24}$/.test(String(b.avatar ?? '')) ? String(b.avatar) : null; await limit('name', row.wallet, 10, 'Too many name changes. Try again in an hour.', 3_600_000); await d.store.hit('name', row.wallet);
    if (!(await d.store.setName(row.wallet, n, nameKey(n), avatar))) throw new HttpError(409, 'name_taken', 'That name is taken. Pick another one.'); return { name: n };
  });
  return app;
}
