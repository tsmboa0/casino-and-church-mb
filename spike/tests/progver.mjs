import { L1, ER, PROGRAM, PK, key } from './lib.mjs'; import crypto from 'node:crypto'; import fs from 'node:fs';
const pd = PK('FiCBW51rQvvDvzDHwaz8UkC5PP8ZtGqhzBwkCFtKQ6Ym'); const h = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);
const so = fs.readFileSync('target/deploy/spike.so'); console.log('local', so.length, h(so));
const l = (await L1.getAccountInfo(pd)).data; console.log('L1 slot', l.readBigUInt64LE(4), 'code', h(l.subarray(45, 45 + so.length)));
for (const k of [pd, PROGRAM]) { const a = await ER.getAccountInfo(k); console.log('ER', k.toBase58().slice(0, 6), a ? `owner ${a.owner.toBase58().slice(0, 14)} len ${a.data.length} exec ${a.executable}` : 'none'); if (a && a.data.length > 600000) for (const off of [0, 45, 48]) console.log('  off', off, h(a.data.subarray(off, off + so.length)), 'old-size', h(a.data.subarray(off, off + 608624))); }
