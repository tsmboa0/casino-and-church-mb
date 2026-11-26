import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { HostId } from '@cnc/shared';
import { buildTx, compileMessage, decisionHash, ix, type HostCallInput, type Ix, type Rpc, type Signer } from '@cnc/realm';
import type { NearAI, TokenBudget } from '../../agent/nearai.ts';
import { checkProof } from '../../agent/verify.ts';
import type { AttestRow, DecisionRow, SolStore } from '../store.ts';
import { forModel, observe, type ObserveDeps, type Snapshot } from './observe.ts';
import { decisionSystem, templateLine } from './persona.ts';
import { checkDecision, DECISION_LINE_MAX, lineProblem, parseReply, type Plan } from './policy.ts';
import { newRuleMemory, rulesDecide } from './rules.ts';

export interface HostDeps extends ObserveDeps {
  l1: Rpc; ai: NearAI | null; budget: TokenBudget;
  /** this host's key: it writes the decision on L1, then acts on the rollup. Null: observe only */
  key: Signer | null;
  attestation: () => Promise<AttestRow | null>;
  publish: (row: DecisionRow, eventsChanged: boolean) => void;
}
const AGENT: Record<HostId, number> = { fortuna: 0, nakamoto: 1 };
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest();
const unhex = (s: string, n: number) => { const b = Buffer.from(s.replace(/^0x/, ''), 'hex'); const o = new Uint8Array(n); o.set(b.subarray(0, n)); return o; };

/**
 * One host. A cycle: observe -> decide (NEAR AI, or the rule fallback) -> guardrails -> proof gate -> write on L1 -> act.
 * The program acts only on a decision written on L1 by this host's key, for exactly this action, once.
 */
export class Host {
  private memory = newRuleMemory(); private busy = false;
  lastCycleAt = 0; lastSnapshot: Snapshot | null = null; lastError: string | null = null;
  constructor(readonly agent: HostId, private d: HostDeps) {}

