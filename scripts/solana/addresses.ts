// Every address the README lists: the program's accounts, the service keys (public halves only), and MagicBlock's.
import { createHash } from 'node:crypto';
import { addr, b58decode, P, pda, REALM } from '../../packages/realm/src/index.ts'; import { BTC_FEED, EU, key } from './lib.ts';
const pub = (n: string) => key(n).address;
console.log(JSON.stringify({
  program: REALM, config: addr.config(), bank: addr.bank(), housePurse: addr.housePurse(), house: addr.house(), market: addr.market(), plots: addr.plots(), board0: addr.board(0), board1: addr.board(1), decisions: addr.decisions(),
  crank: addr.marketCrank(createHash('sha256').update('cnc-market-2').digest()), admin: pub('admin'), sponsor: pub('sponsor'), keeper: pub('keeper'), oracle: pub('oracle'), fortuna: pub('fortuna'), nakamoto: pub('nakamoto'), feepayer: pub('feepayer'),
  btcFeed: BTC_FEED, validator: EU, feeVault: pda(['magic-fee-vault', b58decode(EU)], P.delegation), delegation: P.delegation, vrf: P.vrf, hydra: P.hydra, session: P.session,
}, null, 1));
process.exit(0);
