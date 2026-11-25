import fs from 'node:fs'; import os from 'node:os'; import { ER, L1, A, get, key, Keypair, playerOf, purseOf, ix, send, PROGRAM, until } from './lib.mjs';
const show = (n, o, ks) => console.log(n, o ? ks.map((k) => `${k}=${o[k]}`).join(' ') : 'MISSING');
const m = await get(ER, 'Market', A.market), h = await get(ER, 'House', A.house); show('ER market', m, ['epoch', 'closed', 'voided', 'by_crank', 'calls', 'last_call_ts']); show('L1 market', await get(L1, 'Market', A.market), ['epoch', 'closed', 'calls']); show('ER house ', h, ['settled', 'stale', 'burn', '_lamports']); show('L1 house ', await get(L1, 'House', A.house), ['settled', 'stale', '_lamports']);
const k = JSON.parse(fs.readFileSync(os.homedir() + '/.config/casino-mb/devnet/spike-player.json')); const owner = Keypair.fromSecretKey(Uint8Array.from(k.owner)), s = Keypair.fromSecretKey(Uint8Array.from(k.session)); const p = playerOf(owner.publicKey);
show('ER player', await get(ER, 'Player', p), ['chips', 'credited', 'withdrawn', 'commits']); show('L1 player', await get(L1, 'Player', p), ['chips', 'credited', 'withdrawn', 'commits', '_owner']);
// is it still usable?
try { await send(ER, ix('sync_deposit', { player: p, purse: purseOf(owner.publicKey) }), [s], { label: 'sync' }); console.log('sync after outage: ok'); } catch (e) { console.log('sync after outage:', e.message.slice(0, 160)); }
const v = await ER.getVersion(); console.log('version', JSON.stringify(v), 'slot', await ER.getSlot(), 'first available', await ER.getFirstAvailableBlock?.().catch((e) => e.message.slice(0, 60)));
const sg = await ER.getSignaturesForAddress(A.market, { limit: 3 }); console.log('market history kept', sg.length, sg[0] && new Date(sg[0].blockTime * 1000).toISOString());