  async cycle(trigger: string): Promise<DecisionRow | null> {
    if (this.busy) return null; this.busy = true; this.lastCycleAt = Date.now();
    try {
      const snap = await observe(this.d, this.agent); this.lastSnapshot = snap;
      const row = await this.decide(snap, trigger);
      await this.d.store.addDecision(row); this.d.publish(row, row.applied && /^(start|end)_/.test(row.action)); this.lastError = null;
      console.log(JSON.stringify({ at: 'host', agent: this.agent, trigger, policy: row.policy, action: row.action, applied: row.applied, reason: row.reason, tx: row.actTx }));
      return row;
    } catch (err) { this.lastError = err instanceof Error ? err.message : String(err); console.error(JSON.stringify({ at: 'host', agent: this.agent, error: this.lastError })); return null; }
    finally { this.busy = false; }
  }
  private base(snap: Snapshot, policy: 'llm' | 'rules'): DecisionRow {
    const { alias_to_account: _hidden, ...observation } = snap;
    return { id: randomUUID(), agent: this.agent, at: Date.now(), policy, observation, action: 'none', params: {}, line: '', applied: false, reason: null, anchorTx: null, actTx: null, model: null, chatId: null, requestB64: null, responseB64: null, signedText: null, signature: null, signingAddress: null, signatureKind: null, attestationId: null, tokens: 0 };
  }
  private async decide(snap: Snapshot, trigger: string): Promise<DecisionRow> {
    const { ai, budget } = this.d;
    if (ai?.enabled && budget.canSpend('decide')) {
      try { return await this.withModel(snap, trigger); }
      catch (err) { const row = await this.withRules(snap); row.reason = `model unavailable (${err instanceof Error ? err.message.slice(0, 80) : 'error'}); rule fallback`; return row; }
    }
    const row = await this.withRules(snap); row.reason ??= ai?.enabled ? 'daily token budget reached; rule fallback' : 'model disabled; rule fallback'; return row;
  }
  private async withRules(snap: Snapshot): Promise<DecisionRow> {
    const row = this.base(snap, 'rules'), plan = rulesDecide(this.agent, snap, this.memory);
    this.fill(row, plan, snap); if (!plan.call) { row.applied = true; return row; }
    return this.act(row, plan, null);
  }
  private async withModel(snap: Snapshot, trigger: string): Promise<DecisionRow> {
    const ai = this.d.ai!, row = this.base(snap, 'llm');
    const cap = await ai.chat([{ role: 'system', content: decisionSystem(this.agent) }, { role: 'user', content: JSON.stringify({ trigger, ...forModel(snap, this.agent) }) }], { maxTokens: 200, temperature: 0.3 });
    this.d.budget.spend('decide', cap.tokens || 400);
    Object.assign(row, { model: ai.model, chatId: cap.chatId, requestB64: cap.request.toString('base64'), responseB64: cap.response.toString('base64'), tokens: cap.tokens });
    const raw = parseReply(cap.content), checked = checkDecision(this.agent, raw, snap);
    // the proof gate: the enclave's signature over our exact bytes, from the attested key
    const [sig, att] = await Promise.all([ai.signature(cap.chatId, 10_000), this.d.attestation()]);
    if (sig) Object.assign(row, { signedText: sig.text, signature: sig.signature, signingAddress: sig.signing_address, signatureKind: sig.signature_kind ?? 'provider_tee' });
    row.attestationId = att?.id ?? null;
    const proof = sig ? checkProof({ model: ai.model, request: cap.request, response: cap.response, signature: sig, attestedSigner: att?.signingAddress ?? null }) : null;
    if (!checked.ok) { row.action = typeof raw?.action === 'string' ? raw.action.slice(0, 40) : 'invalid'; row.line = templateLine(this.agent, 'none', snap.at); row.reason = `guardrail: ${checked.reason}`; return row; }
    this.fill(row, checked.plan, snap);
    if (!sig) { row.reason = 'unsigned: no signature from the enclave within 10 s'; return row; }
    if (!proof!.ok) { row.reason = `proof failed: ${proof!.reasons.join('; ')}`; return row; }
    return this.act(row, checked.plan, { request: cap.request, response: cap.response });
  }
  private fill(row: DecisionRow, plan: Plan, snap: Snapshot) {
    row.action = plan.action; row.params = { ...plan.params };
    if (plan.action === 'grant_alms') { row.params = { chips: plan.params.chips! }; row.params.player = plan.player ?? ''; }      // stored, never sent to clients
    row.line = lineProblem(plan.line, DECISION_LINE_MAX) ? templateLine(this.agent, plan.action, snap.at) : plan.line;
  }
  private async send(rpc: Rpc, ixs: Ix[]) { const k = this.d.key!; return rpc.send(buildTx(compileMessage(k.address, ixs, await rpc.blockhash()), [k])); }
  /** write it on L1 with its proof, then act on the rollup (which sees L1 within a second or two) */
  private async act(row: DecisionRow, plan: Plan, bytes: { request: Buffer; response: Buffer } | null): Promise<DecisionRow> {
    if (!this.d.key) { row.reason ??= 'no signing key for this host on the server'; return row; }
    const agent = AGENT[this.agent], call: HostCallInput = plan.call ?? { do: 'none' }, id = randomBytes(16);
    const requestSha = bytes ? sha(bytes.request) : new Uint8Array(32), responseSha = bytes ? sha(bytes.response) : new Uint8Array(32);
    const hash = decisionHash(id, agent, responseSha, call);
    try {
      row.anchorTx = await this.send(this.d.l1, [ix.anchorDecision(this.d.key.address, agent, hash, {
        id, policy: bytes ? 0 : 1, action: plan.action.slice(0, 24), model: row.model ?? '', signedText: row.signedText ?? '', signature: row.signature ? unhex(row.signature, 65) : new Uint8Array(65),
        signingAddress: row.signingAddress ? unhex(row.signingAddress, 20) : new Uint8Array(20), requestSha256: requestSha, responseSha256: responseSha,
      })]);
    } catch (err) { row.reason = `could not write it on L1: ${(err as Error).message.slice(0, 100)}`; return row; }
    for (let i = 0; ; i++) {
      try { row.actTx = await this.send(this.d.er, [ix.hostAct(this.d.key.address, agent, id, responseSha, call, plan.player)]); row.applied = true; return row; }
      catch (err) { const code = (err as { code?: string }).code; if (code === 'NotAllowed' && i < 40) { await new Promise((r) => setTimeout(r, 500)); continue; } row.reason = `the program refused: ${code ?? (err as Error).message.slice(0, 80)}`; return row; }
    }
  }
}
