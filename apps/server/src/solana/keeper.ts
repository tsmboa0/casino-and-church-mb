import { addr, buildTx, compileMessage, decodeBank, decodeHouse, decodePlayer, decodePurse, ix, P, REALM, type Ix, type Rpc, type Signer } from '@cnc/realm';

import type { MarketKeeper } from './market.ts';

export interface Books { ok: boolean; at: number; problems: string[] }
/**
 * Tidies up after everyone. It holds no authority over money: every instruction here may be called by anyone, and pays
 * only where the program says. If it stops, players' own actions do the same work.
 */
export class Keeper {
  status = { running: false, at: 0, synced: 0, paid: 0, redelegated: 0, refunded: 0, stood: 0, errors: 0, lastError: null as string | null };
  books: Books = { ok: true, at: 0, problems: [] };
  private timer: NodeJS.Timeout | null = null; private round = 0;
  constructor(private l1: Rpc, private er: Rpc, private key: Signer, private sponsor: Signer, private wallets: () => Promise<string[]>, private everyMs = 20_000, private market: MarketKeeper | null = null) {}
  start() { this.status.running = true; const go = async () => { await this.tick(); if (this.status.running) this.timer = setTimeout(go, this.everyMs); }; this.timer = setTimeout(go, 2_000); }
  stop() { this.status.running = false; if (this.timer) clearTimeout(this.timer); }
  private async send(rpc: Rpc, ixs: Ix[], signer: Signer) { return rpc.send(buildTx(compileMessage(signer.address, ixs, await rpc.blockhash()), [signer])); }
  private async many(rpc: Rpc, keys: string[]) {
    const out: ({ data: Uint8Array; owner: string } | null)[] = [];
    for (let i = 0; i < keys.length; i += 100) { const r = await rpc.call('getMultipleAccounts', [keys.slice(i, i + 100), { encoding: 'base64', commitment: 'confirmed' }]); for (const v of r.value) out.push(v ? { data: Uint8Array.from(Buffer.from(v.data[0], 'base64')), owner: v.owner } : null); }
    return out;
  }
  async tick() {
    const fail = (e: unknown) => { this.status.errors++; this.status.lastError = String((e as Error)?.message ?? e).slice(0, 160); };
    try {
      const ws = await this.wallets();
      const [purses, l1p, erp] = await Promise.all([this.many(this.l1, ws.map(addr.purse)), this.many(this.l1, ws.map(addr.player)), this.many(this.er, ws.map(addr.player))]);
      for (let i = 0; i < ws.length; i++) {
        const pu = purses[i] && decodePurse(purses[i]!.data), base = l1p[i] && decodePlayer(l1p[i]!.data), live = erp[i] && decodePlayer(erp[i]!.data); if (!pu || !base) continue;
        try {
          if (l1p[i]!.owner === REALM) { await this.send(this.l1, [ix.delegatePlayer(this.sponsor.address, ws[i])], this.sponsor); this.status.redelegated++; }   // rotated off at the commit cap
          else if (live && live.credited < pu.deposited) { await this.send(this.er, [ix.syncDeposit(ws[i])], this.key); this.status.synced++; }
          if (live?.pending && Date.now() / 1000 > live.pending.placedTs + 185) { await this.send(this.er, [ix.refundStale(ws[i])], this.key); this.status.refunded++; }   // the oracle never answered
          if (live && this.market) await this.market.sweep(ws[i], live);
          const hand = live?.hand, idle = hand && !hand.over ? Date.now() / 1000 - hand.lastTs : 0;
          if (hand && hand.awaiting && idle > 185) { await this.send(this.er, [ix.refundStale(ws[i])], this.key); this.status.refunded++; }
          else if (hand && !hand.over && !hand.awaiting && idle > 125) { await this.send(this.er, [ix.bjStandIdle(ws[i], this.key.address)], this.key); this.status.stood++; }   // walked away from the table
          if (base.withdrawn > pu.paidOut) { await this.send(this.l1, [ix.settlePayout(ws[i])], this.key); this.status.paid++; }
        } catch (e) { fail(e); }
      }
      if (this.round++ % 15 === 0) await this.check();
    } catch (e) { fail(e); }
    this.status.at = Date.now();
  }
  /** I1 to I3 (MAGICBLOCK_PLAN 6.8) */
  async check() {
    const [h0, b0] = await Promise.all([this.er.account(addr.house()), this.l1.account(addr.bank())]); const h = h0 && decodeHouse(h0.data), b = b0 && decodeBank(b0.data); if (!h || !b || !b0) return;
    const owed = h.chipsOutstanding + h.vault + h.treasury + h.jackpot + h.machineTotal + h.escrowTotal, bad: string[] = [];
    if (owed !== h.totalCredited - h.totalWithdrawn) bad.push(`I1 owed ${owed} but books say ${h.totalCredited - h.totalWithdrawn}`);
    if (BigInt(b0.lamports) < b.totalDeposited - b.totalPaid) bad.push(`I2 bank ${b0.lamports} below ${b.totalDeposited - b.totalPaid}`);
    if (h.totalCredited > b.totalDeposited) bad.push('I3 credited ahead of deposits');
    this.books = { ok: !bad.length, at: Date.now(), problems: bad }; if (bad.length) console.error(JSON.stringify({ at: 'books', bad }));
  }
}
void P;
