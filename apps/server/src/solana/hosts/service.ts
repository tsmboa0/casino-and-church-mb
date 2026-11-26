import type { HostId } from '@cnc/shared';
import { HOST_REFUSAL, faqAnswer, onTopic } from '@cnc/shared';
import { addr, CHIP, decodeHouse, type Rpc, type Signer } from '@cnc/realm';
import { NearAI, TokenBudget } from '../../agent/nearai.ts';
import { checkProof } from '../../agent/verify.ts';
import { HttpError } from '../sponsor.ts';
import type { AttestRow, DecisionRow, SolStore } from '../store.ts';
import { Host } from './host.ts';
import { forModel, observe, players, presence } from './observe.ts';
import { chatSystem } from './persona.ts';
import { lineProblem, parseReply } from './policy.ts';

export interface HostsConfig { nearaiKey: string; nearaiBase: string; nearaiModel: string; nearaiDailyTokens: number; chatShare: number; everyMin: number; askPerWalletHour: number; askPerIpHour: number; disabled: boolean }
export interface ProofDTO { model: string; chatId: string; signedText: string; signature: string; signingAddress: string; signatureKind: 'provider_tee' | 'gateway'; requestB64: string; responseB64: string; attestedSigner: string; attestationAt: number; txHash?: string; anchorTx?: string }
export interface DecisionDTO { id: string; agent: HostId; at: number; action: string; params: Record<string, number | string>; line: string; applied: boolean; reason?: string; txHash?: string; anchorTx?: string; policy: 'llm' | 'rules'; proof?: ProofDTO }
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

/** what the hosts hear of the church between their decisions (from the indexer's events) */
export class Church { private marks: { at: number; kind: 'tithe' | 'candle'; chips: number }[] = [];
  add(kind: 'tithe' | 'candle', chips = 0, at = Date.now()) { this.marks.push({ at, kind, chips }); if (this.marks.length > 20_000) this.marks = this.marks.slice(-10_000); }
  since(t: number) { const m = this.marks.filter((x) => x.at >= t); return { tithes: m.filter((x) => x.kind === 'tithe').reduce((n, x) => n + x.chips, 0), candles: m.filter((x) => x.kind === 'candle').length }; } }

/**
 * Don Fortuna and Father Nakamoto: a decision every `everyMin` minutes each (the Father five minutes after the Don), plus
 * extra cycles when something happens on the floor; a talk endpoint with no tools at all.
 */
