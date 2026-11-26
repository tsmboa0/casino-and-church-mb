import cors from '@fastify/cors'; import Fastify from 'fastify'; import type { FastifyRequest } from 'fastify';
import { addr, b58decode, b64decode, b64encode, buildTx, CHIP, compileMessage, decodeBoard, decodeHouse, decodePlayer, hasClaimed, ix, REALM, type Ix, type Rpc } from '@cnc/realm';
import { CAMPAIGN_MIN_BUDGET, campaignCost, campaignProblem, cleanName, detailsProblem, DETAIL_LIMITS, nameKey, nameProblem, type CampaignDetails, type NewCampaign } from '@cnc/shared';
import { createHash } from 'node:crypto';
import { verifyPrivy } from './privy.ts'; import { FAUCET_FLOOR, SETUP_FLOOR, type Config } from './config.ts'; import { HttpError, type Sponsor } from './sponsor.ts'; import type { Keeper } from './keeper.ts'; import type { Indexer } from './indexer.ts'; import type { MarketKeeper } from './market.ts'; import type { Hosts } from './hosts/service.ts'; import { players, presence } from './hosts/observe.ts'; import type { SolStore } from './store.ts';

export interface Deps { config: Config; store: SolStore; l1: Rpc; er: Rpc; sponsor: Sponsor | null; keeper: Keeper | null; indexer?: Indexer | null; market?: MarketKeeper | null; hosts?: Hosts | null }
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
    const body = { ok: l1Slot !== null && erSlot !== null && !!house && !house.paused, program: REALM, l1: { up: l1Slot !== null, slot: l1Slot }, rollup: { up: erSlot !== null, slot: erSlot, url: d.config.er }, paused: house?.paused ?? null, sponsor: { address: d.config.sponsor?.address ?? null, sol: bal === null ? null : Number(bal) / 1e9, faucet: bal !== null && bal > FAUCET_FLOOR, accounts: bal !== null && bal > SETUP_FLOOR }, keeper: d.keeper?.status ?? null, books: d.keeper?.books ?? null, indexer: d.indexer?.status ?? null, market: d.market?.status ?? null, hosts: d.hosts?.status() ?? null, vault_chips: house ? Number(house.vault / CHIP) : null, players: await d.store.count() };
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
  // ---------------------------------------------------------------- campaigns. The oracle signs whole transactions that we built, so a
  // signature can only ever be used for that player and that campaign, for as long as its blockhash lives.
  const VISIT_S = 20, opened = new Map<string, number>();
  const oracle = () => { if (!d.config.oracle) throw new HttpError(503, 'no_oracle', 'Father Nakamoto is away. Try again later.'); return d.config.oracle; };
  const cosign = async (session: string, ixs: Ix[]) => b64encode(buildTx(compileMessage(session, ixs, await d.er.blockhash()), [oracle()]));
  const boards = async () => Promise.all([0, 1].map(async (i) => { const a = await d.er.account(addr.board(i)); return (a && decodeBoard(a.data)) ?? []; }));
  const me = async (q: FastifyRequest) => { const row = await d.store.byDid(did(q)); if (!row) throw new HttpError(403, 'no_account', 'Finish signing in first.'); return row; };
  /** moderation: the Father signs only what passes the Church's rules (no wallet or airdrop links, known sites) */
  /** an image a campaign shows: PNG, JPEG, WebP or GIF, checked by its first bytes, at most 1.5 MB */
  const image = (dataUrl: unknown): { mime: string; bytes: Buffer } | null => {
    if (dataUrl == null || dataUrl === '') return null; const m = /^data:([a-z/]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl)); if (!m) throw new HttpError(400, 'bad_campaign', 'That banner is not an image.');
    const bytes = Buffer.from(m[2], 'base64'); if (bytes.length > DETAIL_LIMITS.bannerBytes) throw new HttpError(400, 'bad_campaign', 'The banner must be under 1.5 MB.');
    const sig = bytes.subarray(0, 12).toString('hex'), mime = sig.startsWith('89504e47') ? 'image/png' : sig.startsWith('ffd8ff') ? 'image/jpeg' : sig.startsWith('47494638') ? 'image/gif' : sig.startsWith('52494646') && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
    if (!mime) throw new HttpError(400, 'bad_campaign', 'The banner must be a PNG, JPEG, WebP or GIF.'); return { mime, bytes };
  };
  app.post('/campaigns/approve', { bodyLimit: 2_200_000 }, async (q) => {
    const row = await me(q), b = (q.body ?? {}) as any, s = wallet(b.session), c = b.campaign ?? {}, dt = (b.details ?? {}) as CampaignDetails;
    const n: NewCampaign = { kind: Number(c.kind), title: String(c.title ?? ''), url: String(c.url ?? ''), machine_id: Number(c.machine_id ?? 0), goal: Number(c.goal ?? 0), reward_chips: Number(c.reward_chips ?? 0), reward_faith_milli: Number(c.reward_faith_milli ?? 0), max_claims: Number(c.max_claims ?? 0), days: Number(c.days ?? 7) };
    for (const v of [n.kind, n.machine_id, n.goal, n.reward_chips, n.reward_faith_milli, n.max_claims, n.days!]) if (!Number.isInteger(v) || v < 0) throw new HttpError(400, 'bad_campaign', 'Use whole numbers.');
    const details: CampaignDetails = { project: String(dt.project ?? '').trim(), description: String(dt.description ?? '').trim(), steps: Array.isArray(dt.steps) ? dt.steps.map((x) => String(x).trim()).filter(Boolean) : [] };
    const dp = detailsProblem(details); if (dp) throw new HttpError(400, 'bad_campaign', dp);
    if (campaignCost(n).budget < (CAMPAIGN_MIN_BUDGET[n.kind] ?? Infinity)) throw new HttpError(400, 'bad_campaign', `A ${['social', 'project', 'machine'][n.kind] ?? ''} campaign locks up at least ${CAMPAIGN_MIN_BUDGET[n.kind]} chips for its rewards.`);
    const img = image(dt.banner);
    const problem = campaignProblem(n) ?? (/^[\x20-\x7e]+$/.test(n.title) ? null : 'Plain letters only in the title, please.'); if (problem) throw new HttpError(400, 'bad_campaign', problem);
    await limit('campaign', row.wallet, 15, 'The Father has read enough from you today.'); await d.store.hit('campaign', row.wallet);
    const live = await boards(), board = live[0].filter((x) => x.active || x.budget > 0n).length < 20 ? 0 : 1; const tx = await cosign(s, [ix.createCampaign(row.wallet, s, oracle().address, board, { ...n, days: n.days! })]);
    let banner: string | null = null; if (img) { banner = createHash('sha256').update(img.bytes).digest('hex'); await d.store.addBanner(banner, img.mime, img.bytes); }
    await d.store.addDetails({ id: null, wallet: row.wallet, ...details, banner, at: Date.now(), hidden: false });      // bound to the campaign when the chain names it
    return { tx };
  });
  /** what campaigns show beyond the chain */
  app.get('/campaigns/details', async (q) => { const ids = String((q.query as any).ids ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 0).slice(0, 60); return { details: (await d.store.details(ids)).filter((x) => !x.hidden).map((x) => ({ id: x.id, project: x.project, description: x.description, steps: x.steps, banner: x.banner ? `/banners/${x.banner}` : null })), hidden: (await d.store.details(ids)).filter((x) => x.hidden).map((x) => x.id) }; });
  app.get('/banners/:sha', async (q, reply) => { const b = await d.store.banner(String((q.params as any).sha)); if (!b) throw new HttpError(404, 'not_found', 'No such banner.'); return reply.header('content-type', b.mime).header('cache-control', 'public, max-age=31536000, immutable').header('x-content-type-options', 'nosniff').header('content-security-policy', "default-src 'none'").send(b.bytes); });
  /** taking down what should not be there: ADMIN_TOKEN, from a script */
  app.post('/admin/campaigns/:id/hide', async (q) => {
    const token = process.env.ADMIN_TOKEN; if (!token || q.headers['x-admin-token'] !== token) throw new HttpError(403, 'not_allowed', 'No.');
    const what = (q.body as any)?.what === 'all' ? 'all' : 'banner'; return { ok: await d.store.hideDetails(Number((q.params as any).id), what), what };
  });
  /** the player opens a social or project task: the visit starts */
  app.post('/campaigns/:id/start', async (q) => { const row = await me(q), id = Number((q.params as any).id); if (opened.size > 20_000) opened.clear(); opened.set(`${id}:${row.wallet}`, Date.now()); return { visit_s: VISIT_S }; });
  app.post('/campaigns/:id/claim', async (q) => {
    const row = await me(q), id = Number((q.params as any).id), s = wallet((q.body as any)?.session); const c = (await boards()).flat().find((x) => x.id === id);
    if (!c || !c.active) throw new HttpError(404, 'CampaignClosed', 'That campaign has ended.'); if (c.kind === 2) throw new HttpError(400, 'bad_args', 'Machine campaigns are checked on chain.');
    const acct = await d.er.account(addr.player(row.wallet)), p = acct && decodePlayer(acct.data); if (p && hasClaimed(p, id)) throw new HttpError(409, 'AlreadyClaimed', 'You already claimed this one.');
    const at = opened.get(`${id}:${row.wallet}`), waited = at ? (Date.now() - at) / 1000 : 0; if (!at) throw new HttpError(400, 'not_done', 'Open the task first.'); if (waited < VISIT_S) throw new HttpError(400, 'not_done', `Give it ${Math.ceil(VISIT_S - waited)} more seconds.`);
    await limit('attest', row.wallet, 40, 'The Church needs a rest. Try again tomorrow.'); await d.store.hit('attest', row.wallet);
    return { tx: await cosign(s, [ix.claimCampaign(row.wallet, s, id, oracle().address)]) };
  });
  // ---------------------------------------------------------------- the AI hosts
  const who = (v: unknown) => (v === 'nakamoto' ? 'nakamoto' : v === 'fortuna' ? 'fortuna' : null);
  app.get('/agent/feed', async (q) => { const a = (q.query as any); return { decisions: d.hosts ? await d.hosts.feed(who(a.agent) ?? 'all', Number(a.limit) || 20) : [] }; });
  app.get('/agent/decision/:id/proof', async (q) => { const r = d.hosts ? await d.hosts.proof(String((q.params as any).id).slice(0, 40)) : null; if (!r) throw new HttpError(404, 'not_found', 'No such decision.'); return r; });
  app.post('/agent/ask', async (q) => {
    const b = (q.body ?? {}) as any, agent = who(b.agent); if (!agent) throw new HttpError(400, 'bad_args', 'Ask Don Fortuna or Father Nakamoto.'); if (!d.hosts) throw new HttpError(503, 'resting', 'The hosts are resting.');
    let id = `ip:${q.ip}`; try { const row = await d.store.byDid(did(q)); if (row) id = row.wallet; } catch { /* guests may ask too, within the IP limit */ }
    return d.hosts.ask(agent, String(b.question ?? ''), id, q.ip);
  });
  /** the floor, as the Monitor and the Ledger show it */
  let floor: { at: number; body: any } | null = null;
  const floorNow = async () => {
    if (floor && Date.now() - floor.at < 10_000) return floor.body;
    const now = Date.now(), [h0, day, ps, decs] = await Promise.all([d.er.account(addr.house()), d.store.betStats(now - 86_400_000), d.store.wallets().then((w) => players(d.er, w)), d.store.decisions('nakamoto', 200)]);
    const h = decodeHouse(h0!.data)!, on = presence(ps, now), c = (v: bigint) => Number(v / CHIP), sec = now / 1000;
    const name = day.biggest ? (await d.store.byWallet(day.biggest.wallet))?.name ?? 'a player' : null, church = d.hosts?.church.since(now - 86_400_000) ?? { tithes: 0, candles: 0 };
    const events = h.hosts.events.map((e, i) => ({ e, i })).filter(({ e }) => e.active && e.ends > sec).map(({ e, i }) => ({ kind: i ? 'vigil' : 'happy_hour', realm: i ? 'church' : 'casino', endsAt: e.ends * 1000, boostBps: i ? e.boostBps : 10_000, by: i ? 'nakamoto' : 'fortuna' }));
    floor = { at: now, body: { events,
      house: { playersOnline: on.online, inCasino: on.casino, inChurch: on.church, inPlaza: on.plaza, volume24h: Math.round(day.volume), houseNet24h: Math.round(day.houseNet), vault: c(h.vault), vaultFree: c(h.vault - h.reserved), jackpot: c(h.jackpot), maxBet: h.maxBetChips, luckPerChipMilli: h.hosts.luckPerChipMilli, edgeRealized24h: day.volume ? day.houseNet / day.volume : 0, edgeExpected: 0.045, biggestWin24h: day.biggest ? { name, chips: Math.round(day.biggest.payout), game: day.biggest.game } : null, timeouts24h: 0 },
      church: { treasury: c(h.treasury), tithes24h: Math.round(church.tithes), candles24h: church.candles, alms24h: decs.filter((x) => x.applied && x.action === 'grant_alms' && x.at >= now - 86_400_000).reduce((n, x) => n + Number(x.params.chips ?? 0), 0), blessingsPaid24h: 0, blessingCapBps: h.hosts.blessingCapBps, candleFaithMilli: h.hosts.candleFaithMilli, faithfulOnline: on.church } } };
    return floor.body;
  };
  app.get('/floor', async () => floorNow());
  /** names for wallets on screen (plot owners, campaign creators) */
  app.get('/who', async (q) => { const out: Record<string, string> = {}; for (const w of String((q.query as any).wallets ?? '').split(',').slice(0, 30)) { const r = w && await d.store.byWallet(w); if (r && r.name) out[w] = r.name; } return { names: out }; });
  /** who called what, with names. The rounds and their totals come from the chain itself */
  let crowd = new Map<string, { at: number; body: unknown }>();
  app.get('/market/crowd', async (q) => {
    const epochs = String((q.query as any).epochs ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 3), key = epochs.join(); const c = crowd.get(key); if (c && Date.now() - c.at < 1_000) return c.body;
    const out: Record<number, unknown[]> = {}; for (const r of await d.store.calls(epochs)) (out[r.epoch] ??= []).push({ wallet: r.wallet, seq: r.seq, side: r.side, chips: r.chips, who: (await d.store.byWallet(r.wallet))?.name ?? `${r.wallet.slice(0, 4)}..${r.wallet.slice(-4)}` });
    if (crowd.size > 50) crowd = new Map(); const body = { crowd: out }; crowd.set(key, { at: Date.now(), body }); return body;
  });
  app.get('/market/rounds', async (q) => { const b = Number((q.query as any).before), n = Math.min(100, Math.max(1, Number((q.query as any).limit) || 40)); return { rounds: await d.store.rounds(Number.isInteger(b) && b > 0 ? b : null, n) }; });
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
