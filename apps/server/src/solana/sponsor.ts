import { createHash } from 'node:crypto';
import { addr, addSignatures, buildTx, compileMessage, decodePlayer, fullySigned, ix, P, parseTx, REALM, type Ix, type Rpc, type Signer } from '@cnc/realm';

export class HttpError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
type Kind = 'setup' | 'session' | 'buy';
interface Issued { kind: Kind; did: string; wallet: string; until: number }
const hash = (m: Uint8Array) => createHash('sha256').update(m).digest('hex');
const ALLOWED = new Set<string>([REALM, P.session, P.system]);

/**
 * Pays rent and fees for players. It spends our SOL, so:
 *  - it builds every transaction itself and never signs bytes a client made up;
 *  - it signs only when the finished transaction comes back, byte-identical to what it issued and signed by everyone else.
 */
export class Sponsor {
  private issued = new Map<string, Issued>();
  constructor(private l1: Rpc, public key: Signer, private ttlMs = 90_000) {}
  private async issue(kind: Kind, did: string, wallet: string, ixs: Ix[]): Promise<Uint8Array> {
    const message = compileMessage(this.key.address, ixs, await this.l1.blockhash());
    const now = Date.now(); for (const [k, v] of this.issued) if (v.until < now) this.issued.delete(k);
    this.issued.set(hash(message), { kind, did, wallet, until: now + this.ttlMs });
    return buildTx(message, []);                                      // nobody has signed yet, us included
  }
  /** what this wallet still needs: the account, the delegation, the session (always) */
  async prepareSetup(did: string, wallet: string, session: string, days: number): Promise<{ tx: Uint8Array; kind: Kind }> {
    const [purse, player] = await Promise.all([this.l1.account(addr.purse(wallet)), this.l1.account(addr.player(wallet))]);
    const ixs: Ix[] = []; let kind: Kind = 'session';
    if (!purse || !player) { ixs.push(ix.openAccount(this.key.address, wallet), ix.delegatePlayer(this.key.address, wallet)); kind = 'setup'; }
    else if (player.owner === REALM) { if (!decodePlayer(player.data)) throw new HttpError(409, 'bad_account', 'This account cannot be opened. Tell us about it.'); ixs.push(ix.delegatePlayer(this.key.address, wallet)); }
    ixs.push(ix.createSession(wallet, session, this.key.address, Math.floor(Date.now() / 1000) + days * 86_400));
    return { tx: await this.issue(kind, did, wallet, ixs), kind };
  }
  prepareBuy(did: string, wallet: string, lamports: bigint) { return this.issue('buy', did, wallet, [ix.buyChips(wallet, lamports)]); }
  /** the finished transaction comes back; returns what it was and its signature */
  async submit(did: string, wire: Uint8Array): Promise<{ kind: Kind; wallet: string; signature: string }> {
    let p; try { p = parseTx(wire); } catch { throw new HttpError(400, 'bad_tx', 'That is not a transaction we know.'); }
    const id = hash(p.message), was = this.issued.get(id);
    if (!was || was.until < Date.now()) throw new HttpError(400, 'expired', 'That took too long. Try again.');
    if (was.did !== did) throw new HttpError(403, 'not_allowed', 'That transaction was made for someone else.');
    if (p.keys[0] !== this.key.address || !p.programs.every((x) => ALLOWED.has(x))) throw new HttpError(400, 'bad_tx', 'That is not a transaction we know.');
    const done = addSignatures(wire, [this.key]);
    if (!fullySigned(done)) throw new HttpError(400, 'unsigned', 'A signature is missing. Try again.');
    this.issued.delete(id);                                            // one use
    return { kind: was.kind, wallet: was.wallet, signature: await this.l1.send(done) };
  }
  async send(ixs: Ix[]): Promise<string> { return this.l1.send(buildTx(compileMessage(this.key.address, ixs, await this.l1.blockhash()), [this.key])); }
}
