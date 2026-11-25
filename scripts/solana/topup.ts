import { ix } from '../../packages/realm/src/index.ts'; import { cli, key, l1, send } from './lib.ts';
const to = key(process.argv[2]).address, want = BigInt(Math.round(Number(process.argv[3]) * 1e9)), have = await l1.balance(to); if (have < want) await send(l1, [ix.transfer(cli().address, to, want - have)], [cli()]); console.log(process.argv[2], Number(await l1.balance(to)) / 1e9, 'SOL');
