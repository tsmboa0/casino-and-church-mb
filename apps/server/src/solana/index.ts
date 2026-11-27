import { Rpc } from '@cnc/realm'; import { buildApp } from './app.ts'; import { config } from './config.ts'; import { Indexer } from './indexer.ts'; import { Keeper } from './keeper.ts'; import { MarketKeeper } from './market.ts'; import { Hosts } from './hosts/service.ts'; import { Sponsor } from './sponsor.ts'; import { FileStore, PgStore } from './store.ts';
const l1 = new Rpc(config.l1, 'l1'), er = new Rpc(config.er, 'er');
const store = config.databaseUrl ? await PgStore.open(config.databaseUrl) : new FileStore(new URL('../../.data/store.json', import.meta.url).pathname);
// launch: copy the development store in once, while the database has no players
if (process.env.SEED_STORE && config.databaseUrl && process.env.ADMIN_ADDRESS && (await store.count()) === 0) { const { migrate } = await import('./migrate.ts'); console.log(JSON.stringify({ at: 'seeded', ...(await migrate(store, new URL(`../../../../${process.env.SEED_STORE}`, import.meta.url).pathname, process.env.ADMIN_ADDRESS, er)) })); }
const sponsor = config.sponsor ? new Sponsor(l1, config.sponsor) : null;
const market = config.keeper ? new MarketKeeper(l1, er, config.keeper, store) : null; if (process.env.MARKET_KEEPER !== '0') market?.start();
const keeper = config.keeper && config.sponsor ? new Keeper(l1, er, config.keeper, config.sponsor, () => store.wallets(), 20_000, market) : null; keeper?.start();
const hosts = new Hosts(config.hosts, l1, er, store, { fortuna: config.fortuna, nakamoto: config.nakamoto }); if (process.env.HOSTS !== '0') hosts.start();
const indexer = new Indexer(er, store); indexer.onChurch = (k, chips, at) => hosts.church.add(k, chips, at); indexer.start();
const app = buildApp({ config, store, l1, er, sponsor, keeper, indexer, market, hosts }); await app.listen({ port: config.port, host: '0.0.0.0' });
// alerts: every minute the server reads its own health; a change is logged, and sent to ALERT_WEBHOOK (Discord or Slack) when set
let raised = '';
setInterval(async () => {
  try {
    const h = (await app.inject({ method: 'GET', url: '/healthz' })).json() as { alerts?: string[] }; const now = (h.alerts ?? []).join('; ');
    if (now === raised) return; raised = now; const text = now ? `Casino & Church: ${now}` : 'Casino & Church: all clear';
    console.log(`[alert] ${text}`);
    if (process.env.ALERT_WEBHOOK) await fetch(process.env.ALERT_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text, text }) }).catch(() => {});
  } catch { /* the next minute */ }
}, 60_000).unref();
console.log(JSON.stringify({ at: 'boot', port: config.port, sponsor: config.sponsor?.address ?? null, keeper: !!keeper, db: config.databaseUrl ? 'postgres' : 'file', er: config.er }));
