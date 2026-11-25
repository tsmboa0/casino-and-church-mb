import { ER, A, HYDRA, FEED } from './lib.mjs'; const now = Date.now() / 1000; const from = 1795600892, to = 1795600969; // 10:01:32 .. 10:02:49
const iso = (t) => new Date(t * 1000).toISOString().slice(11, 19);
async function scan(name, k, maxPages) { let before, all = []; for (let i = 0; i < maxPages; i++) { const s = await ER.getSignaturesForAddress(k, { limit: 1000, before }); if (!s.length) break; all.push(...s); before = s.at(-1).signature; if (s.at(-1).blockTime < from - 60) break; }
  const inWin = all.filter((x) => x.blockTime > from && x.blockTime < to).length; let worst = 0, at = 0, p = null; for (const x of all) { if (p && p.blockTime - x.blockTime > worst) { worst = p.blockTime - x.blockTime; at = x.blockTime; } p = x; } console.log(name, 'sigs', all.length, 'oldest', iso(all.at(-1).blockTime), 'during the stall', inWin, 'longest silence', worst, 's at', iso(at)); }
await scan('price feed (oracle writes)', FEED, 20); await scan('all Hydra cranks', HYDRA, 60);