export class Hosts {
  readonly ai: NearAI | null; readonly budget: TokenBudget; readonly hosts: Record<HostId, Host>; readonly church = new Church();
  private timers: NodeJS.Timeout[] = []; private next: Record<HostId, number> = { fortuna: 0, nakamoto: 0 }; private attesting: Promise<AttestRow | null> | null = null;
  private samples: { at: number; vault: number; treasury: number }[] = []; private fired = new Map<string, number>(); private chatCache = new Map<HostId, { at: number; body: unknown }>(); private presenceLog: { at: number; casino: number; church: number }[] = [];
  running = false;
  constructor(private c: HostsConfig, private l1: Rpc, private er: Rpc, private store: SolStore, keys: Record<HostId, Signer | null>, private onPublish: (d: DecisionDTO, eventsChanged: boolean) => void = () => {}) {
    this.ai = c.nearaiKey ? new NearAI(c.nearaiBase, c.nearaiKey, c.nearaiModel) : null; this.budget = new TokenBudget(c.nearaiDailyTokens, c.chatShare);
    const deps = (key: Signer | null) => ({ l1, er, store, ai: this.ai, budget: this.budget, key, church: () => this.church.since(Date.now() - DAY), attestation: () => this.attestation(), publish: (row: DecisionRow, ev: boolean) => void this.toDTO(row).then((d) => this.onPublish(d, ev)) });
    this.hosts = { fortuna: new Host('fortuna', deps(keys.fortuna)), nakamoto: new Host('nakamoto', deps(keys.nakamoto)) };
  }
  start() {
    if (this.running || this.c.disabled) return; this.running = true; const now = Date.now();
    this.next = { fortuna: now + 30_000, nakamoto: now + 30_000 + Math.min(5, this.c.everyMin / 2) * MIN };
    this.timers.push(setInterval(() => void this.tick(), 20_000)); void this.attestation();
  }
  stop() { this.running = false; this.timers.forEach(clearInterval); this.timers = []; }
  private async tick() {
    const now = Date.now();
    for (const a of ['fortuna', 'nakamoto'] as HostId[]) if (now >= this.next[a]) { this.next[a] = now + Math.max(1, this.c.everyMin) * MIN + Math.round((Math.random() * 2 - 1) * MIN); void this.hosts[a].cycle('schedule'); }
    try { await this.triggers(now); } catch { /* observation only */ }
  }
  /** extra cycles when something happens on the floor, at most every 3 minutes per host and once per half hour per reason */
  private async triggers(now: number) {
    const h = decodeHouse((await this.er.account(addr.house()))!.data)!, vault = Number(h.vault / CHIP), treasury = Number(h.treasury / CHIP);
    this.samples.push({ at: now, vault, treasury }); this.samples = this.samples.filter((s) => s.at >= now - DAY);
    const p = presence(await players(this.er, await this.store.wallets()), now); this.presenceLog.push({ at: now, casino: p.casino, church: p.church }); this.presenceLog = this.presenceLog.filter((x) => x.at >= now - HOUR);
    const held = (a: 'casino' | 'church') => { const rows = this.presenceLog.filter((r) => r.at >= now - 15 * MIN), b = a === 'casino' ? 'church' : 'casino'; return rows.length >= 30 && rows.every((r) => r[a] > 0 && r[a] > 2 * r[b]); };
    const fire = (a: HostId, why: string) => { const k = `${a}:${why}`; if (now - this.hosts[a].lastCycleAt < 3 * MIN || now - (this.fired.get(k) ?? 0) < 30 * MIN) return; this.fired.set(k, now); void this.hosts[a].cycle(why); };
    const hourAgo = this.samples.find((s) => s.at >= now - HOUR), dayAgo = this.samples[0];
    const win = await this.store.betStats(now - 20_000); if (win.biggest && win.biggest.payout >= 500) fire('fortuna', 'a single win of 500+ chips');
    if (hourAgo && hourAgo.vault > 0 && vault < hourAgo.vault * 0.9) fire('fortuna', 'the vault fell 10% in an hour');
    if (held('church')) fire('fortuna', 'the church has held 2x the casino for 15 minutes');
    if (dayAgo && dayAgo.treasury > 0 && treasury > dayAgo.treasury * 1.2 && now - dayAgo.at > 6 * HOUR) fire('nakamoto', 'the treasury grew 20% today');
    if (p.church > 0 && this.church.since(now - HOUR).candles === 0 && now - this.hosts.nakamoto.lastCycleAt > HOUR) fire('nakamoto', 'no candles lit in the last hour');
    if (held('casino')) fire('nakamoto', 'the casino has held 2x the church for 15 minutes');
  }
  /** the attested enclave key, refreshed hourly with our own nonce */
  async attestation(): Promise<AttestRow | null> {
    if (!this.ai) return null; const last = await this.store.latestAttestation(this.ai.model); if (last && Date.now() - last.at < HOUR) return last;
    this.attesting ??= this.ai.attest().then(({ report: _r, ...a }) => this.store.addAttestation(a)).catch((e) => { console.error(JSON.stringify({ at: 'attest', error: String(e?.message ?? e) })); return last; }).finally(() => { this.attesting = null; });
    return this.attesting;
  }
  async toDTO(row: DecisionRow): Promise<DecisionDTO> {
    const { player: _private, ...params } = row.params;
    const dto: DecisionDTO = { id: row.id, agent: row.agent, at: row.at, action: row.action, params, line: row.line, applied: row.applied, policy: row.policy, ...(row.reason ? { reason: row.reason } : {}), ...(row.actTx ? { txHash: row.actTx } : {}), ...(row.anchorTx ? { anchorTx: row.anchorTx } : {}) };
    if (row.policy === 'llm' && row.signature && row.signedText && row.requestB64 && row.responseB64 && row.signingAddress) {
      const att = row.attestationId ? await this.store.attestation(row.attestationId) : null;
      dto.proof = { model: row.model ?? '', chatId: row.chatId ?? '', signedText: row.signedText, signature: row.signature, signingAddress: row.signingAddress, signatureKind: row.signatureKind === 'gateway' ? 'gateway' : 'provider_tee', requestB64: row.requestB64, responseB64: row.responseB64, attestedSigner: att?.signingAddress ?? '', attestationAt: att?.at ?? 0, ...(row.actTx && row.applied ? { txHash: row.actTx } : {}), ...(row.anchorTx ? { anchorTx: row.anchorTx } : {}) };
    }
    return dto;
  }
  async feed(agent: HostId | 'all', limit: number) { return Promise.all((await this.store.decisions(agent, Math.min(40, Math.max(1, limit)))).map((r) => this.toDTO(r))); }
  async proof(id: string) { const r = await this.store.decision(id); return r ? this.toDTO(r) : null; }
  /** the true state, for the chat persona */
  private async chatState(agent: HostId) {
    const hit = this.chatCache.get(agent); if (hit && Date.now() - hit.at < MIN) return hit.body;
    const snap = this.hosts[agent].lastSnapshot && Date.now() - this.hosts[agent].lastSnapshot!.at < 15 * MIN ? this.hosts[agent].lastSnapshot! : await observe({ er: this.er, store: this.store, church: () => this.church.since(Date.now() - DAY) }, agent);
    const m = forModel(snap, agent) as Record<string, unknown>; delete m.eligible_for_alms; const body = { ...m, your_last_3: snap.your_last_3 }; this.chatCache.set(agent, { at: Date.now(), body }); return body;
  }
  /** talking to a host: a persona with no tools, so it can never act; off-topic questions get a refusal in character */
  async ask(agent: HostId, question: string, who: string, ip: string) {
    const q = String(question ?? '').replace(/\s+/g, ' ').trim().slice(0, 200); if (!q) throw new HttpError(400, 'bad_args', 'Ask a question.');
    const hourAgo = Date.now() - HOUR;
    if (await this.store.hits('ask', who, hourAgo) >= this.c.askPerWalletHour || await this.store.hits('ask-ip', ip, hourAgo) >= this.c.askPerIpHour) throw new HttpError(429, 'rate_limited', agent === 'fortuna' ? 'Enough questions for now, friend. Come back in an hour.' : 'Rest a while, child. Ask me again within the hour.');
    await this.store.hit('ask', who); await this.store.hit('ask-ip', ip);
    const refuse = () => ({ answer: HOST_REFUSAL[agent], relevant: false }), faq = () => { const hit = faqAnswer(agent, q); return hit ? { answer: hit, relevant: true } : refuse(); };
    if (/<[a-z/!]|https?:|www\./i.test(q) || !onTopic(q)) return refuse();
    const ai = this.ai; if (!ai?.enabled || !this.budget.canSpend('chat')) return faq();
    let cap; try { cap = await ai.chat([{ role: 'system', content: chatSystem(agent) }, { role: 'user', content: JSON.stringify({ state: await this.chatState(agent).catch(() => ({})), question: q }) }], { maxTokens: 220, temperature: 0.5, timeoutMs: 15_000 }); } catch { return faq(); }
    this.budget.spend('chat', cap.tokens || 400);
    const reply = parseReply(cap.content) as { relevant?: unknown; answer?: unknown } | null;
    if (!reply || typeof reply.answer !== 'string' || typeof reply.relevant !== 'boolean') return faq(); if (!reply.relevant) return refuse(); if (lineProblem(reply.answer, 280)) return faq();
    const out: { answer: string; relevant: boolean; proof?: ProofDTO } = { answer: reply.answer.trim(), relevant: true };
    const [sig, att] = await Promise.all([ai.signature(cap.chatId, 3_000), this.attestation()]);      // a signed answer is a bonus: never hold the reply long for it
    if (sig && att && checkProof({ model: ai.model, request: cap.request, response: cap.response, signature: sig, attestedSigner: att.signingAddress }).ok) out.proof = { model: ai.model, chatId: cap.chatId, signedText: sig.text, signature: sig.signature, signingAddress: sig.signing_address, signatureKind: sig.signature_kind === 'gateway' ? 'gateway' : 'provider_tee', requestB64: cap.request.toString('base64'), responseB64: cap.response.toString('base64'), attestedSigner: att.signingAddress, attestationAt: att.at };
    return out;
  }
  status() { return { running: this.running, model: this.ai?.model ?? null, tokens: this.budget.snapshot, fortuna: { last: this.hosts.fortuna.lastCycleAt, next: this.next.fortuna, error: this.hosts.fortuna.lastError }, nakamoto: { last: this.hosts.nakamoto.lastCycleAt, next: this.next.nakamoto, error: this.hosts.nakamoto.lastError } }; }
}
