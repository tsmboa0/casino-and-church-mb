// The live site, from outside: the page loads in Chrome with no errors (as a visitor and as the offline demo), the art
// and banners are there, and the API answers every public call the panels make, with CORS for the site.
//   SITE=https://casino-and-church-mb.vercel.app API=https://server-production-41bf466c.up.railway.app tsx scripts/ui/prod.ts
import { spawn } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const SITE = process.env.SITE ?? 'https://casino-and-church-mb.vercel.app', API = process.env.API ?? 'https://server-production-41bf466c.up.railway.app', OUT = process.env.OUT ?? os.tmpdir();
let failed = 0; const check = (n: string, ok: boolean, info: unknown = '') => { if (!ok) failed++; console.log(ok ? 'ok  ' : 'FAIL', n, typeof info === 'string' ? info : JSON.stringify(info)); };
const sleep = (m: number) => new Promise((r) => setTimeout(r, m));
// the API
const get = async (p: string) => { const r = await fetch(API + p, { headers: { origin: SITE } }); return { status: r.status, cors: r.headers.get('access-control-allow-origin'), body: await r.json().catch(() => null) as any }; };
const h = await get('/healthz'); check('health: ok, no alerts', h.status === 200 && h.body?.ok === true && !h.body?.alerts?.length, h.body?.alerts ?? h.status);
check('CORS allows the site', h.cors === SITE, h.cors);
for (const p of ['/floor', '/leaderboard', '/market/crowd', '/market/rounds?limit=5', '/agent/feed?limit=5', '/campaigns/details?ids=0,1,2', '/names/check?name=zz' + Date.now() % 100000]) { const r = await get(p); check(`GET ${p.split('?')[0]}`, r.status === 200 && !!r.body, r.status); }
const rounds = await get('/market/rounds?limit=3'); check('past BTC rounds are there', (rounds.body?.rounds?.length ?? 0) > 0, rounds.body?.rounds?.length);
const feed = await get('/agent/feed?limit=3'); const dec = feed.body?.decisions?.[0]; check('the AI hosts have decided', !!dec, dec?.id);
if (dec) { const pr = await get(`/agent/decision/${dec.id}/proof`); check('a decision has its signed proof', pr.status === 200 && !!pr.body?.proof?.signature, pr.status); }
const signedOut = await fetch(API + '/faucet', { method: 'POST', headers: { origin: SITE, 'content-type': 'application/json' }, body: '{}' }); check('money calls need a signed-in player', signedOut.status === 401, signedOut.status);
const admin = await fetch(API + '/admin/campaigns/1/hide', { method: 'POST', headers: { 'x-admin-token': 'guess' } }); check('admin needs the token', admin.status === 403, admin.status);
// the site in Chrome
for (const p of ['/', '/assets/vendor-built/atlas-0.png', '/assets/vendor-built/banners/church.jpg', '/llms.txt']) { const r = await fetch(SITE + p); check(`site ${p}`, r.status === 200, r.status); }
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=9355', `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'p-'))}`, '--enable-unsafe-swiftshader', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
await sleep(4000);
const pg = (await (await fetch('http://127.0.0.1:9355/json')).json()).find((x: any) => x.type === 'page'), ws = new WebSocket(pg.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const w = new Map<number, (v: any) => void>(), errs: string[] = []; ws.onmessage = (m) => { const d = JSON.parse(String(m.data)); if (w.has(d.id)) { w.get(d.id)!(d.result); w.delete(d.id); } else if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text); };
const cmd = (method: string, params = {}) => new Promise<any>((r) => { const n = ++id; w.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); }), js = async (e: string) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value;
await cmd('Runtime.enable'); await cmd('Page.enable'); await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url: SITE + '/?agent=1' }); await sleep(9000);
check('the live game opens in chain mode', await js(`window.cnc?.state().mode === 'chain'`), await js('JSON.stringify(window.cnc?.state())'));
check('it offers SIGN UP / SIGN IN', /SIGN|PLAY|CONTINUE/i.test(String(await js('document.body.innerText'))), String(await js('document.body.innerText')).slice(0, 80).replace(/\s+/g, ' '));
fs.writeFileSync(path.join(OUT, 'prod-title.png'), Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
await cmd('Page.navigate', { url: SITE + '/?demo=1&agent=1&play=missions' }); await sleep(8000);
check('the demo opens the Quest Board with the realm banners', await js(`[...document.querySelectorAll('.qp-banner img')].some(i => i.naturalWidth > 0)`));
fs.writeFileSync(path.join(OUT, 'prod-book.png'), Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
check('no errors in the page', errs.length === 0, errs.slice(0, 3));
chrome.kill(); console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED'); process.exit(failed ? 1 : 0);
