// What the BTC panel's clock would show right now: the chain time it trusts, and the seconds until betting closes.
import { addr, decodeFeed, decodeMarket, P } from '../../packages/realm/src/index.ts';
import { er } from './lib.ts';
const h = decodeMarket((await er.account(addr.market()))!.data)!, f = decodeFeed((await er.account(P.btcFeed))!.data);
const seen = Math.max(f?.at ?? 0, Number(h.open.openTs) || 0, Number(h.lastTickTs) || 0), guess = seen * 1000 - Date.now(), skew = Math.abs(guess) < 120_000 ? guess : 0;
console.log(JSON.stringify({ feedAgeS: +(Date.now() / 1000 - (f?.at ?? 0)).toFixed(1), skewMs: skew, betsCloseInS: Math.round((Number(h.open.lockTs) * 1000 - (Date.now() + skew)) / 1000), oldClockWouldSayS: Math.round((Number(h.open.lockTs) * 1000 - Number(h.lastTickTs) * 1000) / 1000) }));
process.exit(0);
