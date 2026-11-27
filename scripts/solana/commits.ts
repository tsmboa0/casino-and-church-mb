// How many saves to L1 the market has made on this delegation (it rotates on the ninth), and when the last was.
import { addr, decodeMarket } from '../../packages/realm/src/index.ts'; import { er, l1 } from './lib.ts';
const m = decodeMarket((await er.account(addr.market()))!.data)!, L = decodeMarket((await l1.account(addr.market()))!.data);
console.log(JSON.stringify({ commits: m.commits, lastSavedAgoMin: L ? Math.round((Date.now() / 1000 - Number(L.lastTickTs)) / 60) : null }));
process.exit(0);
