// One-off, at launch: copies a development file store (store.json) into Postgres: players, bets, BTC calls and rounds,
// round pages, host decisions and attestations, campaign details. Then hides every campaign on the board that the Church
// (the admin) did not open, so the live Quest Board starts clean. Run by the server on start when SEED_STORE is set and
// its database has no players yet, or by scripts/solana/migrate-store.ts.
import { readFileSync } from 'node:fs';
import { addr, decodeBoard, type Rpc } from '@cnc/realm';
import type { SolStore } from './store.ts';

export async function migrate(db: SolStore, file: string, admin: string, er: Rpc) {
  const j = JSON.parse(readFileSync(file, 'utf8')), n: Record<string, number> = {};
  const each = async <T>(name: string, rows: T[] | undefined, f: (r: T) => Promise<unknown>) => { n[name] = 0; for (const r of rows ?? []) { await f(r); n[name]++; } };
  await each('players', j.rows, async (r: any) => { await db.link(r.did, r.wallet); if (r.name) await db.setName(r.wallet, r.name, r.nameKey, r.avatar ?? null); });
  await each('bets', j.bets, (b: any) => db.addBet(b));
  await each('calls', j.calls, (c: any) => db.addCall(c));
  await each('rounds', j.rounds, (r: any) => db.addRound(r));
  await each('pages', Object.entries(j.pages ?? {}), ([p, tx]: any) => db.setPage(Number(p), tx));
  // attestations first, in their order, so the decisions that point at them keep their ids
  await each('attestations', [...(j.attestations ?? [])].sort((a: any, b: any) => a.id - b.id), async (a: any) => { const { id, ...rest } = a; const got = await db.addAttestation(rest); if (got.id !== id) console.log(`attestation ${id} is now ${got.id}`); });
  await each('decisions', j.decisions, (d: any) => db.addDecision(d));
  await each('details', j.details, (d: any) => db.addDetails(d));
  let hidden = 0;
  for (const b of [0, 1]) for (const c of decodeBoard((await er.account(addr.board(b)))!.data) ?? []) {
    if (c.creator === admin) continue;
    if ((await db.details([c.id]))[0]) await db.hideDetails(c.id, 'all');
    else await db.addDetails({ id: c.id, wallet: c.creator, project: '', description: '', steps: [], banner: null, at: Date.now(), hidden: true } as any);
    hidden++;
  }
  return { ...n, hiddenCampaigns: hidden };
}
