import test from 'node:test'; import assert from 'node:assert/strict'; import { generateKeyPairSync, sign } from 'node:crypto';
import { addSignatures, b58encode, b64decode, b64encode, buildTx, compileMessage, ix, newSigner, parseTx, REALM, type Rpc } from '@cnc/realm';
import { buildApp } from '../src/solana/app.ts'; import { config } from '../src/solana/config.ts'; import { verifyPrivy } from '../src/solana/privy.ts'; import { Sponsor } from '../src/solana/sponsor.ts'; import { FileStore } from '../src/solana/store.ts';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }); const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString(); const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (sub: string, over: Record<string, unknown> = {}, key = privateKey, alg = 'ES256') => { const m = `${enc({ alg, typ: 'JWT' })}.${enc({ iss: 'privy.io', aud: 'app', sub: `did:privy:${sub}`, exp: Math.floor(Date.now() / 1000) + 600, ...over })}`; return `${m}.${sign('sha256', Buffer.from(m), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`; };
function rig(balance = 9_000_000_000n) {
  const sent: Uint8Array[] = []; let n = 0; const l1 = { blockhash: async () => b58encode(new Uint8Array(32).fill(++n)), account: async () => null, balance: async () => balance, slot: async () => 1, send: async (w: Uint8Array) => { sent.push(w); return 'sig'; } } as unknown as Rpc;
  const key = newSigner(), sponsor = new Sponsor(l1, key), store = new FileStore(null); const app = buildApp({ config: { ...config, privyAppId: 'app', privyKey: pem, sponsor: key, accountsPerIpDay: 3 } as any, store, l1, er: l1, sponsor, keeper: null });
  const post = async (url: string, body: unknown, who?: string) => { const r = await app.inject({ method: 'POST', url, payload: body as any, headers: who ? { authorization: `Bearer ${who}` } : {} }); return { status: r.statusCode, ...r.json() }; };
  const setup = async (who: string, w = newSigner(), s = newSigner()) => { const r = await post('/account/prepare', { wallet: w.address, session: s.address }, who); return { r, w, s, tx: r.tx ? addSignatures(b64decode(r.tx), [w, s]) : null }; };
  return { app, post, setup, sent, sponsor, store, key };
}
test('Privy tokens: only real, current ones for this app', () => {
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey; assert.equal(verifyPrivy(jwt('a'), 'app', pem), 'did:privy:a');
  for (const [n, t] of Object.entries({ none: undefined, junk: 'x.y.z', otherKey: jwt('a', {}, other), otherApp: jwt('a', { aud: 'x' }), issuer: jwt('a', { iss: 'x' }), expired: jwt('a', { exp: 1 }), none2: jwt('a', {}, privateKey, 'none'), sub: jwt('a', { sub: 'a' }) })) assert.equal(verifyPrivy(t as any, 'app', pem), null, n);
  const [h, , s] = jwt('a').split('.'); assert.equal(verifyPrivy(`${h}.${enc({ iss: 'privy.io', aud: 'app', sub: 'did:privy:b', exp: 9e9 })}.${s}`, 'app', pem), null);
});
test('setup: prepared unsigned, signed by the sponsor only at the end, one use', async () => {
  const g = rig(), who = jwt('a'), { r, tx, w } = await g.setup(who); assert.equal(r.kind, 'setup'); assert.ok(parseTx(b64decode(r.tx)).signatures.every((x) => x.every((b) => b === 0)), 'nothing signed yet');
  const done = await g.post('/tx/submit', { tx: b64encode(tx!) }, who); assert.equal(done.status, 200); assert.equal(g.sent.length, 1); assert.equal((await g.store.byDid('did:privy:a'))?.wallet, w.address);
  assert.equal((await g.post('/tx/submit', { tx: b64encode(tx!) }, who)).error, 'expired');
});
test('the sponsor refuses everything else', async () => {
  const g = rig(), a = jwt('a'), b = jwt('b'); assert.equal((await g.post('/account/prepare', {})).status, 401); const { tx, w, s, r } = await g.setup(a);
  assert.equal((await g.post('/tx/submit', { tx: b64encode(tx!) }, b)).error, 'not_allowed', "someone else's transaction");
  assert.equal((await g.post('/tx/submit', { tx: b64encode(addSignatures(b64decode(r.tx), [w])) }, a)).error, 'unsigned', 'a signature is missing');
  const steal = compileMessage(g.key.address, [ix.transfer(g.key.address, w.address, 1_000_000_000n)], b58encode(new Uint8Array(32).fill(9))); assert.equal((await g.post('/tx/submit', { tx: b64encode(buildTx(steal, [w])) }, a)).error, 'expired', 'a transfer we never issued');
  const p = parseTx(tx!); const m = p.message.slice(); m[m.length - 12] ^= 1; assert.equal((await g.post('/tx/submit', { tx: b64encode(buildTx(m, [w, s])) }, a)).error, 'expired', 'one byte changed');
  assert.equal((await g.post('/tx/submit', { tx: 'AAAA' }, a)).status, 400); assert.equal((await g.post('/account/prepare', { wallet: w.address, session: w.address }, a)).status, 400, 'wallet as its own session'); assert.equal((await g.post('/account/prepare', { wallet: 'nope', session: s.address }, a)).status, 400); assert.equal(g.sent.length, 0);
});
test('one wallet per user and one user per wallet', async () => {
  const g = rig(), a = jwt('a'), b = jwt('b'), x = await g.setup(a); await g.post('/tx/submit', { tx: b64encode(x.tx!) }, a); assert.equal((await g.setup(b, x.w)).r.error, 'not_yours'); assert.equal((await g.setup(a)).r.error, 'not_yours'); assert.equal((await g.setup(a, x.w)).r.status, 200, 'the owner may renew');
});
test('quotas, low balance, faucet, names', async () => {
  const g = rig(); for (const u of ['a', 'b', 'c']) { const x = await g.setup(jwt(u)); assert.equal((await g.post('/tx/submit', { tx: b64encode(x.tx!) }, jwt(u))).status, 200); } assert.equal((await g.setup(jwt('d'))).r.error, 'quota');
  assert.equal((await g.post('/faucet', {}, jwt('z'))).error, 'no_account'); assert.equal((await g.post('/faucet', {}, jwt('a'))).sol, 0.05); assert.equal((await g.post('/faucet', {}, jwt('a'))).error, 'quota');
  assert.equal((await g.post('/names', { name: 'Magpie 77' }, jwt('a'))).name, 'Magpie 77'); assert.equal((await g.post('/names', { name: 'mag-pie77' }, jwt('b'))).error, 'name_taken'); assert.equal((await g.post('/names', { name: 'admin' }, jwt('b'))).error, 'bad_name');
  assert.equal((await g.post('/buy/prepare', { wallet: (await g.store.byDid('did:privy:a'))!.wallet, chips: 9 }, jwt('a'))).error, 'bad_args'); assert.ok((await g.post('/buy/prepare', { wallet: (await g.store.byDid('did:privy:a'))!.wallet, chips: 50 }, jwt('a'))).tx);
  assert.equal((await rig(100n).setup(jwt('a'))).r.error, 'no_sponsor'); assert.equal((await rig(500_000_000n).post('/faucet', {}, jwt('a'))).error, 'no_account'); void REALM;
});
