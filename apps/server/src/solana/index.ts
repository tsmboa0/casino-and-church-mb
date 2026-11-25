import { Rpc } from '@cnc/realm'; import { buildApp } from './app.ts'; import { config } from './config.ts'; import { Keeper } from './keeper.ts'; import { Sponsor } from './sponsor.ts'; import { FileStore, PgStore } from './store.ts';
const l1 = new Rpc(config.l1, 'l1'), er = new Rpc(config.er, 'er');
const store = config.databaseUrl ? await PgStore.open(config.databaseUrl) : new FileStore(new URL('../../.data/store.json', import.meta.url).pathname);
const sponsor = config.sponsor ? new Sponsor(l1, config.sponsor) : null;
const keeper = config.keeper && config.sponsor ? new Keeper(l1, er, config.keeper, config.sponsor, () => store.wallets()) : null; keeper?.start();
await buildApp({ config, store, l1, er, sponsor, keeper }).listen({ port: config.port, host: '0.0.0.0' });
console.log(JSON.stringify({ at: 'boot', port: config.port, sponsor: config.sponsor?.address ?? null, keeper: !!keeper, db: config.databaseUrl ? 'postgres' : 'file', er: config.er }));
