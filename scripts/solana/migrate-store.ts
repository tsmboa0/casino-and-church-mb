// One-off, at launch: copies the development server's file store into Postgres and hides the test campaigns
// (see apps/server/src/solana/migrate.ts). The server can do the same on start: SEED_STORE=<path> and ADMIN_ADDRESS.
//   DATABASE_URL=... tsx scripts/solana/migrate-store.ts [path/to/store.json]
import path from 'node:path';
import { migrate } from '../../apps/server/src/solana/migrate.ts';
import { PgStore } from '../../apps/server/src/solana/store.ts';
import { er, key } from './lib.ts';
const url = process.env.DATABASE_URL; if (!url) { console.log('set DATABASE_URL'); process.exit(1); }
const file = process.argv[2] ?? path.join(import.meta.dirname, '../../apps/server/.data/store.json');
console.log(JSON.stringify(await migrate(await PgStore.open(url), file, process.env.ADMIN_ADDRESS ?? key('admin').address, er))); process.exit(0);
