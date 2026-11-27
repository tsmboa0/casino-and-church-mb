// Is the market's copy on L1 fresh? (the latest saved round against the live one)
import { addr, decodeMarket } from '../../packages/realm/src/index.ts'; import { er, l1 } from './lib.ts';
const live = decodeMarket((await er.account(addr.market()))!.data)!, saved = decodeMarket((await l1.account(addr.market()))!.data)!;
console.log(JSON.stringify({ liveEpoch: Number(live.open.epoch), savedEpoch: Number(saved.open.epoch), commits: live.commits, savedCommits: saved.commits }));
process.exit(0);
