// The EU validator's magic fee vault (where paid commits go): does it exist, and is it delegated?
import { b58decode, P, pda } from '../../packages/realm/src/index.ts'; import { er, EU, l1 } from './lib.ts';
const vault = pda(['magic-fee-vault', b58decode(EU)], P.delegation);
console.log(JSON.stringify({ vault, l1: await l1.account(vault).then((a) => a && { owner: a.owner, lamports: a.lamports }), er: await er.account(vault).then((a) => a && { owner: a.owner, lamports: a.lamports }) }));
process.exit(0);
