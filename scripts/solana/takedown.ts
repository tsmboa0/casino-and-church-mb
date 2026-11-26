// Takes a campaign's banner down (or the whole campaign page) on our server; with `close`, also closes it on chain
// (the admin key) so nobody can claim it, and its rest goes back to whoever paid.
//   takedown.ts <id>            the banner only
//   takedown.ts <id> all        the page disappears from the Quest Board
//   takedown.ts <id> all close  and closed on chain
import { ix, realmIx, u32 } from '../../packages/realm/src/index.ts'; import { er, key, send } from './lib.ts';
const [id, what, close] = process.argv.slice(2), api = process.env.API_URL ?? 'http://localhost:8787', token = process.env.ADMIN_TOKEN;
if (!id || !token) { console.log('usage: ADMIN_TOKEN=... takedown.ts <id> [all] [close]'); process.exit(1); }
const r = await fetch(`${api}/admin/campaigns/${id}/hide`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': token }, body: JSON.stringify({ what: what === 'all' ? 'all' : 'banner' }) }); console.log(r.status, await r.json());
if (close === 'close') { const admin = key('admin'); await send(er, [realmIx('close_campaign', { signer: admin.address, authority: admin.address, board: (await import('../../packages/realm/src/index.ts')).addr.board(Number(id) >> 7) }, u32(Number(id)))], [admin]); await send(er, [ix.collectCampaign(Number(id))], [admin]).catch((e) => console.log('collect: needs the creator, the keeper does it', e.code)); console.log('closed on chain'); }
process.exit(0);
