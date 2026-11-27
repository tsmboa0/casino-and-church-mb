// One-off, at launch: copies the development server's file store into Postgres (players, bets, BTC calls and rounds,
// round pages, host decisions and attestations, campaign details and banners), then hides every campaign on the board
// that the Church did not open, so the live Quest Board starts clean.
//   DATABASE_URL=... tsx scripts/solana/migrate-store.ts [path/to/store.json]
import fs from 'node:fs'; import path from 'node:path';
import { addr, decodeBoard } from '../../packages/realm/src/index.ts';
import { PgStore } from '../../apps/server/src/solana/store.ts';
import { er, key } from './lib.ts';
const url = process.env.DATABASE_URL; if (!url) { console.log('set DATABASE_URL'); process.exit(1); }
const file = process.argv[2] ?? path.join(import.meta.dirname, '../../apps/server/.data/store.json'), j = JSON.parse(fs.readFileSync(file, 'utf8'));
const db = await PgStore.open(url); const n: Record<string, number> = {};
const each = async <T>(name: string, rows: T[] | undefined, f: (r: T) => Promise<unknown>) => { n[name] = 0; for (const r of rows ?? []) { await f(r); n[name]++; } };
await each('players', j.rows, async (r: any) => { await db.link(r.did, r.wallet); if (r.name) await db.setName(r.wallet, r.name, r.nameKey, r.avatar ?? null); });
await each('bets', j.bets, (b: any) => db.addBet(b));
await each('calls', j.calls, (c: any) => db.addCall(c));
await each('rounds', j.rounds, (r: any) => db.addRound(r));
await each('pages', Object.entries(j.pages ?? {}), ([p, tx]: any) => db.setPage(Number(p), tx));
// attestations first, in their order, so the decisions that point at them keep the same ids
await each('attestations', [...(j.attestations ?? [])].sort((a: any, b: any) => a.id - b.id), async (a: any) => { const { id, ...rest } = a; const got = await db.addAttestation(rest); if (got.id !== id) console.log(`attestation ${id} is now ${got.id}`); });
await each('decisions', j.decisions, (d: any) => db.addDecision(d));
await each('details', j.details, (d: any) => db.addDetails(d));
for (const f of fs.existsSync(path.join(path.dirname(file), 'banners')) ? fs.readdirSync(path.join(path.dirname(file), 'banners')) : []) { /* banners from tests stay behind: their campaigns are hidden below */ void f; }
// the board: only the Church's own campaigns stay visible
const admin = process.env.ADMIN_ADDRESS ?? key('admin').address; let hidden = 0;
for (const b of [0, 1]) for (const c of decodeBoard((await er.account(addr.board(b)))!.data) ?? []) {
  if (c.creator === admin) continue;
  const have = (await db.details([c.id]))[0];
  if (have) await db.hideDetails(c.id, 'all'); else await db.addDetails({ id: c.id, wallet: c.creator, project: '', description: '', steps: [], banner: null, at: Date.now(), hidden: true } as any);
  hidden++;
}
console.log(JSON.stringify({ ...n, hiddenCampaigns: hidden })); process.exit(0);
