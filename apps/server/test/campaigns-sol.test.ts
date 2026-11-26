import test from 'node:test'; import assert from 'node:assert/strict'; import { generateKeyPairSync, sign } from 'node:crypto';
import { addr, b58encode, b64decode, ix, newSigner, parseTx, REALM, type Rpc } from '@cnc/realm'; import { IDL } from '../../../packages/realm/src/idl.ts';
import { buildApp } from '../src/solana/app.ts'; import { config } from '../src/solana/config.ts'; import { FileStore } from '../src/solana/store.ts';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }); const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString(), enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (sub: string) => { const m = `${enc({ alg: 'ES256' })}.${enc({ iss: 'privy.io', aud: 'app', sub: `did:privy:${sub}`, exp: 9e9 })}`; return `${m}.${sign('sha256', Buffer.from(m), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`; };
/** board 0 with one open campaign per kind, ids 0, 1 and 2 */
function board() { const d = new Uint8Array(8 + 20 * 304 + 72), v = new DataView(d.buffer); d.set(IDL.accounts.Board as readonly number[]); for (const i of [0, 1, 2]) { const at = 8 + i * 304; d[at] = 9; v.setBigInt64(at + 40, 1n, true); v.setUint32(at + 48, i, true); d[at + 76] = i; d[at + 77] = 1; } return d; }
async function rig() {
  const oracle = newSigner(), store = new FileStore(null), er = { blockhash: async () => b58encode(new Uint8Array(32).fill(3)), account: async (a: string) => (a === addr.board(0) ? { data: board(), owner: REALM, lamports: 1 } : null) } as unknown as Rpc;
  const app = buildApp({ config: { ...config, privyAppId: 'app', privyKey: pem, oracle } as any, store, l1: er, er, sponsor: null, keeper: null }); const w = newSigner(), s = newSigner(); await store.link('did:privy:a', w.address);
  const post = async (url: string, body: unknown, who?: string) => { const r = await app.inject({ method: 'POST', url, payload: body as any, headers: who ? { authorization: `Bearer ${who}` } : {} }); return { status: r.statusCode, ...(r.json() as any) }; }; return { oracle, w, s, post };
}
const good = { kind: 1, title: 'Read the docs', url: 'https://docs.magicblock.gg/', machine_id: 0, goal: 0, reward_chips: 50, reward_faith_milli: 1000, max_claims: 20, days: 7 };
const details = { project: 'MagicBlock', description: 'Learn how Ephemeral Rollups make games fast.', steps: ['Open the docs', 'Read the first page'] };
// a 1x1 PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
test('the oracle signs exactly the campaign it read, for exactly this player, and nothing it did not build', async () => {
  const g = await rig(), a = jwt('a'); assert.equal((await g.post('/campaigns/approve', { session: g.s.address, campaign: good })).status, 401); assert.equal((await g.post('/campaigns/approve', { session: g.s.address, campaign: good }, jwt('b'))).error, 'no_account');
  const r = await g.post('/campaigns/approve', { session: g.s.address, campaign: good, details: { ...details, banner: PNG }, wallet: newSigner().address, tx: 'AAAA' }, a); assert.equal(r.status, 200); const p = parseTx(b64decode(r.tx)); assert.equal(p.keys[0], g.s.address); assert.deepEqual(p.programs, [REALM]); assert.ok(p.keys.includes(addr.player(g.w.address)), 'the wallet of the signed-in user, whatever the body says');
  const want = ix.createCampaign(g.w.address, g.s.address, g.oracle.address, 0, good); const raw = Buffer.from(p.message); assert.ok(raw.includes(Buffer.from(want.data)), 'the same campaign, byte for byte'); assert.equal(p.signatures.filter((x) => x.some((b) => b)).length, 1, 'only the oracle has signed');
  assert.equal((await g.post('/campaigns/approve', { session: g.s.address, campaign: { ...good, max_claims: 19 }, details }, a)).error, 'bad_campaign', 'a project locks 1 SOL at least');
  for (const d of [{ ...details, project: '' }, { ...details, description: 'see https://evil.example' }, { ...details, steps: ['<script>'] }, { ...details, description: 'Free airdrop for everyone today' }, { ...details, banner: 'data:image/png;base64,PHN2Zz48L3N2Zz4=' }]) assert.equal((await g.post('/campaigns/approve', { session: g.s.address, campaign: good, details: d }, a)).error, 'bad_campaign', JSON.stringify(d).slice(0, 60));
  for (const bad of [{ title: 'Claim your airdrop' }, { url: 'https://evil.example/' }, { url: 'http://x.com/a' }, { reward_chips: 51 }, { reward_chips: 1.5 }, { max_claims: -1 }, { kind: 7 }, { days: 0 }, { days: 31 }, { title: 'Café ‮' }, { title: 'x' }]) assert.equal((await g.post('/campaigns/approve', { session: g.s.address, campaign: { ...good, ...bad }, details }, a)).error, 'bad_campaign', JSON.stringify(bad));
  for (let i = 0; i < 14; i++) await g.post('/campaigns/approve', { session: g.s.address, campaign: good, details }, a); assert.equal((await g.post('/campaigns/approve', { session: g.s.address, campaign: good, details }, a)).error, 'quota');
});
test('a claim is signed only after the visit, and never for machine campaigns', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 }); const g = await rig(), a = jwt('a'); const claim = (id: number) => g.post(`/campaigns/${id}/claim`, { session: g.s.address }, a);
  assert.equal((await claim(1)).error, 'not_done'); await g.post('/campaigns/1/start', {}, a); t.mock.timers.tick(19_000); assert.equal((await claim(1)).error, 'not_done'); t.mock.timers.tick(2_000); const r = await claim(1); assert.equal(r.status, 200); const p = parseTx(b64decode(r.tx)); assert.ok(Buffer.from(p.message).includes(Buffer.from(ix.claimCampaign(g.w.address, g.s.address, 1, g.oracle.address).data)));
  assert.equal((await claim(0)).error, 'not_done', 'another campaign needs its own visit'); assert.equal((await claim(2)).error, 'bad_args'); assert.equal((await claim(99)).error, 'CampaignClosed');
});
test('details wait for their campaign, banners are served as images, and can be taken down', async () => {
  const store = new FileStore(null), w = newSigner().address; await store.addDetails({ id: null, wallet: w, ...details, banner: 'ab'.repeat(32), at: Date.now(), hidden: false });
  await store.bindDetails(newSigner().address, 5); assert.equal((await store.details([5])).length, 0, 'another wallet');
  await store.bindDetails(w, 7); await store.bindDetails(w, 8); assert.equal((await store.details([7]))[0].project, 'MagicBlock'); assert.equal((await store.details([8])).length, 0, 'bound once');
  await store.hideDetails(7, 'banner'); assert.equal((await store.details([7]))[0].banner, null);
});
