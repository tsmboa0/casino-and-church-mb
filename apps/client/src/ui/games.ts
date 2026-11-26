import './games.css';
import { store, clearProfile } from '../core/state';
import { bus, type PanelKind } from '../core/bus';
import { audio } from '../core/audio';
import { type BetProof, type WheelResult,
  backend, BackendError, type BjState, type AgentDecision, type AgentId, type AgentProof, type CampaignRow, type RealmEvent,
  type MarketState, type MarketSide, type MarketResult, type MarketCrowdBet,
} from '../core/backend';
import { CAMPAIGN_LIMITS, campaignCost, campaignProblem, type NewCampaign, CAMPAIGN_MIN_BUDGET, detailsProblem, DETAIL_LIMITS, type CampaignDetails } from '@cnc/shared';
import { verifyProof, SAMPLE_PROOF } from './aiverify';
import { spriteCss, showBackstory } from './onboarding';
import {
  SLOT_SYMS, SLOT_TRIPLE, COIN_PAY_BPS, DICE_OU_BPS, DICE_SEVEN_BPS, ROULETTE_PICK, RED, QUESTS, PARAMS,
  CHIPS_PER_SOL, PLOT_GATE, plotPlayableBankroll, MACHINE_SKINS, blessingOf,
  TABLE, tableBet,
} from '../core/rules';
import { icon } from './icons';
import { vib } from './controls';
import { howToHtml, playHowTo } from './howto';

/**
 * Game panels designed as physical casino / church furniture.
 * ALL state changes go through `backend` (core/backend.ts). Panels only animate and present what it returns.
 */
type Root = HTMLElement;
const $ = <T extends HTMLElement = HTMLElement>(r: ParentNode, s: string) => r.querySelector(s) as T;
const $$ = (r: ParentNode, s: string) => Array.from(r.querySelectorAll<HTMLElement>(s));
/** chips: whole, or one decimal (1.94x of 10 is 19.4). Balances round down, so the screen never shows more than there is */
const fmt = (n: number) => (Math.floor(n * 10 + 1e-6) / 10).toLocaleString();
/** what a bet may use: bonus chips go first, then real ones */
const spendable = () => store.eco.chips + store.eco.bonus;
const bonusHtml = () => `<em id="bonus" ${store.eco.bonus > 0 ? '' : 'hidden'}>+${fmt(store.eco.bonus)} BONUS</em>`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rndOf = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
/** a short, tappable link to a transaction on Solana Explorer */
const txLink = (hash?: string | null, label?: string) => hash
  ? `<a class="txl" href="${backend.txUrl?.(hash) ?? '#'}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${label ?? `${hash.slice(0, 4)}&hellip;${hash.slice(-3)}`} &#8599;</a>` : '';
const mod360 = (x: number) => ((x % 360) + 360) % 360;
/** the button turns into a spinner (same size) while the chain works; nothing else on the panel can double-fire it */
async function pending<T>(btn: Element | null, fn: () => Promise<T>): Promise<T> {
  const b = btn as HTMLButtonElement | null;
  b?.classList.add('pending'); b?.setAttribute('aria-busy', 'true'); if (b) b.disabled = true;
  try { return await fn(); } finally { b?.classList.remove('pending'); b?.removeAttribute('aria-busy'); if (b) b.disabled = false; }
}
/**
 * Starts turning the moment the player presses, keeps turning while the chain works, then eases onto the result.
 * Any number of axes (the dice tumble on two each); each ends on its own angle (mod 360). The cubic ease-out
 * starts at the current speed, so there is no jolt when the result arrives.
 */
function spinner(apply: (a: number[], phase: 'spin' | 'land', k: number) => void, speeds: number[], start: number[] = speeds.map(() => 0)) {
  const a = start.slice(); let raf = 0, last = performance.now(); const t0 = last;
  let landing: { t: number; ms: number; from: number[]; dist: number[]; res: () => void } | null = null;
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!landing) {
      const ramp = Math.min(1, (now - t0) / 350);
      speeds.forEach((sp, i) => { a[i] += sp * ramp * dt; });
      apply(a, 'spin', ramp);
    } else {
      const k = Math.min(1, (now - landing.t) / landing.ms), e = 1 - Math.pow(1 - k, 3);
      landing.dist.forEach((d, i) => { a[i] = landing!.from[i] + d * e; });
      apply(a, 'land', k);
      if (k >= 1) { const r = landing.res; landing = null; r(); return; }
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return {
    angles: a,
    land(targets: number[], ms: number) {
      return new Promise<void>((res) => {
        const from = a.slice();
        const dist = targets.map((tg, i) => {
          const dir = Math.sign(speeds[i]) || 1, want = (Math.abs(speeds[i]) * ms) / 3000;
          let d = dir > 0 ? mod360(tg - from[i]) : -mod360(from[i] - tg);
          while (Math.abs(d) < want - 180) d += dir * 360;
          return d;
        });
        landing = { t: performance.now(), ms, from, dist, res };
      });
    },
    stop() { cancelAnimationFrame(raf); },
  };
}
const errText = (e: unknown) => (e instanceof BackendError ? e.message : 'Something went wrong. Try again.');

// ---------------------------------------------------------------------------------------------- pixel art
const pix = (rows: string[], color: string) => {
  let r = ''; rows.forEach((row, y) => [...row].forEach((c, x) => { if (c === '#') r += `<rect x="${x}" y="${y}" width="1" height="1"/>`; }));
  return `<svg viewBox="0 0 ${rows[0].length} ${rows.length}" shape-rendering="crispEdges" fill="${color}">${r}</svg>`;
};
const COIN_H = `<img class="cimg" src="${import.meta.env.BASE_URL}assets/gen/coin_heads.png" alt="Heads">`;
const COIN_T = `<img class="cimg" src="${import.meta.env.BASE_URL}assets/gen/coin_tails.png" alt="Tails">`;
const CROWN = pix(['#...#...#', '##.###.##', '#########', '#########', '.#######.', '.#######.'], '#6b3a08');
const CROSS = pix(['..##..', '..##..', '######', '######', '..##..', '..##..', '..##..', '..##..'], '#6b3a08');
const X_SVG = `<svg viewBox="0 0 8 8" shape-rendering="crispEdges"><path d="M1 1h2v1h2V1h2v2H6v2h1v2H5V6H3v1H1V5h1V3H1z" fill="#fff4f4"/></svg>`;
const DIAMOND = `<svg class="ico" width="28" height="28" viewBox="0 0 10 9" shape-rendering="crispEdges"><path d="M3 0h4l3 3-5 6-5-6z" fill="#14101c"/><path d="M3 1h4l2 2-4 5-4-5z" fill="#4fc8ff"/><path d="M3 1h2v2H2zM5 3h1v4H5z" fill="#d8f6ff"/><path d="M7 1l2 2H7z" fill="#2a8ad0"/></svg>`;
const SYM: Record<string, string> = { seven: '<span class="s7">7</span>', diamond: DIAMOND, clover: icon('clover', 28), coin: icon('coin', 28), cross: icon('cross', 28) };

// ---------------------------------------------------------------------------------------------- shell + shared parts
function shell(root: Root, close: () => void, theme: 'casino' | 'church', title: string, body: string, tier = false) {
  root.innerHTML = `<div class="gm ${theme}" role="dialog" aria-modal="true" aria-label="${title.replace(/<[^>]+>/g, '').replace(/"/g, '')}">
    <div class="gm-top"><div class="gm-title"><i class="bulbs"></i><span>${title}</span><i class="bulbs"></i></div>
      ${tier ? '<div class="gm-tier" id="tier"></div>' : ''}
      <div class="g-lcd"><small>CREDITS</small><b id="bal">${fmt(store.eco.chips)}</b>${bonusHtml()}</div>
      <button class="gm-x" data-close aria-label="Close">${X_SVG}</button></div>
    <div class="gm-body">${body}</div>
    <div class="gm-res" id="res" role="status" aria-live="assertive" hidden></div></div>`;
  $(root, '[data-close]').addEventListener('click', close);
  refreshTier(root);
}
function refreshTier(root: Root) {
  const t = root.querySelector('#tier'); if (!t) return;
  const b = blessingOf(store.eco.faith); t.textContent = b.bps ? `${b.title.toUpperCase()} BLESSING +${(b.bps / 100).toFixed(1)}%` : 'NO BLESSING';
}
/** counts the credits read-out up/down to the store value */
function setBal(root: Root) {
  const el = root.querySelector('#bal') as HTMLElement | null; if (!el) return;
  const from = Number(el.textContent!.replace(/,/g, '')) || 0, to = store.eco.chips, t0 = performance.now();
  const step = () => { const k = Math.min(1, (performance.now() - t0) / 500); el.textContent = fmt(k < 1 ? Math.floor(from + (to - from) * k) : to); if (k < 1) requestAnimationFrame(step); };
  step(); refreshTier(root); const bo = root.querySelector<HTMLElement>('#bonus'); if (bo) { bo.hidden = !(store.eco.bonus > 0); bo.textContent = `+${fmt(store.eco.bonus)} BONUS`; }
}
const chipRow = (cur: number, vals: readonly number[] = TABLE.bets, id = 'chips') => `<div class="g-chips" id="${id}">${vals.map(v => `<button class="g-chip v${v >= 100 ? 100 : v}" data-b="${v}" ${v === cur ? 'data-sel="1"' : ''}><span>${v >= 1000 ? `${v / 1000}K` : v}</span></button>`).join('')}</div>`;
function wireChips(root: Root, set: (v: number) => void, busy: () => boolean, id = 'chips') {
  const all = $$(root, `#${id} .g-chip`);
  const mark = (v: number) => all.forEach(c => c.classList.toggle('sel', +c.dataset.b! === v));
  all.forEach(c => { if (c.dataset.sel) c.classList.add('sel'); c.addEventListener('click', () => { if (busy()) return; set(+c.dataset.b!); mark(+c.dataset.b!); audio.play('hit', 0.25); vib(4); }); });
}
const chipColor = (v: number) => (v >= 100 ? '#1b1b24' : v >= 50 ? '#c4202e' : v >= 25 ? '#1f8a4c' : '#2f6fd0');
const token = (v: number) => `<span class="tok" style="--c:${chipColor(v)}"><b>${v}</b></span>`;

/** the big result moment: YOU WIN / YOU LOSE / BET RETURNED / JACKPOT */
function showResult(root: Root, kind: 'win' | 'lose' | 'push' | 'jackpot', title: string, amount: number | string, sub = '') {
  const r = $(root, '#res');
  r.className = `gm-res ${kind}`; r.hidden = false;
  const coins = kind === 'win' || kind === 'jackpot'
    ? '<div class="rs-rays"></div>' + Array.from({ length: kind === 'jackpot' ? 30 : 16 }, () => {
      const a = Math.random() * Math.PI * 2, d = 120 + Math.random() * 260;
      return `<i class="coin-p" style="--x:${(Math.cos(a) * d).toFixed(0)}px;--y:${(Math.sin(a) * d).toFixed(0)}px;--d:${(0.9 + Math.random() * 0.9).toFixed(2)}s"></i>`;
    }).join('') : '';
  r.innerHTML = `${coins}<div class="rs-t">${title}</div><div class="rs-a" id="rsa">${typeof amount === 'number' ? '' : amount}</div><div class="rs-s">${sub}</div><div class="rs-tap">TAP TO CONTINUE</div>`;
  if (typeof amount === 'number') {
    const el = $(r, '#rsa'), t0 = performance.now(), sign = kind === 'lose' ? '-' : '+';
    const step = () => { const k = Math.min(1, (performance.now() - t0) / 700); el.textContent = `${sign}${fmt(k < 1 ? Math.floor(Math.abs(amount) * (1 - Math.pow(1 - k, 3))) : Math.abs(amount))}`; if (k < 1) requestAnimationFrame(step); };
    step();
  }
  const church = !!root.querySelector('.gm.church');
  if (kind === 'win' || kind === 'jackpot') { audio.play(church ? 'blessed' : 'win', 0.7); vib(kind === 'jackpot' ? 60 : 25); }
  else if (kind === 'lose') { audio.play('lose', 0.5, 2.8); vib(8); }
  else vib(8);
  const hide = () => { r.hidden = true; r.innerHTML = ''; };
  r.onclick = hide;
  window.clearTimeout(Number(r.dataset.t)); r.dataset.t = String(window.setTimeout(hide, kind === 'lose' ? 3200 : kind === 'jackpot' ? 6000 : kind === 'push' ? 3900 : 4300));
}
const hideResult = (root: Root) => { const r = root.querySelector('#res') as HTMLElement | null; if (r) { r.hidden = true; r.innerHTML = ''; } };
/** errors where simply trying again can work (a dropped or refused transaction, a busy relayer); not "no chips" or "LUCK too low" */
const RETRYABLE = new Set(['bad_args', 'rate_limited', 'quota', 'vault_low']);
const oops = (root: Root, e: unknown) => {
  const msg = errText(e), code = e instanceof BackendError ? e.code : '';
  const again = (!code || RETRYABLE.has(code)) && !/try again|wait/i.test(msg);
  showResult(root, 'push', 'HOLD ON', '', again ? `${msg}<b class="rs-again">Please try again.</b>` : msg);
};
/**
 * Check the chips before anything moves: a bet the player cannot cover never starts the reels or the wheel, and
 * the message says where to get more. (The contract would refuse it anyway, but only after the animation ran.)
 */
function canCover(root: Root, chips: number, what: 'bet' | 'tithe' | 'spin' = 'bet'): boolean {
  if ((what === 'bet' ? spendable() : store.eco.chips) >= chips) return true;
  hideResult(root);
  showResult(root, 'push', 'NOT ENOUGH CHIPS', '', `This ${what} is ${fmt(chips)} chips and you have ${fmt(what === 'bet' ? spendable() : store.eco.chips)}${what !== 'bet' && store.eco.bonus ? ' (bonus chips are only for playing)' : ''}. Visit the Cashier by the casino door to buy more.`);
  audio.play('hit', 0.3);
  return false;
}
const proofLinks = (proof?: BetProof) => (proof ? `<br>${txLink(proof.placeTx, 'VIEW ON EXPLORER')}${backend.verifyBet ? '<a class="txl vfy" data-verify role="button" tabindex="0">VERIFY THIS BET</a>' : ''}` : '');
const wireVerify = (root: Root, proof?: BetProof) => { if (proof) root.querySelector<HTMLElement>('[data-verify]')?.addEventListener('click', (ev) => { ev.stopPropagation(); hideResult(root); void verifyBetView(root, proof); }); };
/** standard verdict from a bet result */
function verdict(root: Root, wager: number, payout: number, blessing: number, what: string, proof?: BetProof) {
  const link = proofLinks(proof);
  const sub = [what, blessing ? `Blessing +${blessing}` : ''].filter(Boolean).join(' · ') + link;
  if (payout <= 0) showResult(root, 'lose', 'YOU LOSE', wager, (what || 'Better luck next time') + link);
  else if (payout >= wager * 15) showResult(root, 'jackpot', 'JACKPOT!', payout, sub);
  else if (payout <= wager * 1.05) showResult(root, 'push', 'BET RETURNED', `+${fmt(payout)}`, sub);
  else showResult(root, 'win', 'YOU WIN!', payout, sub);
  wireVerify(root, proof);
}
/** checks one bet from the chain, in the browser, and says what it found */
async function verifyBetView(root: Root, proof: BetProof) {
  const gm = root.querySelector('.gm'); if (!gm || gm.querySelector('.fw')) return;
  const el = document.createElement('div'); el.className = 'fw vb'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Verify this bet');
  el.innerHTML = `<div class="fw-card"><h3>VERIFY BET #${proof.seq}</h3><p>Nobody at the house can see or choose this number. MagicBlock's oracle makes it and proves it on chain, and only that proof can settle your bet.</p><div class="vb-rows" id="vb" role="status">Reading the rollup...</div><div class="fw-row"><span id="vb-tx"></span><button class="g-key dark" data-f="done">DONE</button></div></div>`;
  gm.appendChild(el); el.addEventListener('click', (ev) => { ev.stopPropagation(); if (ev.target === el || (ev.target as HTMLElement).dataset.f === 'done') el.remove(); });
  const row = (ok: boolean | null, a: string, b: string) => `<div class="vb-row ${ok === null ? '' : ok ? 'ok' : 'bad'}"><i>${ok === null ? '&middot;' : ok ? '&#10003;' : '&#10007;'}</i><span>${a}</span><b>${b}</b></div>`;
  try {
    const c = await backend.verifyBet!(proof); if (!el.isConnected) return;
    const out = el.querySelector('#vb')!;
    if (!c.found) { out.innerHTML = row(null, 'The rollup has not listed this bet yet.', 'Try again in a moment'); return; }
    out.innerHTML = row(c.fromVrf, 'Settled by the VRF program', c.fromVrf ? 'YES' : 'NO') + row(null, (c.answers ?? 1) > 1 ? `Random numbers: ${c.answers}, the last` : 'Random number', `${c.randomness.slice(0, 10)}&hellip;${c.randomness.slice(-8)}`) + row(null, 'Worked out here', c.recomputed) + row(c.matches, 'Recorded on chain', c.recorded) + row(c.fromVrf && c.matches, c.fromVrf && c.matches ? 'This bet was fair' : 'This does not add up', '');
    if (c.tx) el.querySelector('#vb-tx')!.innerHTML = txLink(c.tx, 'THE PROOF TRANSACTION');
  } catch (e) { const out = el.querySelector('#vb'); if (out) out.textContent = errText(e); }
}

// ---------------------------------------------------------------------------------------------- SLOTS
function slots(root: Root, close: () => void, machine?: { plot: number; name: string }) {
  let bet = tableBet(10), busy = false;
  const own = machine ? backend.mode === 'chain' : false;
  const cur: string[][] = [0, 1, 2].map(() => [rndOf(SLOT_SYMS), rndOf(SLOT_SYMS), rndOf(SLOT_SYMS)]);
  const paySym = (s: string) => SYM[s].replace('width="28" height="28"', 'width="12" height="12"');
  shell(root, close, 'casino', machine ? esc(machine.name.toUpperCase()) : 'LUCKY SEVEN', `
  <div class="sl">
    <div class="sl-cab">
      <div class="sl-marq"><span class="nm">&#9733; SLOTS &#9733;</span><span class="jp"><small>JACKPOT</small><b id="jp">${fmt(store.stats.jackpot)}</b></span></div>
      <div class="sl-win">${[0, 1, 2].map(i => `<div class="sl-reel"><div class="sl-strip" id="s${i}"></div></div>`).join('')}<i class="sl-line" id="line"></i><i class="sl-arrow l"></i><i class="sl-arrow r"></i></div>
      <div class="sl-pay">${SLOT_SYMS.map(s => `<span>${paySym(s)}${paySym(s)}${paySym(s)}&nbsp;&times;${SLOT_TRIPLE[s]}</span>`).join('')}<span>ANY 2 IN A ROW &times;1</span></div>
    </div>
    <div class="sl-lever" id="lever"><div class="base"></div><div class="rod"><div class="knob"></div></div></div>
    <div class="sl-ctl">
      <div><div class="g-lab">BET PER SPIN</div>${chipRow(bet)}</div>
      <div class="g-lcd green"><small>LAST WIN</small><b id="lw">0</b></div>
      <button class="g-go" id="go"><span>SPIN</span></button>
    </div>
  </div>`, true);
  wireChips(root, v => (bet = v), () => busy);
  const strips = [0, 1, 2].map(i => $(root, `#s${i}`));
  const fill = (st: HTMLElement, syms: string[]) => { st.innerHTML = syms.map(s => `<div class="sl-cell">${SYM[s]}</div>`).join(''); };
  const cellH = () => (strips[0].firstElementChild as HTMLElement)?.getBoundingClientRect().height || 48;
  strips.forEach((st, i) => fill(st, cur[i]));
  const loop = (i: number) => {
    const N = 15, h = cellH(), syms = [...cur[i], ...Array.from({ length: N - 6 }, () => rndOf(SLOT_SYMS)), ...cur[i]];
    const st = strips[i]; fill(st, syms); st.style.transform = ''; st.style.setProperty('--from', `-${(N - 3) * h}px`);
    st.className = 'sl-strip loop'; st.style.animationDuration = `${0.28 + i * 0.03}s`;
  };
  const land = (i: number, fin: string[]) => {
    const M = 11, h = cellH(), st = strips[i];
    fill(st, [...fin, ...Array.from({ length: M - 6 }, () => rndOf(SLOT_SYMS)), ...cur[i]]);
    st.className = 'sl-strip'; st.style.transform = `translateY(-${(M - 3) * h}px)`; void st.offsetHeight;
    st.className = 'sl-strip stop'; st.style.transform = 'translateY(0)'; cur[i] = fin;
  };
  const go = $<HTMLButtonElement>(root, '#go'), lever = $(root, '#lever'), line = $(root, '#line');
  const spin = async () => {
    if (busy || !canCover(root, bet, own ? 'spin' : 'bet')) return; busy = true; go.disabled = true; hideResult(root);
    line.classList.remove('on'); $$(root, '.sl-cell.hit').forEach(c => c.classList.remove('hit'));
    lever.classList.add('pull'); setTimeout(() => lever.classList.remove('pull'), 380);
    const snd = audio.loop('slots', 0.45); vib(12);
    [0, 1, 2].forEach(loop);
    try {
      const [res] = await Promise.all([backend.placeBet({ game: 'slots', wager: bet, machineId: machine?.plot }), sleep(1100)]);
      snd(1.6);                                          // the result is in: the reels wind down with the sound
      for (let i = 0; i < 3; i++) { if (i) await sleep(340); land(i, [rndOf(SLOT_SYMS), res.outcome.reels![i], rndOf(SLOT_SYMS)]); vib(6); }
      await sleep(700); setBal(root); $(root, '#jp').textContent = fmt(store.stats.jackpot);
      $(root, '#lw').textContent = fmt(res.payout);
      if (res.payout > 0) { line.classList.add('on'); strips.forEach(st => st.children[1]?.classList.add('hit')); }
      verdict(root, bet, res.payout, res.blessing, res.payout > 0 || own ? '' : `LUCK +${res.luckGain.toFixed(1)}`, res.proof);
    } catch (e) { [0, 1, 2].forEach(i => land(i, cur[i])); oops(root, e); }
    finally { snd(); busy = false; go.disabled = false; }
  };
  go.addEventListener('click', spin); lever.addEventListener('click', spin);
}

// ---------------------------------------------------------------------------------------------- COIN FLIP
const coinHist: ('H' | 'T')[] = [];
function coinflip(root: Root, close: () => void) {
  let bet = tableBet(25), call = 0, busy = false, angle = 0;
  const pays = (COIN_PAY_BPS / 10000).toFixed(2);
  shell(root, close, 'casino', 'COIN FLIP', `
  <div class="cf">
    <div class="cf-stage felt"><div class="ring"></div>
      <div class="cf-coin" id="coin"><div class="f h">${COIN_H}</div><div class="f t">${COIN_T}</div></div><div class="cf-shadow"></div>
      <div class="lbl">CROWN = HEADS &nbsp;&middot;&nbsp; CROSS = TAILS</div></div>
    <div class="cf-ctl">
      <div><div class="g-lab">CALL IT</div>
        <div class="cf-calls"><button class="cf-call sel" data-c="0"><i class="img">${COIN_H}</i><b>HEADS</b><small>pays ${pays}&times;</small></button><button class="cf-call" data-c="1"><i class="img">${COIN_T}</i><b>TAILS</b><small>pays ${pays}&times;</small></button></div></div>
      <div><div class="g-lab">YOUR BET</div>${chipRow(bet)}</div>
      <div class="g-hist" id="hist"></div>
      <button class="g-go" id="go"><span>FLIP</span></button>
    </div>
  </div>`, true);
  wireChips(root, v => (bet = v), () => busy);
  $$(root, '.cf-call').forEach(c => c.addEventListener('click', () => { if (busy) return; call = +c.dataset.c!; $$(root, '.cf-call').forEach(x => x.classList.toggle('sel', x === c)); audio.play('hit', 0.25); }));
  const hist = () => { $(root, '#hist').innerHTML = coinHist.slice(0, 10).map(s => `<i class="${s === 'H' ? 'gold' : 'black'}">${s}</i>`).join(''); };
  hist();
  const go = $<HTMLButtonElement>(root, '#go'), coin = $(root, '#coin');
  go.addEventListener('click', async () => {
    if (busy || !canCover(root, bet)) return; busy = true; go.disabled = true; hideResult(root); vib(10); audio.play('hit', 0.4);
    // the coin goes up and keeps turning in the air until the chain says how it lands
    coin.className = 'cf-coin'; coin.style.animation = 'none';
    const LIFT = 150;
    const sp = spinner(([x], phase, k) => {
      const lift = phase === 'spin' ? LIFT * Math.sin((k * Math.PI) / 2) : LIFT * Math.cos((k * Math.PI) / 2);
      coin.style.transform = `translateZ(${lift.toFixed(1)}px) rotateX(${x.toFixed(1)}deg)`;
    }, [880], [angle]);
    try {
      const res = await backend.placeBet({ game: 'coinflip', wager: bet, pick: call });
      await sp.land([res.outcome.side === 'H' ? 0 : 180], 1300); angle = sp.angles[0]; audio.play('hit', 0.4);
      coinHist.unshift(res.outcome.side!); hist(); setBal(root);
      verdict(root, bet, res.payout, res.blessing, res.outcome.side === 'H' ? 'Crown. Heads.' : 'Cross. Tails.', res.proof);
    } catch (e) { await sp.land([mod360(angle)], 700); angle = sp.angles[0]; oops(root, e); }
    finally { busy = false; go.disabled = false; }
  });
}

// ---------------------------------------------------------------------------------------------- DICE
const PIPS: Record<number, number[]> = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const face = (v: number) => `<div class="fc f${v}">${Array.from({ length: 9 }, (_, i) => `<i class="${PIPS[v].includes(i) ? 'on' : ''}"></i>`).join('')}</div>`;
const SHOW: Record<number, [number, number]> = { 1: [0, 0], 6: [0, 180], 3: [0, -90], 4: [0, 90], 2: [-90, 0], 5: [90, 0] };
function dice(root: Root, close: () => void) {
  let bet = tableBet(25), call = 1, busy = false;
  const ou = (DICE_OU_BPS / 10000).toFixed(2), sv = (DICE_SEVEN_BPS / 10000).toFixed(1);
  shell(root, close, 'casino', 'DICE DEN', `
  <div class="dc">
    <div class="dc-stage felt"><div class="dc-dice"><div class="cube" id="d1">${[1, 2, 3, 4, 5, 6].map(face).join('')}</div><div class="cube" id="d2">${[1, 2, 3, 4, 5, 6].map(face).join('')}</div></div>
      <div class="dc-sum" id="sum">ROLL THE BONES</div></div>
    <div class="dc-ctl">
      <div><div class="g-lab">PLACE YOUR BET</div>
        <div class="dc-zones"><button class="dc-z" data-c="0"><b>UNDER 7</b><small>2 &ndash; 6</small><em>${ou}&times;</em></button><button class="dc-z seven sel" data-c="1"><b>LUCKY 7</b><small>exactly 7</small><em>${sv}&times;</em></button><button class="dc-z" data-c="2"><b>OVER 7</b><small>8 &ndash; 12</small><em>${ou}&times;</em></button><button class="dc-z field" data-c="3"><b>FIELD</b><small>2-4 &middot; 9-12</small><em>2&times; &middot; 12/2: 3&times;</em></button></div></div>
      <div><div class="g-lab">CHIP</div>${chipRow(bet)}</div>
      <button class="g-go" id="go"><span>ROLL</span></button>
    </div>
  </div>`, true);
  const zones = $$(root, '.dc-z');
  const placeTok = () => { zones.forEach(z => { z.querySelector('.tok')?.remove(); if (+z.dataset.c! === call) z.insertAdjacentHTML('beforeend', token(bet)); }); };
  wireChips(root, v => { bet = v; placeTok(); }, () => busy);
  zones.forEach(z => z.addEventListener('click', () => { if (busy) return; call = +z.dataset.c!; zones.forEach(x => x.classList.toggle('sel', x === z)); placeTok(); audio.play('hit', 0.25); }));
  placeTok();
  const cubes = [$(root, '#d1'), $(root, '#d2')];
  let ang = [SHOW[3][0], SHOW[3][1], SHOW[4][0], SHOW[4][1]];
  const pose = (a: number[]) => { cubes[0].style.transform = `rotateX(${a[0]}deg) rotateY(${a[1]}deg)`; cubes[1].style.transform = `rotateX(${a[2]}deg) rotateY(${a[3]}deg)`; };
  cubes.forEach(c => (c.style.transition = 'none')); pose(ang);
  const go = $<HTMLButtonElement>(root, '#go');
  go.addEventListener('click', async () => {
    if (busy || !canCover(root, bet)) return; busy = true; go.disabled = true; hideResult(root); vib(10);
    $(root, '#sum').textContent = 'ROLLING...'; audio.play('hit', 0.45);
    const sp = spinner(pose, [610, 470, -560, 520], ang);
    try {
      const res = await backend.placeBet({ game: 'dice', wager: bet, pick: call });
      const [a, b] = res.outcome.dice!;
      await sp.land([SHOW[a][0], SHOW[a][1], SHOW[b][0], SHOW[b][1]], 1300); ang = sp.angles.slice(); audio.play('hit', 0.45);
      $(root, '#sum').textContent = `${a} + ${b} = ${a + b}`; setBal(root);
      verdict(root, bet, res.payout, res.blessing, `Rolled ${a + b}`, res.proof);
    } catch (e) { await sp.land([SHOW[3][0], SHOW[3][1], SHOW[4][0], SHOW[4][1]], 700); ang = sp.angles.slice(); $(root, '#sum').textContent = ''; oops(root, e); }
    finally { busy = false; go.disabled = false; }
  });
}

// ---------------------------------------------------------------------------------------------- ROULETTE (single zero)
const EU = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const colorOf = (n: number) => (n === 0 ? 'green' : RED.has(n) ? 'red' : 'black');
const rlHist: number[] = [];
const pt = (a: number, r: number) => `${(Math.sin((a * Math.PI) / 180) * r).toFixed(2)},${(-Math.cos((a * Math.PI) / 180) * r).toFixed(2)}`;
function rouletteWheelSvg() {
  const th = 360 / 37;
  const wedges = EU.map((n, i) => {
    const a0 = i * th - th / 2, a1 = i * th + th / 2, fill = n === 0 ? '#1f8a4c' : RED.has(n) ? '#c4202e' : '#16161e';
    return `<path d="M${pt(a0, 64)} L${pt(a0, 86)} A86 86 0 0 1 ${pt(a1, 86)} L${pt(a1, 64)} A64 64 0 0 0 ${pt(a0, 64)}Z" fill="${fill}" stroke="#d9b45a" stroke-width=".6"/>`
      + `<text transform="rotate(${(i * th).toFixed(2)}) translate(0,-78)" text-anchor="middle" dominant-baseline="middle" font-size="6.6" font-family="Num, Silkscreen, monospace" fill="#fff">${n}</text>`;
  }).join('');
  return `<svg viewBox="-100 -100 200 200">
    <defs><radialGradient id="rw" cx="50%" cy="45%"><stop offset="0" stop-color="#a86a32"/><stop offset="1" stop-color="#4a2a10"/></radialGradient>
      <radialGradient id="rg" cx="40%" cy="35%"><stop offset="0" stop-color="#fff6c8"/><stop offset=".5" stop-color="#f5c542"/><stop offset="1" stop-color="#8a5a14"/></radialGradient></defs>
    <circle r="99" fill="#2a160a"/><circle r="97" fill="url(#rw)"/><circle r="93" fill="#1a0e06"/><circle r="89" fill="none" stroke="#d9b45a" stroke-width="1.4"/>
    <g class="wh" id="wh">${wedges}<circle r="64" fill="url(#rw)" stroke="#d9b45a" stroke-width="1.2"/><circle r="40" fill="none" stroke="#d9b45a" stroke-width="2"/>
      ${[0, 45, 90, 135].map(a => `<rect x="-2.5" y="-34" width="5" height="68" rx="2" fill="url(#rg)" transform="rotate(${a})"/>`).join('')}<circle r="10" fill="url(#rg)" stroke="#6b4a10"/></g>
    <g class="bl" id="bl"><circle class="ball" id="ball" r="4.3" fill="#fff" stroke="#999" stroke-width=".6" style="transform: translate(0px, -91px)"/></g>
  </svg>`;
}
function roulette(root: Root, close: () => void) {
  let bet = tableBet(25), call: number = ROULETTE_PICK.red, busy = false, W = 0, B = 0;
  const cells: string[] = [`<button class="rc green zero" data-p="0" style="grid-column:1;grid-row:1/4"><i>0</i></button>`];
  for (let n = 1; n <= 36; n++) cells.push(`<button class="rc ${colorOf(n)}" data-p="${n}" style="grid-column:${Math.ceil(n / 3) + 1};grid-row:${n % 3 === 0 ? 1 : n % 3 === 2 ? 2 : 3}"><i>${n}</i></button>`);
  const OUT: [string, number][] = [['1 &ndash; 18', ROULETTE_PICK.low], ['EVEN', ROULETTE_PICK.even], ['<i class="dia" style="background:#c4202e"></i>', ROULETTE_PICK.red], ['<i class="dia" style="background:#1b1b24;box-shadow:0 0 0 1px #fff"></i>', ROULETTE_PICK.black], ['ODD', ROULETTE_PICK.odd], ['19 &ndash; 36', ROULETTE_PICK.high]];
  OUT.forEach(([l, p], i) => cells.push(`<button class="rc out" data-p="${p}" style="grid-column:${2 + i * 2}/span 2;grid-row:5">${l}</button>`));
  ['1st 12', '2nd 12', '3rd 12'].forEach((l, i) => cells.push(`<button class="rc out dz" data-p="${110 + i}" style="grid-column:${2 + i * 4}/span 4;grid-row:4">${l.toUpperCase()}</button>`));
  [122, 121, 120].forEach((p, row) => cells.push(`<button class="rc col" data-p="${p}" style="grid-column:14;grid-row:${row + 1}">2:1</button>`));
  shell(root, close, 'casino', 'ROULETTE', `
  <div class="rl">
    <div class="rl-left"><div class="rl-wheel">${rouletteWheelSvg()}</div><div class="g-hist" id="hist"></div></div>
    <div class="rl-right">
      <div class="rl-felt felt"><div class="rl-grid" id="grid">${cells.join('')}</div></div>
      <div class="rl-bar">${chipRow(bet)}<div class="rl-bet" id="betl"></div><button class="g-go" id="go"><span>SPIN</span></button></div>
    </div>
  </div>`, true);
  const names: Record<number, string> = { 110: '1ST 12', 111: '2ND 12', 112: '3RD 12', 120: 'COLUMN 1', 121: 'COLUMN 2', 122: 'COLUMN 3', [ROULETTE_PICK.red]: 'RED', [ROULETTE_PICK.black]: 'BLACK', [ROULETTE_PICK.odd]: 'ODD', [ROULETTE_PICK.even]: 'EVEN', [ROULETTE_PICK.low]: '1 - 18', [ROULETTE_PICK.high]: '19 - 36' };
  const label = () => { $(root, '#betl').innerHTML = `${call <= 36 ? `STRAIGHT ${call}` : names[call]} &middot; ${bet}<small>PAYS ${call <= 36 ? '36' : call >= 110 ? '3' : '2'}&times; &middot; TAP THE FELT TO MOVE YOUR CHIP</small>`; };
  const placeTok = () => { $$(root, '.rc').forEach(c => { c.querySelector('.tok')?.remove(); c.classList.toggle('sel', +c.dataset.p! === call); if (+c.dataset.p! === call) c.insertAdjacentHTML('beforeend', token(bet)); }); label(); };
  wireChips(root, v => { bet = v; placeTok(); }, () => busy);
  $$(root, '.rc').forEach(c => c.addEventListener('click', () => { if (busy) return; call = +c.dataset.p!; placeTok(); audio.play('hit', 0.25); vib(4); }));
  placeTok();
  const hist = () => { $(root, '#hist').innerHTML = rlHist.slice(0, 8).map(n => `<i class="${colorOf(n)}">${n}</i>`).join(''); };
  hist();
  const wh = $(root, '#wh'), bl = $(root, '#bl'), ball = $(root, '#ball'), go = $<HTMLButtonElement>(root, '#go');
  wh.style.transition = 'none'; bl.style.transition = 'none';
  go.addEventListener('click', async () => {
    if (busy || !canCover(root, bet)) return; busy = true; go.disabled = true; hideResult(root); $$(root, '.rc.won').forEach(c => c.classList.remove('won'));
    const snd = audio.loop('roulette', 0.55); vib(10);
    ball.style.transition = 'none'; ball.style.transform = 'translate(0px, -91px)';
    const sp = spinner(([w, b]) => { wh.style.transform = `rotate(${w}deg)`; bl.style.transform = `rotate(${b}deg)`; }, [150, -400], [W, B]);
    try {
      const res = await backend.placeBet({ game: 'roulette', wager: bet, pick: call });
      const n = res.outcome.n!, i = EU.indexOf(n), th = 360 / 37, LAND = 4000;
      // the ball leaves the rim and drops into the pocket as the wheel slows
      window.setTimeout(() => { ball.style.transition = 'transform .9s cubic-bezier(.5,0,.6,1.4)'; ball.style.transform = 'translate(0px, -70px)'; }, LAND - 1300);
      snd((LAND - 300) / 1000);                          // the result is in: the rattle fades as the wheel slows
      await sp.land([mod360(-i * th), 0], LAND); [W, B] = sp.angles;
      rlHist.unshift(n); hist(); setBal(root);
      root.querySelector(`.rc[data-p="${n}"]`)?.classList.add('won');
      verdict(root, bet, res.payout, res.blessing, `${n} ${colorOf(n).toUpperCase()}`, res.proof);
    } catch (e) { snd(0.8); await sp.land([mod360(W), 0], 900); [W, B] = sp.angles; oops(root, e); }
    finally { snd(); busy = false; go.disabled = false; }
  });
}

// ---------------------------------------------------------------------------------------------- BLACKJACK
const SUIT_PX: Record<string, string[]> = {
  H: ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...'],
  D: ['...#...', '..###..', '.#####.', '#######', '.#####.', '..###..', '...#...'],
  C: ['..###..', '..###..', '##.#.##', '#######', '##.#.##', '...#...', '..###..'],
  S: ['...#...', '..###..', '.#####.', '#######', '#######', '.#.#.#.', '..###..'],
};
const cardHtml = (name: string, i: number, fresh: boolean) => {
  const rank = name[0] === 'T' ? '10' : name[0], suit = name[1], red = suit === 'H' || suit === 'D';
  const sv = pix(SUIT_PX[suit], red ? '#c4202e' : '#1b1b24');
  return `<div class="pc ${red ? 'red' : ''} ${fresh ? 'in' : ''}" style="--i:${i}"><span class="r">${rank}</span><i class="s">${sv}</i><span class="r b">${rank}</span></div>`;
};
function blackjack(root: Root, close: () => void) {
  if (!backend.blackjackDeal || !backend.blackjackAct) {
    shell(root, close, 'casino', 'BLACKJACK', '<div class="g-msg" style="padding:30px">The dealer is shuffling. The blackjack table opens in the next update.</div>'); return;
  }
  let bet = tableBet(25), busy = false, state: BjState | null = null, shownP = 0, shownD = 0;
  shell(root, close, 'casino', 'BLACKJACK', `
  <div class="bj">
    <div class="bj-table felt">
      <div class="bj-shoe"></div>
      <div class="bj-row"><div class="bj-lab">DEALER <b id="dt"></b></div><div class="bj-hand" id="dh"></div></div>
      <div class="bj-arc">BLACKJACK PAYS 3 TO 2 &nbsp;&middot;&nbsp; DEALER STANDS ON ALL 17s</div>
      <div class="bj-row"><div class="bj-hand" id="ph"></div><div class="bj-lab">YOU <b id="pt"></b></div></div>
      <div class="bj-spot" id="spot"></div>
    </div>
    <div class="bj-ctl">
      <div id="betting" class="bj-panel"><div class="g-lab">YOUR BET</div>${chipRow(bet)}<button class="g-go" id="deal"><span>DEAL</span></button></div>
      <div id="acting" class="bj-panel" hidden>
        <button class="bj-btn hit" data-a="hit"><b>HIT</b><small>take a card</small></button>
        <button class="bj-btn stand" data-a="stand"><b>STAND</b><small>dealer plays</small></button>
        <button class="bj-btn dbl" data-a="double"><b>DOUBLE</b><small>2x bet, one card</small></button>
      </div>
    </div>
  </div>`, true);
  const spot = () => { $(root, '#spot').innerHTML = state?.doubled ? token(bet) + token(bet) : token(state ? state.stake : bet); };
  wireChips(root, v => { bet = v; spot(); }, () => busy || !!state);
  spot();
  const draw = (dealerSlow = false) => new Promise<void>((res) => {
    const s = state, ph = $(root, '#ph'), dh = $(root, '#dh');
    if (!s) { ph.innerHTML = ''; dh.innerHTML = ''; $(root, '#pt').textContent = ''; $(root, '#dt').textContent = ''; shownP = shownD = 0; return res(); }
    ph.innerHTML = s.player.map((c, i) => cardHtml(c, i, i >= shownP)).join('');
    shownP = s.player.length;
    $(root, '#pt').textContent = `${s.soft && s.playerTotal < 21 ? 'SOFT ' : ''}${s.playerTotal}`;
    const showDealer = (n: number) => {
      dh.innerHTML = s.dealer.slice(0, n).map((c, i) => cardHtml(c, i, i >= shownD)).join('') + (s.stage === 'player' ? '<div class="pc back in" style="--i:1"></div>' : '');
      shownD = n;
    };
    if (!dealerSlow || s.dealer.length <= shownD) { showDealer(s.dealer.length); $(root, '#dt').textContent = s.stage === 'done' ? String(s.dealerTotal) : ''; return res(); }
    let n = shownD;                                                     // the dealer turns cards one by one
    const step = () => { n++; showDealer(n); audio.play('hit', 0.3); if (n < s.dealer.length) setTimeout(step, 520); else { $(root, '#dt').textContent = String(s.dealerTotal); setTimeout(res, 350); } };
    setTimeout(step, 380);
  });
  const mode = () => {
    const playing = !!state && state.stage === 'player';
    $(root, '#betting').hidden = playing; $(root, '#acting').hidden = !playing;
    if (playing) (root.querySelector('[data-a=double]') as HTMLButtonElement).disabled = !state!.canDouble;
  };
  const finish = async (s: BjState) => {
    state = s; await draw(true); setBal(root); spot();
    const r = s.result!, busted = s.playerTotal > 21, dealerBj = s.dealer.length === 2 && s.dealerTotal === 21, link = proofLinks(r.proof);
    if (r.label === 'natural') showResult(root, 'jackpot', 'BLACKJACK!', r.payout, 'Pays 3 to 2' + link);
    else if (r.label === 'win') showResult(root, 'win', s.dealerTotal > 21 ? 'DEALER BUSTS!' : 'YOU WIN!', r.payout, `${s.dealerTotal > 21 ? `Dealer ${s.dealerTotal}` : `${s.playerTotal} beats ${s.dealerTotal}`}${r.blessing ? ` · Blessing +${r.blessing}` : ''}${link}`);
    else if (r.label === 'push') showResult(root, 'push', 'PUSH', `+${fmt(r.payout)}`, `${s.playerTotal} each. Your bet comes back.${link}`);
    else showResult(root, 'lose', busted ? 'BUST' : 'YOU LOSE', s.stake - r.payout, (busted ? `${s.playerTotal} is over 21` : dealerBj ? `Dealer blackjack${r.payout ? '. Your double comes back' : ''}` : `Dealer ${s.dealerTotal} beats ${s.playerTotal}`) + link);
    wireVerify(root, r.proof);
    state = null; mode();
  };
  // a hand left open comes back with its cards
  if (backend.blackjackOpen) { busy = true; void backend.blackjackOpen().then(async (s) => { if (!s || !root.querySelector('.bj')) return; state = s; bet = s.doubled ? s.stake / 2 : s.stake; spot(); await draw(); if (s.stage === 'done') await finish(s); else mode(); }).catch(() => {}).finally(() => { busy = false; }); }
  $(root, '#deal').addEventListener('click', async () => {
    if (busy || !canCover(root, bet)) return; busy = true; hideResult(root); state = null; await draw();
    const dealBtn = $(root, '#deal'); dealBtn.classList.add('pending'); (dealBtn as HTMLButtonElement).disabled = true;
    try {
      const s = await backend.blackjackDeal!(bet); audio.play('hit', 0.4); vib(8);
      state = s; await draw(); setBal(root); spot();
      if (s.stage === 'done') await finish(s); else mode();
    } catch (e) { state = null; await draw(); oops(root, e); }
    finally { busy = false; dealBtn.classList.remove('pending'); (dealBtn as HTMLButtonElement).disabled = false; }
  });
  $$(root, '.bj-btn').forEach(b => b.addEventListener('click', async () => {
    if (busy || !state) return;
    if (b.dataset.a === 'double' && !canCover(root, state.stake)) return;     // doubling stakes the same again
    busy = true; vib(8);
    $$(root, '.bj-btn').forEach(x => ((x as HTMLButtonElement).disabled = true));
    b.classList.add('pending');
    try {
      const s = await backend.blackjackAct!(state.betId, b.dataset.a as 'hit' | 'stand' | 'double'); audio.play('hit', 0.35);
      if (s.stage === 'done') await finish(s);
      else { state = s; await draw(); }
    } catch (e) { oops(root, e); }
    finally { b.classList.remove('pending'); busy = false; $$(root, '.bj-btn').forEach(x => ((x as HTMLButtonElement).disabled = false)); mode(); }
  }));
}

// ---------------------------------------------------------------------------------------------- WHEELS (fortune + harmony)
function wheelSvg(segs: string[], colors: string[]) {
  const n = segs.length, th = 360 / n;
  const slices = segs.map((s, i) => {
    const a0 = i * th, a1 = (i + 1) * th;
    return `<path d="M0,0 L${pt(a0, 88)} A88 88 0 0 1 ${pt(a1, 88)} Z" fill="${colors[i % colors.length]}" stroke="#fff3cf" stroke-width="1"/>`
      + `<text transform="rotate(${a0 + th / 2}) translate(0,-60)" text-anchor="middle" dominant-baseline="middle" font-size="${s.length > 4 ? 8 : 12}" font-family="Num, Silkscreen, monospace" fill="#fff" stroke="#14101c" stroke-width=".8" paint-order="stroke">${s}</text>`;
  }).join('');
  const pegs = segs.map((_, i) => { const [x, y] = pt(i * th, 92).split(','); return `<circle cx="${x}" cy="${y}" r="3" fill="#fff3cf" stroke="#6b4a10"/>`; }).join('');
  return `<svg viewBox="-100 -100 200 200"><defs><radialGradient id="wg" cx="40%" cy="35%"><stop offset="0" stop-color="#fff6c8"/><stop offset=".5" stop-color="#f5c542"/><stop offset="1" stop-color="#8a5a14"/></radialGradient></defs>
    <circle r="99" fill="#14101c"/><circle r="97" fill="url(#wg)"/>
    <g class="disc" id="disc">${slices}${pegs}<circle r="16" fill="url(#wg)" stroke="#6b4a10" stroke-width="2"/><circle r="6" fill="#c4202e"/></g></svg>`;
}
interface WheelCfg { theme: 'casino' | 'church'; title: string; segs: string[]; colors: string[]; meters: () => string; ready: () => boolean; why: () => string; spin: () => Promise<WheelResult>; prizes: string; back?: () => void }
function wheelPanel(root: Root, close: () => void, o: WheelCfg) {
  let busy = false, rot = 0;
  shell(root, close, o.theme, o.title, `
  <div class="wf">
    <div class="wf-wheel"><div class="wf-flap" id="flap"></div>${wheelSvg(o.segs, o.colors)}</div>
    <div class="wf-ctl"><div id="meters" style="width:100%;display:flex;flex-direction:column;align-items:center;gap:8px"></div>
      <div class="prizes">${o.prizes}</div>
      <div class="g-msg" id="msg"></div>
      <button class="g-go ${o.theme === 'church' ? 'gold' : ''}" id="go"><span>SPIN</span></button>
      ${o.back ? '<button class="g-key dark" id="back">BACK TO THE ALTAR</button>' : ''}</div>
  </div>`);
  const go = $<HTMLButtonElement>(root, '#go');
  const show = () => { $(root, '#meters').innerHTML = o.meters(); go.disabled = busy || !o.ready(); $(root, '#msg').textContent = o.ready() ? 'The wheel is yours. Spin it!' : o.why(); };
  show();
  if (o.back) $(root, '#back').addEventListener('click', o.back);
  go.addEventListener('click', async () => {
    if (busy || !o.ready()) return; busy = true; go.disabled = true; hideResult(root); $(root, '#flap').classList.add('tick'); vib(10);
    const disc = $(root, '#disc'); disc.style.transition = 'none';
    const snd = audio.loop('roulette', 0.55);
    const sp = spinner(([d]) => { disc.style.transform = `rotate(${d}deg)`; }, [260], [rot]);
    try {
      const r = await o.spin(); const label = r.prize === 'JACKPOT' ? 'JACKPOT' : String(r.prize);
      const idx = o.segs.map((s, i) => (s === label ? i : -1)).filter(i => i >= 0); const j = rndOf(idx.length ? idx : [0]);
      const th = 360 / o.segs.length, LAND = 4200;
      snd((LAND - 300) / 1000);
      await sp.land([mod360(-(j * th + th / 2))], LAND); rot = sp.angles[0];
      $(root, '#flap').classList.remove('tick'); setBal(root);
      showResult(root, r.prize === 'JACKPOT' || r.chips >= 500 ? 'jackpot' : 'win', r.prize === 'JACKPOT' ? 'JACKPOT!' : 'YOU WIN!', r.chips, (r.prize === 'JACKPOT' ? 'The whole pool, in real chips' : 'Bonus chips: play them, and what they win is yours to cash out') + proofLinks(r.proof)); wireVerify(root, r.proof);
    } catch (e) { snd(0.8); await sp.land([mod360(rot)], 900); rot = sp.angles[0]; $(root, '#flap').classList.remove('tick'); oops(root, e); }
    finally { snd(); busy = false; show(); }
  });
}
const meter = (kind: 'luck' | 'faith', v: number, mark?: number) => `<div class="meter-big ${kind}"><div class="mb-h"><span>${kind.toUpperCase()}</span><span>${Math.floor(v)} / 100</span></div><div class="mb"><b style="width:calc(${Math.min(100, v)}% - 4px)"></b>${mark ? `<i style="left:${mark}%"></i>` : ''}</div></div>`;
const FORTUNE_SEGS = ['10', '25', '50', '100', '25', '10', '250', '500'];
function fortune(root: Root, close: () => void) {
  wheelPanel(root, close, {
    theme: 'casino', title: 'WHEEL OF FORTUNE', segs: FORTUNE_SEGS, colors: ['#c4202e', '#2f6fd0', '#1f8a4c', '#8a2ac4', '#f08a1a', '#1b1b24', '#d4a017', '#ff2e88'],
    meters: () => meter('luck', store.eco.luck), ready: () => store.eco.luck >= 100,
    why: () => 'Fill your LUCK to 100 by playing. A spin empties the meter.',
    spin: () => backend.spinWheel(), prizes: '<span>TOP PRIZE 500 BONUS CHIPS</span><span>NEEDS LUCK 100</span>',
  });
}
const HARMONY_SEGS = ['10', '20', '40', '10', '100', '20', '10', 'JACKPOT', '40', '20'];
function harmony(root: Root, close: () => void, back?: () => void) {
  wheelPanel(root, close, {
    theme: 'church', title: 'HARMONY WHEEL', segs: HARMONY_SEGS, colors: ['#f0b84a', '#2f6fd0', '#8a2ac4', '#3fbf6a', '#c4202e', '#2f6fd0', '#f0b84a', '#ff2e88', '#8a2ac4', '#3fbf6a'],
    meters: () => meter('luck', store.eco.luck, 50) + meter('faith', store.eco.faith, 50),
    ready: () => store.eco.luck >= 50 && store.eco.faith >= 50 && Date.now() > store.stats.harmonyAt + PARAMS.harmonyCooldownS * 1000,
    why: () => (store.eco.luck >= 50 && store.eco.faith >= 50 ? 'The wheel is resting. Come back soon.' : 'Harmony needs 50 LUCK and 50 FAITH at the same time. Walk between both worlds.'),
    spin: () => backend.spinHarmony(), prizes: `<span>JACKPOT POOL ${fmt(store.stats.jackpot)}</span><span>COSTS 50 LUCK + 50 FAITH</span><span>PRIZES ARE BONUS CHIPS</span>`, back,
  });
}

// ---------------------------------------------------------------------------------------------- CASHIER (exchange, leaderboard, my bets)
/** copy text; falls back to a hidden textarea where the async clipboard is missing (plain-http LAN, old WebViews) */
async function copyText(t: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(t); return true; } catch { /* fall back */ }
  const ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
  document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, t.length);
  let ok = false; try { ok = document.execCommand('copy'); } catch { /* */ } ta.remove(); return ok;
}
/** FUND WALLET: the player's own Solana address, a COPY button, and a live check that shows the SOL landing */
async function fundWallet(root: Root, refresh: () => void) {
  const gm = root.querySelector('.gm'); if (!gm || gm.querySelector('.fw')) return;
  const el = document.createElement('div'); el.className = 'fw'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Fund your wallet');
  el.innerHTML = `<div class="fw-card">
      <h3>FUND YOUR WALLET</h3>
      <p>Send <b>devnet SOL</b> to your game wallet from any Solana wallet. It shows up here in a few seconds; then tap <b>BUY CHIPS</b>.</p>
      <div class="fw-addr" id="fw-addr">Opening your wallet...</div>
      <div class="fw-row"><button class="g-key" data-f="copy">COPY ADDRESS</button><button class="g-key dark" data-f="done">DONE</button></div>
      <div class="fw-st" id="fw-st" aria-live="polite">WALLET ${store.eco.sol.toFixed(3)} SOL &middot; watching for deposits...</div>
      <small class="fw-warn">Devnet only. Never send real SOL to this address.</small></div>`;
  gm.appendChild(el);
  let id = '', poll = 0;
  const done = () => { clearInterval(poll); el.remove(); };
  el.addEventListener('click', async (e) => {
    e.stopPropagation();
    const f = (e.target as HTMLElement).closest<HTMLElement>('[data-f]')?.dataset.f;
    if (f === 'done' || e.target === el) done();
    if (f === 'copy' && id) {
      const b = el.querySelector<HTMLElement>('[data-f="copy"]')!;
      if (await copyText(id)) { b.textContent = 'COPIED!'; audio.play('hit', 0.3); setTimeout(() => { if (b.isConnected) b.textContent = 'COPY ADDRESS'; }, 1600); }
      else { const r = document.createRange(); r.selectNodeContents(el.querySelector('#fw-addr')!); const s = getSelection(); s?.removeAllRanges(); s?.addRange(r); b.textContent = 'SELECTED: COPY IT'; }
    }
  });
  try { id = (await backend.wallet!()).accountId; el.querySelector('#fw-addr')!.textContent = id; }
  catch (e) { el.remove(); oops(root, e); return; }
  if (!el.isConnected) return;                                         // closed while the wallet was opening
  const st = el.querySelector<HTMLElement>('#fw-st')!, start = store.eco.sol;
  let busy = false;
  poll = window.setInterval(async () => {
    if (!el.isConnected) { clearInterval(poll); return; }
    if (busy) return; busy = true;
    try {
      await backend.sync?.(); refresh();
      const got = store.eco.sol - start;
      st.innerHTML = got > 0.0004 ? `<b class="pos">RECEIVED +${got.toFixed(3)} SOL</b> &middot; wallet ${store.eco.sol.toFixed(3)} SOL` : `WALLET ${store.eco.sol.toFixed(3)} SOL &middot; watching for deposits...`;
    } catch { /* keep watching */ } finally { busy = false; }
  }, 4000);
}
const GAME_NAME: Record<string, string> = { slots: 'SLOTS', coinflip: 'COIN FLIP', dice: 'DICE', roulette: 'ROULETTE', wheel: 'WHEEL', harmony: 'HARMONY', blackjack: 'BLACKJACK', btc: 'BTC' };
const ago = (t: number) => { const s = Math.max(1, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
function cashier(root: Root, close: () => void) {
  shell(root, close, 'casino', 'CASHIER CAGE', `
  <div class="g-tabs" id="tabs"><button class="on" data-t="x">EXCHANGE</button><button data-t="lb">LEADERBOARD</button><button data-t="me">MY BETS</button></div>
  <div id="pane" class="cs-pane"></div>`);
  const pane = $(root, '#pane');
  const exchange = () => {
    pane.innerHTML = `<div class="cs">
      <div class="cs-window"><div class="g-lcd green"><small>WALLET &middot; TEST SOL</small><b id="near"></b></div><div class="cs-rate">1 SOL = ${fmt(CHIPS_PER_SOL)} CHIPS<br><small>${backend.mode === 'mock' ? 'OFFLINE DEMO' : 'SOLANA DEVNET'}</small></div><div class="g-lcd"><small>CHIPS</small><b id="chp"></b></div></div>
      <div class="cs-bonus" id="cs-bonus"></div>
      <div class="cs-col"><h4>BUY CHIPS</h4><div class="cs-row three"><button class="g-key" data-a="d1">0.01 SOL</button><button class="g-key" data-a="d5">0.05 SOL</button><button class="g-key" data-a="dall">ALL</button></div></div>
      <div class="cs-col"><h4>CASH OUT</h4><div class="cs-row"><button class="g-key dark" data-a="w">10 CHIPS</button><button class="g-key dark" data-a="wall">ALL CHIPS</button></div></div>
      <div class="cs-bottom">${backend.mode === 'chain' && backend.wallet ? '<button class="g-go wide" data-a="fund"><span>FUND WALLET</span></button>' : ''}<button class="g-go wide gold" data-a="faucet"><span>GET FREE TEST SOL</span></button></div></div>`;
    const show = () => { $(root, '#near').textContent = store.eco.sol.toFixed(3); $(root, '#chp').textContent = fmt(store.eco.chips); $(root, '#cs-bonus').textContent = store.eco.bonus > 0 ? `+ ${fmt(store.eco.bonus)} bonus chips: play them first, they cannot be cashed out` : ''; setBal(root); };
    show();
    $$(pane, '[data-a]').forEach(b => b.addEventListener('click', async () => {
      const a = b.dataset.a!;
      if (a === 'fund') { fundWallet(root, show); return; }
      b.classList.add('pending'); (b as HTMLButtonElement).disabled = true; hideResult(root);
      try {
        if (a === 'd1' || a === 'd5' || a === 'dall') {
          // our server pays the fee, so ALL really is all (in whole chips)
          const n = a === 'd1' ? 0.01 : a === 'd5' ? 0.05 : Math.floor(store.eco.sol * CHIPS_PER_SOL) / CHIPS_PER_SOL;
          if (n < 0.01) throw new BackendError('no_sol', 'Your wallet needs at least 0.01 SOL. Tap GET FREE TEST SOL first.');
          await backend.deposit(n); show(); showResult(root, 'win', 'CHIPS BOUGHT', Math.round(n * CHIPS_PER_SOL), `${n} SOL exchanged`);
        }
        else if (a === 'faucet') { const paid = await backend.faucet(); show(); showResult(root, 'push', 'FAUCET', paid ? `+${paid} SOL` : 'TEST SOL SENT', 'Free test SOL, straight to your wallet'); }
        else {
          if (a === 'wall') await backend.sync?.();      // ALL means what the chain holds now, not what the screen last showed
          const have = Math.floor(store.eco.chips), amt = a === 'w' ? Math.min(10, have) : have;
          if (amt <= 0) throw new BackendError('no_chips', store.eco.bonus > 0 ? 'Bonus chips are for playing. What they win is yours to cash out.' : 'You have no chips to cash out.');
          await backend.withdraw(amt); show();
          showResult(root, 'push', 'CASHED OUT', `+${(amt / CHIPS_PER_SOL).toFixed(3)} SOL`, `${fmt(amt)} chips paid out`);
        }
      } catch (e) { oops(root, e); }
      finally { b.classList.remove('pending'); (b as HTMLButtonElement).disabled = false; }
    }));
  };
  const leaderboard = async () => {
    pane.innerHTML = '<div class="g-msg">Loading the board...</div>';
    try {
      const r = backend.leaderboard ? await backend.leaderboard() : { rows: [], demo: true };
      pane.innerHTML = `<div class="lb">${r.demo ? '<div class="lb-note">DEMO RIVALS &middot; the live board fills in from the chain indexer</div>' : ''}
        <div class="lb-row hd"><span>#</span><span>PLAYER</span><span>WAGERED</span><span>NET</span></div><div class="lb-scroll">
        ${r.rows.slice(0, 25).map(x => `<div class="lb-row ${x.you ? 'you' : ''} ${x.rank <= 3 ? 'top' + x.rank : ''}"><span>${x.rank}</span><span>${x.name}${x.you ? ' (YOU)' : ''}</span><span>${fmt(x.wagered)}</span><span class="${x.net >= 0 ? 'pos' : 'neg'}">${x.net >= 0 ? '+' : ''}${fmt(x.net)}</span></div>`).join('') || '<div class="g-msg">No players yet.</div>'}</div></div>`;
    } catch (e) { pane.innerHTML = `<div class="g-msg">${errText(e)}</div>`; }
  };
  const mine = async () => {
    pane.innerHTML = '<div class="g-msg">Loading your bets...</div>';
    try {
      const rows = backend.history ? await backend.history() : store.stats.history;
      // totals from the rows themselves, so they always agree with the list (chain mode keeps no local tally)
      const wag = rows.reduce((t, x) => t + x.wager, 0), net = rows.reduce((t, x) => t + x.payout - x.wager, 0);
      pane.innerHTML = `<div class="lb">
        <div class="lb-sum"><div class="plate"><small>PLAYS</small><b>${rows.length}</b></div><div class="plate"><small>WAGERED</small><b>${fmt(wag)}</b></div><div class="plate"><small>NET</small><b class="${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : ''}${fmt(net)}</b></div></div>
        <div class="lb-row hd bet"><span>WHEN</span><span>GAME</span><span>RESULT</span><span>BET</span><span>PAID</span><span>ON CHAIN</span></div><div class="lb-scroll">
        ${rows.slice(0, 50).map(x => `<div class="lb-row bet"><span>${ago(x.t)}</span><span>${GAME_NAME[x.game] ?? x.game.toUpperCase()}</span><span>${x.detail}</span><span>${x.wager ? fmt(x.wager) : '-'}</span><span class="${x.payout > x.wager ? 'pos' : x.payout < x.wager ? 'neg' : ''}">${x.payout ? '+' + fmt(x.payout) : '0'}</span><span>${x.tx ? txLink(x.tx) : '<i class="dim">-</i>'}</span></div>`).join('') || '<div class="g-msg">No bets yet. The Coin Flip pit is right by the door.</div>'}</div></div>`;
    } catch (e) { pane.innerHTML = `<div class="g-msg">${errText(e)}</div>`; }
  };
  const tabs: Record<string, () => void> = { x: exchange, lb: leaderboard, me: mine };
  $$(root, '#tabs button').forEach(b => b.addEventListener('click', () => { $$(root, '#tabs button').forEach(x => x.classList.toggle('on', x === b)); audio.play('hit', 0.25); tabs[b.dataset.t!](); }));
  exchange();
}

// ---------------------------------------------------------------------------------------------- OFFERING BOX
function offering(root: Root, close: () => void) {
  shell(root, close, 'church', 'OFFERING BOX', `
  <div class="of">
    <div class="chest" id="chest"><div class="lid"></div><div class="body"><span class="cross">${icon('cross', 24)}</span></div><div class="slot"></div></div>
    <div class="of-ctl">
      <div class="stone"><div class="plate"><small>YOUR FAITH</small><b id="fa"></b></div><div class="plate"><small>CHURCH TREASURY</small><b id="tr"></b></div></div>
      <div class="g-lab">CHOOSE YOUR TITHE</div>
      <div class="coins">${[10, 50, 100].map(v => `<button class="coinbtn" data-t="${v}"><b>${v}</b><small>CHIPS</small></button>`).join('')}</div>
      <div class="g-msg">Every 10 chips grows your FAITH by about 1, a little less as FAITH rises. Your tithe funds the blessings that boost every Casino payout.</div>
    </div>
  </div>`);
  const show = () => { $(root, '#fa').textContent = String(Math.floor(store.eco.faith)); $(root, '#tr').textContent = fmt(store.stats.pool); setBal(root); };
  show();
  $$(root, '[data-t]').forEach(b => b.addEventListener('click', async () => {
    if (!canCover(root, +b.dataset.t!, 'tithe')) return;
    hideResult(root); b.classList.add('pending'); $$(root, '[data-t]').forEach(x => ((x as HTMLButtonElement).disabled = true));
    try {
      const r = await backend.tithe(+b.dataset.t!);
      for (let i = 0; i < 3; i++) setTimeout(() => { const c = document.createElement('i'); c.className = 'drop'; $(root, '#chest').appendChild(c); setTimeout(() => c.remove(), 700); }, i * 120);
      audio.play('hit', 0.4); await sleep(500); show();
      showResult(root, 'win', 'BLESSED', `+${r.faithGain.toFixed(1)} FAITH`, `${b.dataset.t} chips to the Church`);
    } catch (e) { oops(root, e); }
    finally { b.classList.remove('pending'); $$(root, '[data-t]').forEach(x => ((x as HTMLButtonElement).disabled = false)); }
  }));
}

// ---------------------------------------------------------------------------------------------- VOTIVE CANDLES
function candles(root: Root, close: () => void) {
  shell(root, close, 'church', 'VOTIVE CANDLES', `
  <div class="of">
    <div class="niche"><div class="vrack" id="vr"></div></div>
    <div class="of-ctl"><div class="stone"><div class="plate"><small>YOUR FAITH</small><b id="fa"></b></div><div class="plate"><small>CANDLES LIT</small><b id="lit"></b></div></div>
      <div class="g-msg">Light a candle for +${PARAMS.candleFaithMilli / 1000} FAITH. Once a day in the full game.</div>
      <button class="g-go gold wide" id="go"><span>LIGHT A CANDLE</span></button></div>
  </div>`);
  const draw = (fresh = -1) => { const n = store.stats.candles % 13; $(root, '#vr').innerHTML = Array.from({ length: 12 }, (_, i) => `<i class="${i < n ? 'lit' : ''} ${i === fresh ? 'new' : ''}"></i>`).join(''); $(root, '#fa').textContent = String(Math.floor(store.eco.faith)); $(root, '#lit').textContent = String(store.stats.candles); };
  draw();
  const go = $<HTMLButtonElement>(root, '#go');
  const tick = () => { const left = PARAMS.candleCooldownS * 1000 - (Date.now() - store.stats.candleAt); go.disabled = left > 0; $(go, 'span').textContent = left > 0 ? `RESTING ${Math.ceil(left / 1000)}S` : 'LIGHT A CANDLE'; };
  let lighting = false;
  tick(); const t = window.setInterval(() => { if (!root.isConnected) return clearInterval(t); if (!lighting) tick(); }, 500);
  go.addEventListener('click', async () => {
    if (lighting) return; hideResult(root); lighting = true;
    try { await pending(go, () => backend.lightCandle()); draw((store.stats.candles - 1) % 13); audio.play('hit', 0.4); showResult(root, 'win', 'A CANDLE BURNS', `+${PARAMS.candleFaithMilli / 1000} FAITH`, 'Your prayer is heard'); }
    catch (e) { oops(root, e); }
    finally { lighting = false; tick(); }
  });
}

// ---------------------------------------------------------------------------------------------- CONFESSIONAL
/** A short confession with three answers. Penance is real: it offers LUCK at the altar or tithes chips (on chain). */
const CONFESSIONS: { sin: string; reply: [string, string, string] }[] = [
  { sin: 'Forgive me, Father. I chased my losses at the tables.', reply: ['Then give back a little of the luck that tempted you.', 'A tithe for the poor. Losses shared are losses halved.', 'The door stays open, child. Come back when you are ready.'] },
  { sin: 'I prayed for the dice to land on seven. Three times.', reply: ['Dice do not hear prayers. But the altar does.', 'Give to the box, and let the dice keep their own counsel.', 'Even silence is a kind of answer. Go in peace.'] },
  { sin: 'I envied a stranger’s jackpot at the Harmony Wheel.', reply: ['Envy is luck turned sour. Offer it up.', 'Generosity cures envy faster than any wheel.', 'Envy fades. So does FAITH, if you never return.'] },
  { sin: 'I told Don Fortuna the Church was boring.', reply: ['Ha. Offer some LUCK, and we shall call it even.', 'A small tithe, and I will not tell the candles.', 'He tells me worse every night. Go on.'] },
  { sin: 'I spent my last chips and blamed the house.', reply: ['The house keeps its rules. Keep yours: a little LUCK for the altar.', 'Even a small tithe turns blame into belief.', 'The Father may send alms to those who run dry. Patience.'] },
];
function confessional(root: Root, close: () => void) {
  const pick = () => CONFESSIONS[Math.floor(Math.random() * CONFESSIONS.length)];
  let c = pick();
  const LUCK = 5, CHIPS = 10;
  const render = () => {
    shell(root, close, 'church', 'CONFESSIONAL', `
    <div class="cfs">
      <div class="cfs-grille"><div class="spr idle" style="${spriteCss('m_monk', 'idle_down', 3)}"></div><i></i></div>
      <div class="cfs-talk">
        <div class="g-lab">YOU WHISPER</div>
        <p class="cfs-sin">&ldquo;${c.sin}&rdquo;</p>
        <div class="g-lab">YOUR PENANCE</div>
        <div class="cfs-opts">
          <button class="g-key" data-p="luck" ${store.eco.luck < LUCK ? 'disabled' : ''}>OFFER ${LUCK} LUCK<small>${store.eco.luck < LUCK ? 'not enough LUCK' : 'becomes FAITH at the altar'}</small></button>
          <button class="g-key" data-p="tithe" ${store.eco.chips < CHIPS ? 'disabled' : ''}>TITHE ${CHIPS} CHIPS<small>${store.eco.chips < CHIPS ? 'not enough chips' : 'to the poor box'}</small></button>
          <button class="g-key dark" data-p="none">SAY NOTHING<small>and leave in peace</small></button>
        </div>
        <button class="cfs-other" id="other">CONFESS SOMETHING ELSE</button>
      </div>
    </div>`);
    $(root, '#other').addEventListener('click', () => { let n = pick(); while (n === c && CONFESSIONS.length > 1) n = pick(); c = n; render(); });
    $$(root, '[data-p]').forEach(b => b.addEventListener('click', async () => {
      const kind = b.dataset.p!; hideResult(root);
      if (kind === 'none') { showResult(root, 'push', 'GO IN PEACE', '', c.reply[2]); return; }
      $$(root, '[data-p]').forEach(x => ((x as HTMLButtonElement).disabled = true));
      try {
        if (kind === 'luck') { const r = await pending(b, () => backend.offerLuck(LUCK)); showResult(root, 'win', 'ABSOLVED', `+${r.faithGain.toFixed(1)} FAITH`, c.reply[0]); }
        else { const r = await pending(b, () => backend.tithe(CHIPS)); showResult(root, 'win', 'ABSOLVED', `+${r.faithGain.toFixed(1)} FAITH`, c.reply[1]); }
        setBal(root); window.setTimeout(() => { if (root.isConnected) { c = pick(); render(); } }, 3500);
      } catch (e) { oops(root, e); $$(root, '[data-p]').forEach(x => ((x as HTMLButtonElement).disabled = false)); }
    }));
  };
  render();
}

// ---------------------------------------------------------------------------------------------- QUEST BOARD (a book)
const KIND_TAG = ['SOCIAL', 'PROJECT', 'MACHINE'];
const KIND_DO = ['FOLLOW', 'VISIT', 'PLAY'];
/** "5d 3h", "2h 10m", "9m" */
const left = (s: number) => { if (s <= 0) return 'ended'; const d = Math.floor(s / 86_400), h = Math.floor((s % 86_400) / 3_600), m = Math.ceil((s % 3_600) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
const reward = (r: CampaignRow) => [r.rewardChips ? `${fmt(r.rewardChips)} ${r.free ? 'bonus ' : ''}chip${r.rewardChips === 1 ? '' : 's'}` : '', r.rewardFaith ? `${r.rewardFaith} FAITH` : ''].filter(Boolean).join(' + ');
/** a banner, or a drawn one in the colours of its kind when there is none */
const bannerHtml = (r: { banner?: string | null; kind: number; project?: string; title: string }) => r.banner
  ? `<div class="qp-banner"><img src="${esc(r.banner)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('ph');this.remove()"></div>`
  : `<div class="qp-banner ph k${r.kind}"><b>${esc((r.project || r.title).trim().charAt(0).toUpperCase())}</b></div>`;
/** one campaign as a page of the book; also the Commission Desk's preview */
function campaignPage(r: CampaignRow, preview = false): string {
  const now = Date.now() / 1000, ends = r.endsAt ?? 0, over = !r.active || (ends > 0 && now >= ends), spots = Math.max(0, r.maxClaims - r.claims), machine = r.kind === 2;
  const stamp = r.claimed ? '<i class="qp-stamp ok">CLAIMED</i>' : over ? '<i class="qp-stamp">ENDED</i>' : '';
  const steps = r.steps?.length ? r.steps : machine ? [`Go to machine #${r.machineId} on Founders' Row`, `Play it ${r.goal} time${r.goal === 1 ? '' : 's'}`, 'Come back and claim'] : [r.kind === 0 ? 'Open the link and do the task' : 'Open the link and look around', 'Come back after a moment', 'Claim: Father Nakamoto signs it'];
  const act = preview ? `<button class="qp-do" disabled>${KIND_DO[r.kind]}</button><button class="qp-claim" disabled>CLAIM</button>`
    : r.mine ? (r.active ? `<button class="qp-do dark" data-close="${r.id}">CLOSE IT<small>the rest comes back</small></button>` : r.refund ? `<button class="qp-do" data-close="${r.id}">COLLECT<small>${fmt(r.refund)} chips</small></button>` : '<button class="qp-do" disabled>CLOSED</button>')
    : r.claimed || over ? '' : machine ? `<button class="qp-do" data-machine="${r.machineId}">GO TO THE MACHINE<small>${Math.min(r.progress, r.goal)} of ${r.goal} played</small></button><button class="qp-claim" data-claim="${r.id}" ${r.progress >= r.goal ? '' : 'disabled'}>CLAIM</button>`
    : `<button class="qp-do" data-go="${r.id}">${KIND_DO[r.kind]}<small>${esc(hostOf(r.url))}</small></button><button class="qp-claim" data-claim="${r.id}" disabled>CLAIM<small>do the task first</small></button>`;
  return `<article class="qp k${r.kind} ${over ? 'over' : ''}" data-page="${r.id}">${stamp}
    ${bannerHtml(r)}
    <div class="qp-head"><span class="ktag k${r.kind}">${KIND_TAG[r.kind]}</span><small>${r.mine && !preview ? 'YOUR CAMPAIGN' : `by ${esc(r.project || (r.free ? 'the Church' : 'a player'))}`}</small></div>
    <h3>${esc(r.title)}</h3>
    <div class="qp-reward"><small>YOU GET</small><b>${reward(r) || '&mdash;'}</b><em>${r.rewardChips ? (r.free ? 'bonus chips: for playing; what they win is yours' : 'real chips: yours to keep or cash out') : 'FAITH grows your blessings'}</em></div>
    <div class="qp-meta"><span><b>${spots}</b> of ${r.maxClaims} spot${r.maxClaims === 1 ? '' : 's'} left</span><span>${ends ? (over ? 'ENDED' : `ends in <b>${left(ends - now)}</b>`) : 'no end date'}</span></div>
    ${r.description ? `<p class="qp-desc">${esc(r.description)}</p>` : ''}
    <ol class="qp-steps">${steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>
    <div class="qp-act">${act}</div></article>`;
}
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

function missions(root: Root, close: () => void) {
  shell(root, close, 'church', 'QUEST BOARD', `
    <div class="qb">
      <div class="qb-book" id="book" tabindex="0" aria-label="The Quest Board, a book: swipe or use the arrows to turn pages"><div class="qb-page l" id="pl"></div><div class="qb-spine"></div><div class="qb-page r" id="pr"></div></div>
      <div class="qb-nav"><button class="qb-turn" id="prev" aria-label="Previous page">&#9664;</button><span id="pgno"></span><button class="qb-turn" id="next" aria-label="Next page">&#9654;</button></div>
    </div>`);
  const book = $(root, '#book'), timers: number[] = [];
  let pages: string[] = [], rows: CampaignRow[] = [], at = 0;
  const two = () => book.clientWidth >= 540;
  // the built-in quests: the book's first page
  const questPage = () => `<article class="qp quests"><div class="qp-banner ph church"><b>&#10013;</b></div><div class="qp-head"><span class="ktag">THE CHURCH</span><small>for every wanderer</small></div><h3>The Church's Quests</h3>
    <div class="qq">${QUESTS.map(q => { const v = Math.min(q.goal, store.stats[q.counter]), claimed = !!store.stats.claimed[q.id], open = v >= q.goal && !claimed;
      return `<div class="qq-row ${claimed ? 'done' : open ? 'ready' : ''}"><div><b>${q.title}</b><small>${q.desc}</small><div class="qbar"><i style="width:${(v / q.goal) * 100}%"></i></div></div><button data-q="${q.id}" ${open ? '' : 'disabled'}>${claimed ? '&#10003;' : open ? 'CLAIM' : `${Math.floor(v)}/${q.goal}`}<small>${q.rewardText}</small></button></div>`; }).join('')}</div></article>`;
  const blank = (t: string) => `<article class="qp blank"><p>${t}</p></article>`;
  const build = () => {
    const now = Date.now() / 1000, live = (r: CampaignRow) => r.active && !(r.endsAt && now >= r.endsAt) && !r.claimed;
    const order = [...rows.filter(r => live(r) && !r.mine), ...rows.filter(r => r.mine), ...rows.filter(r => !live(r) && !r.mine)];
    pages = [questPage(), ...order.map(r => campaignPage(r))];
    if (pages.length === 1) pages.push(blank('No campaigns on the board yet.<br><br>Projects and players commission them at the Commission Desk in the Scriptorium.'));
  };
  const show = (dir = 0) => {
    const n = two() ? 2 : 1; at = Math.max(0, Math.min(at, pages.length - 1)); if (n === 2) at -= at % 2;
    $(root, '#pl').innerHTML = pages[at] ?? ''; $(root, '#pr').innerHTML = n === 2 ? (pages[at + 1] ?? blank('&mdash; the end &mdash;')) : '';
    book.classList.toggle('one', n === 1);
    $(root, '#pgno').textContent = n === 2 ? `PAGES ${at + 1}-${Math.min(at + 2, pages.length)} OF ${pages.length}` : `PAGE ${at + 1} OF ${pages.length}`;
    ($(root, '#prev') as HTMLButtonElement).disabled = at === 0; ($(root, '#next') as HTMLButtonElement).disabled = at + n >= pages.length;
    if (dir) { book.classList.remove('turn-next', 'turn-prev'); void book.offsetWidth; book.classList.add(dir > 0 ? 'turn-next' : 'turn-prev'); audio.play('hit', 0.2); }
    wire();
  };
  const turn = (d: number) => { const n = two() ? 2 : 1, to = at + d * n; if (to < 0 || to >= pages.length) return; at = to; show(d); };
  $(root, '#prev').addEventListener('click', () => turn(-1)); $(root, '#next').addEventListener('click', () => turn(1));
  book.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') turn(-1); if (e.key === 'ArrowRight') turn(1); });
  // a swipe on either page turns it
  let sx = 0, sy = 0, st = 0;
  book.addEventListener('pointerdown', (e) => { sx = e.clientX; sy = e.clientY; st = Date.now(); });
  book.addEventListener('pointerup', (e) => { const dx = e.clientX - sx, dy = e.clientY - sy; if (Date.now() - st < 700 && Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.4) turn(dx < 0 ? 1 : -1); });
  window.addEventListener('resize', () => { if (root.isConnected) show(); });
  const load = async () => {
    try { rows = backend.campaigns ? await backend.campaigns() : []; } catch (e) { rows = []; bus.emit('toast', errText(e)); }
    build(); show();
  };
  const wire = () => {
    $$(book, '[data-q]').forEach(b => b.addEventListener('click', async () => {
      const q = QUESTS.find(x => x.id === b.dataset.q)!; if ((b as HTMLButtonElement).disabled) return;
      try { await pending(b, () => backend.claimQuest(q.id)); setBal(root); build(); show(); showResult(root, 'win', 'QUEST COMPLETE', q.rewardText, q.title + (q.reward.chips ? '. Play them: what they win is yours.' : '')); } catch (e) { oops(root, e); }
    }));
    $$(book, '[data-go]').forEach(b => b.addEventListener('click', async () => {
      const id = +b.dataset.go!, row = rows.find(r => r.id === id)!;
      if (!confirm(`This opens a page outside the game:\n${row.url}\n\nThe Church checked the link, but never sign anything there.`)) return;
      window.open(row.url, '_blank', 'noopener');
      try {
        const { visitS } = await pending(b, () => backend.startCampaign!(id));
        const cb = book.querySelector<HTMLButtonElement>(`[data-claim="${id}"]`); if (!cb) return; let s = visitS;
        const t = window.setInterval(() => { if (!cb.isConnected) return clearInterval(t); s--; if (s > 0) { cb.innerHTML = `CLAIM<small>in ${s}s</small>`; return; } clearInterval(t); cb.disabled = false; cb.innerHTML = 'CLAIM<small>the Father signs</small>'; cb.classList.add('ready'); }, 1000);
        timers.push(t); cb.innerHTML = `CLAIM<small>in ${s}s</small>`;
      } catch (e) { oops(root, e); }
    }));
    $$(book, '[data-machine]').forEach(b => b.addEventListener('click', () => { const plot = Object.entries(store.plots).find(([, p]) => p.id === +b.dataset.machine!)?.[0]; close(); if (plot) window.setTimeout(() => (window as any).cnc?.go(`plot-${plot}`), 250); }));
    $$(book, '[data-claim]').forEach(b => b.addEventListener('click', async () => {
      if ((b as HTMLButtonElement).disabled) return; const id = +b.dataset.claim!;
      try { const r = await pending(b, () => backend.claimCampaign!(id)); setBal(root); showResult(root, 'win', 'BLESSED', [r.chips ? `+${r.chips}` : '', r.faith ? `+${r.faith} FAITH` : ''].filter(Boolean).join(' '), 'Campaign complete'); await load(); } catch (e) { oops(root, e); }
    }));
    $$(book, '[data-close]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Close this campaign? What is left of its budget comes back to you.')) return;
      try { await pending(b, () => backend.closeCampaign!(+b.dataset.close!)); setBal(root); await load(); } catch (e) { oops(root, e); }
    }));
  };
  build(); show(); void load();
}

// ---------------------------------------------------------------------------------------------- ALTAR (+ Harmony)
function altar(root: Root, close: () => void) {
  const build = () => {
    shell(root, close, 'church', 'ALTAR OF FORTUNE', `
    <div class="alt">
      <div class="alt-meters" id="mt"></div>
      <div class="alt-act">
        <div class="g-lab">OFFER LUCK &rarr; FAITH (${PARAMS.offerRatioBps / 100}%)</div>
        <div class="cs-row" style="width:100%"><button class="g-key" data-o="10">OFFER 10</button><button class="g-key" data-o="25">OFFER 25</button></div>
        <button class="g-key dark" data-o="all" style="width:100%">OFFER ALL MY LUCK</button>
        <button class="g-go gold wide" id="hw"><span>HARMONY WHEEL</span></button>
      </div>
    </div>`);
    const show = () => {
      const ok = store.eco.luck >= 50 && store.eco.faith >= 50;
      $(root, '#mt').innerHTML = meter('luck', store.eco.luck, 50) + meter('faith', store.eco.faith, 50) + `<div class="hz ${ok ? 'on' : ''}">${ok ? '&#10022; HARMONY &#10022; THE WHEEL IS OPEN' : 'HARMONY: BOTH METERS PAST THE PINK LINE'}</div>`;
      setBal(root);
    };
    show();
    $$(root, '[data-o]').forEach(b => b.addEventListener('click', async () => {
      const n = b.dataset.o === 'all' ? Math.floor(store.eco.luck) : +b.dataset.o!;
      if (n < 1 || store.eco.luck < n) { oops(root, new BackendError('luck_low', n < 1 ? 'You have no LUCK to offer yet. Play in the Casino to fill it.' : `You have ${Math.floor(store.eco.luck)} LUCK.`)); return; }
      $$(root, '[data-o]').forEach(x => ((x as HTMLButtonElement).disabled = true));
      try { const r = await pending(b, () => backend.offerLuck(n)); show(); audio.play('hit', 0.4); showResult(root, 'win', 'OFFERING ACCEPTED', `+${r.faithGain.toFixed(1)} FAITH`, `${n} LUCK given at the altar`); }
      catch (e) { oops(root, e); }
      finally { $$(root, '[data-o]').forEach(x => ((x as HTMLButtonElement).disabled = false)); }
    }));
    $(root, '#hw').addEventListener('click', () => harmony(root, close, build));
  };
  build();
}

// ---------------------------------------------------------------------------------------------- FOUNDERS' PLOT (deed)
function plot(root: Root, close: () => void, id: number) {
  void backend.plotsNow?.().then(() => { if (root.querySelector('.pl') && !root.querySelector('#nm')?.matches(':focus')) render(); }).catch(() => {});
  const render = () => {
    const p = store.plots[id], s = store.stats;
    if (p) {
      shell(root, close, 'casino', `PLOT #${id}`, `
      <div class="pl">
        <div class="deed dd"><i class="dd-seal">#${p.id}</i><small class="dd-k">DEED OF OWNERSHIP &middot; FOUNDERS&rsquo; ROW, PLOT ${id}</small>
          <h3 class="dd-name">${esc(p.name)}</h3>
          <div class="dd-own"><span class="skin ${p.skin}"></span>held by <b>${esc(p.owner)}</b>${p.mine ? ' <em>(you)</em>' : ''}</div>
          <div class="dd-stats"><div><small>BANKROLL</small><b>${fmt(p.bankroll)}</b><em>${p.free != null ? `${fmt(p.free)} free` : 'chips'}</em></div><div><small>SPINS</small><b>${fmt(p.plays)}</b><em>all time</em></div><div><small>EARNED</small><b class="${p.earned > 0 ? 'pos' : p.earned < 0 ? 'neg' : ''}">${p.earned > 0 ? '+' : ''}${fmt(p.earned)}</b><em>after wins paid</em></div></div>
          <p class="dd-how">Players spin against this bankroll. Their losses grow it, their wins come out of it, and 0.75% of every spin goes to the Church and the jackpot. It must keep 100 chips.</p></div>
        <div class="pl-side"><div class="g-msg">${p.mine === false ? 'Its owner pays the wins and keeps the losses. Real chips only here, and no LUCK: the house takes nothing.' : 'Your machine is live on the floor. Players\' losses grow its bankroll; wins are paid from it.'}</div>
          ${backend.mode === 'chain' ? '<button class="g-go wide" data-a="play"><span>PLAY THIS MACHINE</span></button>' : ''}
          ${p.mine === false ? '' : `<div class="cs-row" style="width:100%"><button class="g-key" data-a="fund">FUND +100</button><button class="g-key dark" data-a="take">TAKE 100</button></div>${backend.releasePlot ? '<button class="g-key dark" data-a="release" style="width:100%">CLOSE THE MACHINE</button>' : ''}`}</div>
      </div>`);
      $$(root, '[data-a]').forEach(b => b.addEventListener('click', async () => {
        const a = b.dataset.a; if (a === 'play') { slots(root, close, { plot: id, name: p.name }); return; }
        if (a === 'release' && !confirm('Close this machine? Its whole bankroll comes back to you and the plot is free again.')) return;
        try { await pending(b, () => (a === 'fund' ? backend.fundMachine(id, 100) : a === 'release' ? backend.releasePlot!(id) : backend.withdrawMachine(id, 100))); setBal(root); render(); }
        catch (e) { oops(root, e); }
      }));
      return;
    }
    let skin = 'gold', bankroll = plotPlayableBankroll();
    const g1 = Math.min(1, s.wagered / PLOT_GATE.wagered), g2 = Math.min(1, s.faithEarned / PLOT_GATE.faithEarned);
    shell(root, close, 'casino', `FOUNDERS' PLOT #${id}`, `
    <div class="pl">
      <div class="deed"><h4>CLAIM THIS PLOT</h4>
        <div class="gl"><span>CHIPS WAGERED</span><div class="qbar"><i style="width:${g1 * 100}%"></i></div><b>${Math.floor(s.wagered)}/${PLOT_GATE.wagered}</b></div>
        <div class="gl"><span>FAITH EARNED</span><div class="qbar"><i style="width:${g2 * 100}%"></i></div><b>${Math.floor(s.faithEarned)}/${PLOT_GATE.faithEarned}</b></div>
        <input id="nm" maxlength="16" placeholder="Name your machine" autocomplete="off" />
        <div class="row">${MACHINE_SKINS.map(k => `<button class="skin ${k} ${k === skin ? 'sel' : ''}" data-k="${k}" aria-label="${k}"></button>`).join('')}</div></div>
      <div class="pl-side"><div class="g-lab">STARTING BANKROLL</div>${chipRow(bankroll, [1, 1.5, 2].map(k => Math.round(plotPlayableBankroll() * k)), 'bk')}<div class="g-msg" style="font-size:10px">At least ${fmt(plotPlayableBankroll())}: a ${Math.min(...TABLE.bets)}-chip spin can pay 100x.</div>
        <div class="g-msg">Claiming writes your deed on chain and puts your own slot machine on the floor. Players spin against your bankroll.</div>
        <button class="g-go gold wide" id="claim"><span>CLAIM PLOT</span></button></div>
    </div>`);
    wireChips(root, v => (bankroll = v), () => false, 'bk');
    $$(root, '.skin').forEach(b => b.addEventListener('click', () => { skin = b.dataset.k!; $$(root, '.skin').forEach(x => x.classList.toggle('sel', x === b)); }));
    $(root, '#claim').addEventListener('click', async () => {
      const cb = $(root, '#claim');
      try { await pending(cb, () => backend.claimPlot(id, ($(root, '#nm') as HTMLInputElement).value, skin, bankroll)); audio.play('roulette', 0.5); render(); showResult(root, 'jackpot', 'DEED MINTED', store.plots[id]!.name, 'Your machine is on the floor'); }
      catch (e) { oops(root, e); }
    });
  };
  render();
}

// ---------------------------------------------------------------------------------------------- HOW CHIPS WORK
function guide(root: Root, close: () => void) {
  try { localStorage.setItem('cnc.guide.seen', '1'); } catch { /* */ } document.body.classList.remove('guide-new');
  const e = store.eco;
  shell(root, close, 'plaza' as any, 'YOUR CHIPS, LUCK AND FAITH', `
  <div class="gd">
    <div class="gd-c real"><i>&#9679;</i><b>CHIPS</b><strong>${fmt(e.chips)}</strong><p>Real money for the game: bought with SOL at the Cashier (1 SOL = 1,000 chips). Cash them out any time.</p></div>
    <div class="gd-c bonus"><i>&#10022;</i><b>BONUS CHIPS</b><strong>${fmt(e.bonus)}</strong><p>Gifts: the welcome, the wheels, quests and alms. Bets use them first. They cannot be cashed out, but <em>what they win is real</em>.</p></div>
    <div class="gd-c luck"><i>&#9827;</i><b>LUCK</b><strong>${Math.floor(e.luck)}<small>/100</small></strong><p>Fills as you bet real chips in the Casino. At 100 the Wheel of Fortune is yours to spin. It fades while you are in the Church.</p></div>
    <div class="gd-c faith"><i>&#10013;</i><b>FAITH</b><strong>${Math.floor(e.faith)}<small>/100</small></strong><p>Grows with candles, tithes, the altar and quests. It adds a blessing of up to +3% to every Casino win. It fades while you are in the Casino.</p></div>
  </div>
  <div class="gd-more"><span><b>HARMONY</b> LUCK and FAITH both at 50 open the Harmony Wheel at the Crossroads.</span><span><b>HAPPY HOUR</b> Don Fortuna doubles blessings for a while.</span><span><b>VIGIL</b> Father Nakamoto makes candles and tithes worth more.</span></div>
  <button class="g-key dark" id="gdok" style="align-self:center;min-width:160px">GOT IT</button>`);
  $(root, '#gdok').addEventListener('click', close);
}

// ---------------------------------------------------------------------------------------------- THE AI HOSTS
const mmss = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const ACTION_NAME: Record<string, string> = {
  none: 'HOLDS STEADY', set_max_bet: 'MAX BET', set_luck_rate: 'LUCK RATE', start_happy_hour: 'HAPPY HOUR', end_happy_hour: 'ENDS HAPPY HOUR', top_up_jackpot: 'JACKPOT TOP-UP',
  grant_promo: 'PROMO', start_vigil: 'VIGIL', end_vigil: 'ENDS VIGIL', grant_alms: 'ALMS', set_blessing_cap: 'BLESSINGS', set_candle_faith: 'CANDLE FAITH',
};
const actionTxt = (d: AgentDecision) => {
  const p = d.params; const v = Object.values(p)[0];
  if (d.action === 'start_happy_hour' || d.action === 'start_vigil') return `${ACTION_NAME[d.action]} · +${p.boost_pct}% · ${p.minutes} MIN`;
  return v !== undefined ? `${ACTION_NAME[d.action] ?? d.action.toUpperCase()} · ${v}` : (ACTION_NAME[d.action] ?? d.action.toUpperCase());
};
const decisionRow = (d: AgentDecision) => `<button class="ai-dec ${d.agent}" data-dec="${d.id}">
  <span class="ai-when">${ago(d.at)}</span><span class="ai-act ${d.action === 'none' ? 'quiet' : ''}">${actionTxt(d)}</span>
  <q>${esc(d.line)}</q><span class="ai-sig ${d.proof ? 'ok' : ''}">${d.proof ? '&#10003; SIGNED &middot; VERIFY' : !d.applied ? 'NOT APPLIED' : d.policy === 'rules' ? 'RULE FALLBACK &middot; UNSIGNED' : 'DEMO &middot; UNSIGNED'}</span></button>`;
const emptyFeed = (who: string) => `<div class="g-msg">${who} has not made a move yet. He decides every 10 minutes (every minute or so in the demo).</div>`;
let feedCache: AgentDecision[] = [];
async function loadFeed(agent: AgentId | 'all') { feedCache = backend.agentFeed ? await backend.agentFeed(agent, 20) : []; return feedCache; }
function wireDecisions(root: Root, close: () => void, back: () => void) {
  $$(root, '[data-dec]').forEach(b => b.addEventListener('click', () => { const d = feedCache.find(x => x.id === b.dataset.dec); if (d) verifyView(root, close, back, d); }));
}

/** the verify view: re-checks a decision in the browser, step by step */
function verifyView(root: Root, close: () => void, back: () => void, d?: AgentDecision) {
  const sampleMode = !d || !d.proof;
  const proof = d?.proof ?? SAMPLE_PROOF;
  shell(root, close, 'plaza' as any, 'VERIFY A DECISION', `
  <div class="vf">
    <div class="vf-l">
      ${sampleMode && d ? `<div class="vf-note">${d.reason ? `<b>${esc(d.reason)}.</b> ` : ''}This decision came from the offline demo or the rule fallback, so it was never signed. Below is a <b>real</b> decision Don Fortuna made on NEAR AI Cloud on ${new Date(SAMPLE_PROOF.attestationAt).toUTCString().slice(5, 16)}, checked live in your browser.</div>` : ''}
      ${d && !sampleMode ? `<div class="vf-line ${d.agent}"><b>${d.agent === 'fortuna' ? 'DON FORTUNA' : 'FATHER NAKAMOTO'}</b><q>${esc(d.line)}</q></div>` : ''}
      <div class="g-lab" style="text-align:left">WHAT THE AI ACTUALLY ANSWERED</div><pre class="vf-raw" id="raw"></pre>
      <div class="vf-meta"><span>MODEL <b>${proof.model}</b></span><span>SIGNER <b>${proof.signingAddress.slice(0, 10)}&hellip;${proof.signingAddress.slice(-6)}</b></span>${d?.anchorTx && backend.l1Url ? `<span>L1 RECORD <a class="txl" href="${backend.l1Url(d.anchorTx)}" target="_blank" rel="noopener">${d.anchorTx.slice(0, 4)}&hellip;${d.anchorTx.slice(-3)} &#8599;</a></span>` : ''}${proof.txHash ? `<span>ACTED ${txLink(proof.txHash)}</span>` : ''}</div>
    </div>
    <div class="vf-r">
      <div class="g-lab">CHECKED IN YOUR BROWSER</div>
      <div class="vf-checks" id="checks"></div>
      <div class="vf-verdict" id="verdict"></div>
      <div class="cs-row"><button class="g-key" id="again">CHECK AGAIN</button><button class="g-key dark" id="bk">BACK</button></div>
    </div>
  </div>`);
  const run = async () => {
    const r = verifyProof(proof);
    if (d && !sampleMode && backend.checkAnchor) { const a = await backend.checkAnchor(d).catch(() => ({ label: 'Written on Solana before it acted', ok: false, detail: 'could not reach Solana' })); r.checks.push(a); r.ok &&= a.ok; }
    try { $(root, '#raw').textContent = JSON.stringify(JSON.parse(r.reply), null, 2); } catch { $(root, '#raw').textContent = r.reply; }
    const box = $(root, '#checks'); box.innerHTML = ''; $(root, '#verdict').className = 'vf-verdict'; $(root, '#verdict').textContent = '';
    r.checks.forEach((c, i) => setTimeout(() => {
      box.insertAdjacentHTML('beforeend', `<div class="vf-c ${c.ok ? 'ok' : 'bad'}"><i>${c.ok ? '&#10003;' : '&#10007;'}</i><div><b>${c.label}</b><small>${c.detail}</small></div></div>`);
      audio.play('hit', 0.2);
      if (i === r.checks.length - 1) { const v = $(root, '#verdict'); v.className = `vf-verdict ${r.ok ? 'ok' : 'bad'}`; v.textContent = r.ok ? 'VERIFIED. Nobody edited this decision after the AI made it.' : 'NOT VERIFIED'; }
    }, 380 * (i + 1)));
  };
  void run();
  $(root, '#again').addEventListener('click', () => void run());
  $(root, '#bk').addEventListener('click', back);
}

/** the four rules, in plain words */
function honestView(root: Root, close: () => void, back: () => void) {
  shell(root, close, 'plaza' as any, 'HOW THE AI IS KEPT HONEST', `
  <div class="hn">
    ${[['&#9881;', 'Policy, never outcomes', 'The hosts set house rules (max bet, Happy Hours, Vigils, alms). They never touch the dice, the cards or the payout tables. Every bet is settled by verifiable randomness, and you can check it.'],
       ['&#9878;', 'Hard limits in the program', 'Every lever has bounds the Solana program enforces: steps of 25% at most, events of 10 to 60 minutes, alms only for players who really need them, daily caps on every grant. A host can only use its own tools.'],
       ['&#128274;', 'Signed in secure hardware', 'Each decision is made by a model running inside NEAR AI Cloud\'s attested hardware (Intel TDX + NVIDIA). The answer is signed there, before anyone could touch it.'],
       ['&#9939;', 'Written down before it acts', 'Each decision, with its signature, is written on Solana first. The game only does what was written there, once. Anyone can re-check any decision, like you can right here. And a human can still pause everything.']]
      .map(([i, t, d]) => `<div class="hn-c"><i>${i}</i><b>${t}</b><p>${d}</p></div>`).join('')}
  </div>
  <div class="cs-row" style="max-width:420px;margin:4px auto 0"><button class="g-key" id="sample">VERIFY A REAL DECISION</button><button class="g-key dark" id="bk">BACK</button></div>`);
  $(root, '#sample').addEventListener('click', async () => { const live = (await loadFeed('all').catch(() => [] as AgentDecision[])).find(x => x.proof && x.applied); verifyView(root, close, () => honestView(root, close, back), live); });
  $(root, '#bk').addEventListener('click', back);
}

/** Don Fortuna's CCTV wall: the house, live */
function monitor(root: Root, close: () => void) {
  let timer = 0;
  const render = async () => {
    window.clearInterval(timer);
    const [st, ev, feed] = await Promise.all([backend.houseStats?.(), backend.activeEvents?.() ?? Promise.resolve([] as RealmEvent[]), loadFeed('fortuna')]);
    const hh = ev.find(e => e.kind === 'happy_hour');
    const tug = st ? (st.inCasino + st.inChurch ? Math.round((st.inCasino / (st.inCasino + st.inChurch)) * 100) : 50) : 50;
    shell(root, close, 'casino', 'HOUSE MONITOR', `
    <div class="mon">
      <div class="mon-wall">
        <div class="crt"><small>VAULT</small><b>${st ? fmt(st.vault) : '--'}</b><div class="crt-bar"><i style="width:${st ? Math.max(4, Math.min(100, (st.vaultFree / Math.max(1, st.vault)) * 100)) : 0}%"></i></div><em>${st ? fmt(st.vaultFree) : '--'} FREE</em></div>
        <div class="crt"><small>TODAY</small><b class="${st && st.houseNet24h < 0 ? 'neg' : ''}">${st ? (st.houseNet24h >= 0 ? '+' : '') + fmt(st.houseNet24h) : '--'}</b><em>HOUSE NET &middot; ${st ? fmt(st.volume24h) : '--'} WAGERED</em><em>EDGE ${st ? (st.edgeRealized24h * 100).toFixed(1) : '--'}% / ${st ? (st.edgeExpected * 100).toFixed(1) : '--'}% EXPECTED</em></div>
        <div class="crt"><small>THE FLOOR</small><b>${st ? st.playersOnline : '--'} <span>ONLINE</span></b><div class="tug"><i style="width:${tug}%"></i></div><em>CASINO ${st?.inCasino ?? '-'} &middot; CHURCH ${st?.inChurch ?? '-'}</em></div>
        <div class="crt amber"><small>HOUSE RULES</small><b>MAX ${st ? st.maxBet : '--'}</b><em>LUCK ${st ? (st.luckPerChipMilli / 1000).toFixed(2) : '--'} PER CHIP</em><em class="${hh ? 'live' : ''}">${hh ? `HAPPY HOUR &middot; BLESSINGS &times;2 &middot; <span id="hh">${mmss(hh.endsAt - Date.now())}</span>` : 'NO HAPPY HOUR'}</em></div>
        <div class="crt"><small>BIGGEST WIN TODAY</small><b>${st?.biggestWin24h ? fmt(st.biggestWin24h.chips) : '--'}</b><em>${st?.biggestWin24h ? `${st.biggestWin24h.name} &middot; ${GAME_NAME[st.biggestWin24h.game] ?? st.biggestWin24h.game}` : 'NO WINNER YET'}</em></div>
        <div class="crt amber"><small>JACKPOT POOL</small><b>${st ? fmt(st.jackpot) : '--'}</b><em>HARMONY WHEEL &middot; CROSSROADS</em></div>
      </div>
      <div class="mon-feed"><div class="g-lab">DON FORTUNA'S DECISIONS</div><div class="ai-list">${feed.length ? feed.map(decisionRow).join('') : emptyFeed('Don Fortuna')}</div>
        <button class="g-key dark" id="honest">HOW THE AI IS KEPT HONEST</button></div>
    </div>`);
    wireDecisions(root, close, render);
    $(root, '#honest').addEventListener('click', () => { window.clearInterval(timer); honestView(root, close, render); });
    timer = window.setInterval(() => { if (!root.isConnected || !root.querySelector('.mon')) return clearInterval(timer); const el = root.querySelector('#hh'); if (el && hh) el.textContent = mmss(hh.endsAt - Date.now()); }, 1000);
  };
  void render();
  const onDec = () => { if (root.isConnected && root.querySelector('.mon')) void render(); else bus.off('agentDecision', onDec); };
  bus.on('agentDecision', onDec);
}

/** Father Nakamoto's ledger: the Church, live */
function ledger(root: Root, close: () => void) {
  const render = async () => {
    const [st, ev, feed] = await Promise.all([backend.churchStats?.(), backend.activeEvents?.() ?? Promise.resolve([] as RealmEvent[]), loadFeed('nakamoto')]);
    const vg = ev.find(e => e.kind === 'vigil'), sermon = feed.find(d => d.line)?.line;
    shell(root, close, 'church', 'THE LEDGER', `
    <div class="ldg">
      <div class="ldg-page">
        <h4>THE TREASURY</h4><div class="ldg-big">${st ? fmt(st.treasury) : '--'} <small>CHIPS</small></div>
        ${[['Tithes today', st?.tithes24h], ['Candles lit', st?.candles24h], ['Alms given', st?.alms24h], ['Blessings paid', st?.blessingsPaid24h]].map(([k, v]) => `<div class="ldg-row"><span>${k}</span><i></i><b>${v === undefined ? '--' : fmt(Number(v))}</b></div>`).join('')}
        <div class="ldg-row"><span>Blessing budget</span><i></i><b>${st ? (st.blessingCapBps / 100).toFixed(1) + '%' : '--'}</b></div>
        <div class="ldg-row"><span>FAITH per candle</span><i></i><b>${st ? (st.candleFaithMilli / 1000).toFixed(1) : '--'}</b></div>
        <div class="ldg-vigil ${vg ? 'live' : ''}">${vg ? `VIGIL &middot; FAITH +${vg.boostBps / 100}% &middot; ENDS IN ${mmss(vg.endsAt - Date.now())}` : 'NO VIGIL TONIGHT'}</div>
      </div>
      <div class="ldg-page">
        <h4>THE SERMON</h4><blockquote>${sermon ?? 'The Father has not spoken yet. He writes in this ledger every ten minutes.'}</blockquote>
        <div class="ai-list">${feed.length ? feed.slice(0, 6).map(decisionRow).join('') : ''}</div>
        <button class="g-key dark" id="honest">HOW THE AI IS KEPT HONEST</button>
      </div>
    </div>`);
    wireDecisions(root, close, render);
    $(root, '#honest').addEventListener('click', () => honestView(root, close, render));
  };
  void render();
}

/** the Crossroads board: the two hosts, side by side, and who holds the crowd */
function board(root: Root, close: () => void) {
  let timer = 0;
  const render = async () => {
    window.clearInterval(timer);
    const [ev, feed, hs] = await Promise.all([backend.activeEvents?.() ?? Promise.resolve([] as RealmEvent[]), loadFeed('all'), backend.houseStats?.()]);
    const side = (a: AgentId) => {
      const e = ev.find(x => x.by === a), mine = feed.filter(d => d.agent === a);
      return `<div class="bd-side ${a}"><div class="bd-who">${a === 'fortuna' ? 'DON FORTUNA' : 'FATHER NAKAMOTO'}<small>${a === 'fortuna' ? 'THE CASINO' : 'THE CHURCH'}</small></div>
        <div class="bd-ev ${e ? 'live' : ''}">${e ? `${e.kind === 'happy_hour' ? 'HAPPY HOUR &middot; BLESSINGS &times;2' : `VIGIL &middot; FAITH +${e.boostBps / 100}%`}<b data-end="${e.endsAt}">${mmss(e.endsAt - Date.now())}</b>` : 'NO EVENT RIGHT NOW'}</div>
        <div class="ai-list">${mine.length ? mine.slice(0, 3).map(decisionRow).join('') : emptyFeed(a === 'fortuna' ? 'Don Fortuna' : 'Father Nakamoto')}</div></div>`;
    };
    const c = hs?.inCasino ?? 0, h = hs?.inChurch ?? 0, pct = c + h ? Math.round((c / (c + h)) * 100) : 50;
    shell(root, close, 'plaza' as any, 'THE WORD AT THE CROSSROADS', `
    <div class="bd">
      <div class="bd-tug"><span>CASINO ${c}</span><div class="tug big"><i style="width:${pct}%"></i></div><span>${h} CHURCH</span></div>
      <div class="bd-cols">${side('fortuna')}<div class="bd-vs">VS</div>${side('nakamoto')}</div>
      <div class="cs-row" style="max-width:440px;margin:0 auto"><button class="g-key dark" id="honest">HOW THE AI IS KEPT HONEST</button><button class="g-key" id="sample">VERIFY A REAL DECISION</button></div>
    </div>`);
    wireDecisions(root, close, render);
    $(root, '#honest').addEventListener('click', () => { window.clearInterval(timer); honestView(root, close, render); });
    $(root, '#sample').addEventListener('click', () => { window.clearInterval(timer); verifyView(root, close, render); });
    timer = window.setInterval(() => { if (!root.querySelector('.bd')) return clearInterval(timer); $$(root, '[data-end]').forEach(b => (b.textContent = mmss(Number(b.dataset.end) - Date.now()))); }, 1000);
  };
  void render();
}

// ---------------------------------------------------------------------------------------------- PLACES (fast travel)
/** every location in the world, set by main.ts once the world is built */
export interface PlaceRow { id: string; kind: string; label: string; realm: 'casino' | 'plaza' | 'church' }
let PLACES: PlaceRow[] = [];
export function setPlaces(rows: PlaceRow[]) { PLACES = rows; }
function places(root: Root, close: () => void) {
  const group = (realm: PlaceRow['realm'], title: string) => {
    const rows = PLACES.filter(p => p.realm === realm);
    return `<div class="pl-group"><div class="g-lab">${title}</div><div class="pl-list">${rows.map(p => `<button class="g-key dark" data-place="${p.id}" aria-label="Go to ${esc(p.label)}">${esc(p.label)}</button>`).join('')}</div></div>`;
  };
  shell(root, close, 'plaza' as any, 'PLACES', `
    <div class="pl-wrap">
      <p class="g-msg">Walk anywhere, or jump straight to a place: it opens as soon as you arrive.</p>
      ${group('casino', 'THE CASINO')}${group('plaza', 'THE CROSSROADS')}${group('church', 'THE CHURCH')}
    </div>`);
  $$(root, '[data-place]').forEach(b => b.addEventListener('click', () => { const id = b.dataset.place!; close(); bus.emit('travel', id); }));
}

// ---------------------------------------------------------------------------------------------- THE COMMISSION DESK
async function myOwnerId(): Promise<string> {
  if (backend.wallet) { try { return (await backend.wallet()).accountId; } catch { /* no wallet yet */ } }
  return store.profile?.username ?? 'you';
}
const KINDS = [
  { t: 'SOCIAL', d: 'Follow, join or share: X, Discord, Telegram.', check: 'Father Nakamoto confirms each visit' },
  { t: 'PROJECT', d: 'Visit your site, read your docs, try your product.', check: 'Father Nakamoto confirms each visit' },
  { t: 'MACHINE', d: 'Players spin your machine on Founders’ Row.', check: 'Checked on chain from their spins' },
];
/** a banner as a data URL: as it is when it is small enough, otherwise redrawn as a JPEG no wider than 1200 */
async function bannerData(f: File): Promise<string> {
  const read = (b: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(b); });
  if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) throw new BackendError('bad_campaign', 'Use a PNG, JPEG, WebP or GIF.');
  if (f.size <= 1_400_000) return read(f);
  const img = await createImageBitmap(f), k = Math.min(1, 1200 / img.width), c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height); const out = c.toDataURL('image/jpeg', 0.85);
  if (out.length * 0.75 > 1_500_000) throw new BackendError('bad_campaign', 'That image is too large even when shrunk. Try a smaller one.'); return out;
}
function commission(root: Root, close: () => void) {
  if (!backend.createCampaign) { shell(root, close, 'church', 'THE COMMISSION DESK', '<p class="g-msg">The desk is closed in this mode.</p>'); return; }
  shell(root, close, 'church', 'THE COMMISSION DESK', `
    <div class="cd">
      <div class="g-tabs" id="ctabs"><button class="on" data-t="new">NEW CAMPAIGN</button><button data-t="mine">YOUR CAMPAIGNS</button></div>
      <div class="cd-pane" id="cpane"></div>
    </div>`);
  const pane = $(root, '#cpane'), L = CAMPAIGN_LIMITS;
  let tab = 'new', kind = 0, banner: string | null = null;
  const form = async () => {
    const owner = await myOwnerId(); if (tab !== 'new') return;
    const machines = Object.values(store.plots).filter(p => p.mine ?? p.owner === owner);
    pane.innerHTML = `<form class="cd-grid" id="cf" novalidate>
      <div class="cd-form">
        <section><h4><i>1</i>WHAT KIND OF CAMPAIGN</h4><div class="cd-kinds">${KINDS.map((k, i) => `<button type="button" class="cd-kind ${i === kind ? 'on' : ''}" data-k="${i}" ${i === 2 && !machines.length ? 'disabled' : ''}><b>${k.t}</b><span>${k.d}</span><em>locks at least ${fmt(CAMPAIGN_MIN_BUDGET[i])} chips (${CAMPAIGN_MIN_BUDGET[i] / 1000} SOL)</em>${i === 2 && !machines.length ? '<em class="no">you need a machine on Founders’ Row</em>' : ''}</button>`).join('')}</div></section>
        <section><h4><i>2</i>THE PROJECT</h4>
          <label class="cd-f"><span>PROJECT NAME</span><input id="pn" maxlength="${DETAIL_LIMITS.project}" placeholder="Your project, or your name" autocomplete="off"></label>
          <label class="cd-drop" id="drop"><input type="file" id="bf" accept="image/png,image/jpeg,image/webp,image/gif" hidden><span id="dropt"><b>ADD A BANNER</b><small>Click or drop an image. 1200 &times; 450 looks best. PNG, JPEG, WebP or GIF, up to 1.5 MB.</small></span></label>
          <label class="cd-f"><span>DESCRIPTION <em id="dc"></em></span><textarea id="pd" maxlength="${DETAIL_LIMITS.description}" rows="3" placeholder="What is it, and why should players care?"></textarea></label>
          <label class="cd-f" id="urow"><span>LINK</span><input id="cu" maxlength="160" placeholder="https://x.com/yourproject" autocomplete="off"></label></section>
        <section><h4><i>3</i>THE TASK</h4>
          <label class="cd-f"><span>TITLE: WHAT PLAYERS DO</span><input id="ct" maxlength="60" placeholder="Follow us on X" autocomplete="off"></label>
          <div class="cd-f" id="mrow" hidden><span>MACHINE AND SPINS</span><div class="cd-two"><select id="cm">${machines.map(m => `<option value="${m.id}">#${m.id} ${esc(m.name)}</option>`).join('')}</select><input id="cg" type="number" min="1" max="50" value="5" aria-label="Spins"></div></div>
          <div class="cd-f"><span>STEPS (OPTIONAL)</span>${[0, 1, 2, 3].map(i => `<input class="cd-step" maxlength="${DETAIL_LIMITS.step}" placeholder="${['Open our page', 'Follow the account', 'Come back here', ''][i] ? `${i + 1}. ${['Open our page', 'Follow the account', 'Come back here', ''][i]}` : `${i + 1}.`}" autocomplete="off">`).join('')}</div></section>
        <section><h4><i>4</i>REWARDS AND LENGTH</h4>
          <div class="cd-nums"><label><span>CHIPS EACH</span><input id="cc" type="number" min="0" max="${L.maxRewardChips}" value="25"></label><label><span>FAITH EACH</span><input id="cfa" type="number" min="0" max="5" step="0.5" value="2"></label><label><span>PLAYERS</span><input id="cn" type="number" min="1" max="${L.maxClaims}" value="40"></label></div>
          <label class="cd-f"><span>RUNS FOR <b id="dv"></b></span><input id="cdays" type="range" min="1" max="30" value="7"></label>
          <p class="cd-small">When it ends, or when you close it, what was not won comes back to you.</p></section>
      </div>
      <aside class="cd-side"><div class="g-lab">HOW PLAYERS WILL SEE IT</div><div class="cd-preview" id="pv"></div>
        <div class="cd-fund" id="fund"></div><button class="g-go gold wide" type="submit" id="send"><span>LOCK AND PUBLISH</span></button></aside>
    </form>`;
    const v = (id: string) => ($(pane, id) as HTMLInputElement).value;
    const draft = (): NewCampaign => ({ kind, title: v('#ct').trim(), url: kind === 2 ? '' : v('#cu').trim(), machine_id: kind === 2 ? +v('#cm') : 0, goal: kind === 2 ? +v('#cg') : 0,
      reward_chips: Math.max(0, Math.floor(+v('#cc') || 0)), reward_faith_milli: Math.round((+v('#cfa') || 0) * 1000), max_claims: Math.max(1, Math.floor(+v('#cn') || 1)), days: +v('#cdays') });
    const details = (): CampaignDetails => ({ project: v('#pn').trim(), description: v('#pd').trim(), steps: $$(pane, '.cd-step').map(i => (i as HTMLInputElement).value.trim()).filter(Boolean), banner });
    const check = () => {
      const d = draft(), dt = details(), c = campaignCost(d), min = CAMPAIGN_MIN_BUDGET[kind];
      const problem = campaignProblem(d) ?? (dt.project || dt.description ? detailsProblem(dt) : 'Name your project and describe it.');
      const enough = c.budget >= min, chipsOk = store.eco.chips >= c.total, machineOk = kind !== 2 || machines.length > 0;
      $(pane, '#dv').textContent = `${d.days} DAY${d.days === 1 ? '' : 'S'}`; $(pane, '#dc').textContent = `${dt.description.length}/${DETAIL_LIMITS.description}`;
      const row: CampaignRow = { id: 0, kind, creator: owner, title: d.title || 'Your campaign title', url: d.url || 'https://example.com', machineId: d.machine_id, goal: d.goal, rewardChips: d.reward_chips, rewardFaith: d.reward_faith_milli / 1000, maxClaims: d.max_claims, claims: 0, active: true, claimed: false, progress: 0, mine: false,
        project: dt.project || 'Your project', description: dt.description || 'Your description appears here.', steps: dt.steps, banner, endsAt: Date.now() / 1000 + d.days! * 86_400 };
      $(pane, '#pv').innerHTML = campaignPage(row, true);
      const pct = Math.min(100, (c.budget / min) * 100);
      $(pane, '#fund').innerHTML = `<div class="cd-line"><span>Rewards locked</span><b>${fmt(c.budget)}</b></div><div class="cd-min ${enough ? 'ok' : ''}"><i style="width:${pct}%"></i><small>${enough ? `above the ${fmt(min)} minimum` : `${fmt(min - c.budget)} more to reach the ${fmt(min)} minimum`}</small></div>
        <div class="cd-line"><span>Listing (10% to the Church)</span><b>${fmt(c.listing)}</b></div><div class="cd-line total"><span>YOU PAY</span><b>${fmt(c.total)} chips &middot; ${(c.total / 1000).toFixed(3)} SOL</b></div>
        <div class="cd-line ${chipsOk ? '' : 'bad'}"><span>Your chips</span><b>${fmt(store.eco.chips)}</b></div>
        ${problem ? `<p class="cd-why">${esc(problem)}</p>` : !enough ? `<p class="cd-why">Raise the chips each or the number of players.</p>` : !chipsOk ? '<p class="cd-why">Buy chips at the Cashier first. Bonus chips cannot fund a campaign.</p>' : '<p class="cd-ok">Ready. Father Nakamoto reads it, then it goes up on the Quest Board.</p>'}`;
      const send = $<HTMLButtonElement>(pane, '#send'); send.disabled = !!problem || !enough || !chipsOk || !machineOk; $(send, 'span').textContent = `LOCK ${fmt(c.total)} CHIPS AND PUBLISH`;
    };
    $$(pane, '[data-k]').forEach(b => b.addEventListener('click', () => { if ((b as HTMLButtonElement).disabled) return; kind = +b.dataset.k!; $$(pane, '[data-k]').forEach(x => x.classList.toggle('on', x === b)); ($(pane, '#urow') as HTMLElement).hidden = kind === 2; ($(pane, '#mrow') as HTMLElement).hidden = kind !== 2; audio.play('hit', 0.25); check(); }));
    pane.querySelectorAll('input, select, textarea').forEach(i => i.addEventListener('input', check));
    const take = async (f?: File | null) => { if (!f) return; try { banner = await bannerData(f); $(pane, '#dropt').innerHTML = `<img src="${banner}" alt=""><small>Click to change</small>`; check(); } catch (e) { oops(root, e); } };
    $(pane, '#bf').addEventListener('change', (e) => void take((e.target as HTMLInputElement).files?.[0]));
    const drop = $(pane, '#drop'); drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); }); drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); void take((e as DragEvent).dataTransfer?.files?.[0]); });
    check();
    $(pane, '#cf').addEventListener('submit', async (e) => {
      e.preventDefault(); const d = draft(), p = campaignProblem(d) ?? detailsProblem(details()); if (p) { oops(root, new BackendError('bad_campaign', p)); return; }
      const veil = document.createElement('div'); veil.className = 'cm-veil';
      veil.innerHTML = `<div class="ch-face"><div class="spr idle" style="${spriteCss('m_monk', 'idle_down', 4)}"></div></div><b>FATHER NAKAMOTO</b><span>is reading your campaign&hellip;</span><i class="mk-spin"></i>`;
      root.querySelector('.gm')!.append(veil);
      try { const [id] = await Promise.all([backend.createCampaign!(d, details()), sleep(1800)]); veil.remove(); setBal(root); banner = null; showResult(root, 'win', 'PUBLISHED', `#${id}`, 'The Father blessed it. It is on the Quest Board now.'); switchTab('mine'); }
      catch (err) { veil.remove(); showResult(root, 'push', 'THE FATHER REFUSED', '', errText(err)); }
    });
  };
  const mine = async () => {
    pane.innerHTML = '<div class="g-msg">Reading the ledger...</div>';
    let rows: CampaignRow[] = [];
    try { rows = (await backend.campaigns?.()) ?? []; } catch (e) { if (tab === 'mine') pane.innerHTML = `<div class="g-msg">${errText(e)}</div>`; return; }
    if (tab !== 'mine') return; const own = rows.filter(r => r.mine);
    pane.innerHTML = own.length ? `<div class="cd-mine">${own.map(r => `<div class="cd-mrow">${bannerHtml(r)}<div><b>${esc(r.title)}</b><small>${KIND_TAG[r.kind]} &middot; ${r.claims} of ${r.maxClaims} done &middot; ${r.rewardChips} chips${r.rewardFaith ? ` + ${r.rewardFaith} FAITH` : ''} each${r.active ? (r.endsAt ? ` &middot; ends in ${left(r.endsAt - Date.now() / 1000)}` : '') : ' &middot; CLOSED'}</small><div class="qbar"><i style="width:${(r.claims / r.maxClaims) * 100}%"></i></div></div>
      ${r.active ? `<button class="g-key dark" data-close="${r.id}">CLOSE</button>` : r.refund ? `<button class="g-key" data-close="${r.id}">COLLECT ${fmt(r.refund)}</button>` : '<span class="cd-closed">CLOSED</span>'}</div>`).join('')}</div>` : '<div class="g-msg">You have not commissioned a campaign yet.</div>';
    $$(pane, '[data-close]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Close this campaign? What is left of its budget comes back to you.')) return;
      try { await pending(b, () => backend.closeCampaign!(+b.dataset.close!)); setBal(root); if (tab === 'mine') void mine(); } catch (e) { oops(root, e); }
    }));
  };
  const switchTab = (t: string) => { tab = t; $$(root, '#ctabs button').forEach(x => x.classList.toggle('on', x.dataset.t === t)); if (t === 'mine') void mine(); else void form(); };
  $$(root, '#ctabs button').forEach(b => b.addEventListener('click', () => { audio.play('hit', 0.25); switchTab(b.dataset.t!); }));
  void form();
}

// ---------------------------------------------------------------------------------------------- BTC EXCHANGE (UP/DOWN)
const usd = (n: number | null | undefined, dp = 2) => (n == null ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`);
const clock = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const ARROW = { up: '&#9650;', down: '&#9660;' } as const;
/** a market result line, for the result card and the toast */
const marketLine = (r: MarketResult) => r.outcome === 'void'
  ? `No price in time: your ${r.wager} chip${r.wager === 1 ? '' : 's'} came back.`
  : r.outcome === 'tie' ? `BTC held at ${usd(r.lockPrice)}: a tie, your bet came back.`
  : `BTC ${r.outcome === 'up' ? 'rose' : 'fell'} ${usd(r.lockPrice)} → ${usd(r.closePrice)}`;
/** shows a settled market bet as the big result card */
function marketVerdict(root: Root, r: MarketResult) {
  const pay = `+${r.payout % 1 ? r.payout.toFixed(1) : r.payout}`;
  const link = r.roundTx ? `<br>${txLink(r.roundTx, `SEE ROUND #${r.epoch}`)}` : '';
  if (r.outcome === 'void' || r.outcome === 'tie') showResult(root, 'push', 'BET RETURNED', pay, marketLine(r) + link);
  else if (r.payout > 0) showResult(root, 'win', 'YOU CALLED IT!', pay, `${marketLine(r)}${r.blessing ? ` · Blessing +${r.blessing}` : ''}${link}`);
  else showResult(root, 'lose', 'WRONG CALL', r.wager, marketLine(r) + link);
}
// a round can end while the panel is closed: say so on the floor
bus.on('marketSettled', (r: MarketResult) => {
  if (document.querySelector('.mk')) return;
  const head = r.outcome === 'void' || r.outcome === 'tie' ? 'BTC round: bet returned' : r.payout > 0 ? `BTC ${r.outcome.toUpperCase()}! You won ${r.payout % 1 ? r.payout.toFixed(1) : r.payout} chips` : `BTC ${r.outcome.toUpperCase()}: your ${r.side.toUpperCase()} call lost`;
  bus.emit('toast', head);
});

/** TradingView's Advanced Chart widget: BTC/USDT, 1-minute candles, dark, no toolbars (the panel is small) */
function mountTradingView(host: HTMLElement) {
  host.innerHTML = '<span class="mk-note">loading the TradingView chart…</span>';
  const wrap = document.createElement('div');
  wrap.className = 'tradingview-widget-container mk-tv';
  const inner = document.createElement('div');
  inner.className = 'tradingview-widget-container__widget';
  const s = document.createElement('script');
  s.type = 'text/javascript'; s.async = true;
  s.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  s.textContent = JSON.stringify({
    autosize: true, symbol: 'BINANCE:BTCUSDT', interval: '1', timezone: 'Etc/UTC', theme: 'dark', style: '1', locale: 'en',
    hide_top_toolbar: true, hide_side_toolbar: true, hide_legend: false, hide_volume: true, allow_symbol_change: false,
    save_image: false, calendar: false, withdateranges: false, details: false, hotlist: false,
    backgroundColor: '#02060a', gridColor: 'rgba(61, 214, 255, 0.06)', support_host: 'https://www.tradingview.com',
  });
  wrap.append(inner, s);
  host.append(wrap);
}

/** every finished round: result, prices, what was on each side, and the transactions that prove it */
async function pastRoundsView(root: Root) {
  const gm = root.querySelector('.gm'); if (!gm || gm.querySelector('.fw')) return;
  const el = document.createElement('div'); el.className = 'fw pr'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Past rounds');
  el.innerHTML = `<div class="fw-card"><h3>PAST ROUNDS</h3><div class="pr-list" id="pr" role="status">Reading the rollup...</div><div class="fw-row"><button class="g-key" data-f="more">OLDER</button><button class="g-key dark" data-f="done">DONE</button></div></div>`;
  gm.appendChild(el); const list = el.querySelector<HTMLElement>('#pr')!; let oldest: number | undefined, busy = false;
  const ago = (t: number) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`; };
  const load = async () => {
    if (busy) return; busy = true; const more = el.querySelector<HTMLButtonElement>('[data-f=more]')!; more.disabled = true;
    try {
      const rows = await backend.pastRounds!(oldest); if (!el.isConnected) return;
      if (!oldest) list.innerHTML = '<div class="pr-row head"><span>ROUND</span><span>RESULT</span><span>LOCK &rarr; CLOSE</span><span>UP</span><span>DOWN</span><span>PROOF</span></div>';
      if (!rows.length) { more.textContent = 'NO OLDER ONES'; return; }
      list.insertAdjacentHTML('beforeend', rows.map(r => `<div class="pr-row ${r.outcome}"><span>#${r.epoch} <small>${ago(r.closedAt)}</small></span><b>${r.outcome === 'up' ? `${ARROW.up} UP` : r.outcome === 'down' ? `${ARROW.down} DOWN` : r.outcome.toUpperCase()}</b><span>${r.outcome === 'void' ? 'no price in time' : `${usd(r.lock)} &rarr; ${usd(r.close)}`}</span><span>${r.up ? fmt(r.up) : '-'}</span><span>${r.down ? fmt(r.down) : '-'}</span><span>${r.tx ? txLink(r.tx, 'ROLLUP') : ''}${r.page && backend.l1Url ? ` <a class="txl" href="${backend.l1Url(r.page)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">L1 &#8599;</a>` : ''}${!r.tx && !r.page ? '&middot;' : ''}</span></div>`).join(''));
      oldest = rows[rows.length - 1].epoch; more.disabled = oldest <= 1;
    } catch (e) { list.textContent = errText(e); } finally { busy = false; }
  };
  el.addEventListener('click', (ev) => { ev.stopPropagation(); const f = (ev.target as HTMLElement).closest<HTMLElement>('[data-f]')?.dataset.f; if (f === 'more') void load(); if (f === 'done' || ev.target === el) el.remove(); });
  void load();
}

/**
 * The BTC Exchange. Two tabs: PREDICT (default) and CHART. PREDICT shows a round's whole life as three cards, left to right:
 * the one that just ENDED, the LIVE one (its price is locked, the minute is running) and the NEXT one, which takes bets.
 * When a round closes, every card moves one place left.
 */
function market(root: Root, close: () => void) {
  if (!backend.market) { shell(root, close, 'casino', 'BTC EXCHANGE', '<p class="mk-off">The exchange is closed in this mode.</p>'); return; }
  let st: MarketState | null = null, side: MarketSide = 'up', bet = 1, busy = false, alive = true, timer = 0, frame = 0, clk = 0, tab: 'p' | 'c' = 'p', shownEpoch = 0;
  const shown = new Set<number>(), placed = new Map<number, MarketCrowdBet>(), tv = backend.mode === 'chain';
  const GUIDE = 'cnc.mx.guide';
  shell(root, close, 'market' as any, 'BTC EXCHANGE', `
  <div class="mx">
    <div class="mx-top">
      <div class="mx-tabs" role="tablist"><button class="on" data-t="p" role="tab">PREDICT</button><button data-t="c" role="tab">CHART</button></div>
      <div class="mx-px"><small>BTC / USD${tv ? ' &middot; THE ORACLE' : ''}</small><b id="px">—</b></div>
    </div>
    <div class="mx-pane" id="pp">
      <div class="mx-guide" id="guide" ${localStorage.getItem(GUIDE) ? 'hidden' : ''}><b>HOW IT WORKS</b><span><i>1</i> Call <em class="u">UP</em> or <em class="d">DOWN</em> on the <b>NEXT</b> round.</span><span><i>2</i> When betting closes, its start price is <b>locked</b>.</span><span><i>3</i> One minute later the end price decides. Right call pays <b>1.9&times;</b>, a tie returns your bet.</span><button aria-label="Close the guide">&times;</button></div>
      <div class="mx-cards" id="cards"><div class="mx-slot"></div><div class="mx-slot"></div><div class="mx-slot"></div></div>
      <div class="mx-foot"><div class="mk-recent" id="recent"></div><span class="mx-crowd" id="crowd"></span>${backend.pastRounds ? '<button class="mk-all" id="past">PAST ROUNDS</button>' : ''}</div>
    </div>
    <div class="mx-pane mx-chart" id="cp" hidden><div class="mk-chart" id="chart"><canvas id="cv"></canvas><span class="mk-note" id="cvn">connecting to the price feed…</span></div>
      <div class="mx-cnote">${tv ? 'Binance BTC/USDT by <a href="https://www.tradingview.com/" target="_blank" rel="noopener nofollow">TradingView</a>. Rounds are settled by the oracle&rsquo;s BTC/USD price, which can differ from this chart by a few dollars.' : 'Demo prices, simulated in your browser.'}</div></div>
  </div>`);
  const $px = $(root, '#px'), cards = $(root, '#cards'), cv = $<HTMLCanvasElement>(root, '#cv');
  let tvMounted = false;
  const setTab = (t: 'p' | 'c') => { tab = t; $$(root, '.mx-tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t)); $(root, '#pp').hidden = t !== 'p'; $(root, '#cp').hidden = t !== 'c'; if (t === 'c' && tv && !tvMounted) { tvMounted = true; mountTradingView($(root, '#chart')); } audio.play('hit', 0.25); };
  $$(root, '.mx-tabs button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.t as 'p' | 'c')));
  $(root, '#guide button').addEventListener('click', () => { localStorage.setItem(GUIDE, '1'); $(root, '#guide').hidden = true; });
  root.querySelector('#past')?.addEventListener('click', () => void pastRoundsView(root));
  const shutdown = () => { alive = false; window.clearTimeout(timer); window.clearInterval(clk); cancelAnimationFrame(frame); bus.off('marketSettled', onSettled); };
  $(root, '[data-close]').addEventListener('click', shutdown);
  root.closest('#modal')?.addEventListener('pointerdown', (e) => { if (e.target === e.currentTarget) shutdown(); }, { once: true });
  const onSettled = (r: MarketResult) => { if (!alive || shown.has(r.betId)) return; shown.add(r.betId); setBal(root); marketVerdict(root, r); };
  bus.on('marketSettled', onSettled);

  const now = () => Date.now() + (st?.skew ?? 0);
  const mineIn = (s: MarketState, epoch?: number) => (epoch ? s.crowd[epoch]?.find(b => b.mine) ?? placed.get(epoch) : undefined);
  const pools = (up: number, down: number) => { const t = up + down, u = t ? Math.round((up / t) * 100) : 50; return `<div class="mx-pool"><div class="mx-bar"><i class="u" style="width:${u}%"></i><i class="d" style="width:${100 - u}%"></i></div><div class="mx-pl"><span class="u">${ARROW.up} ${fmt(up)}</span><span class="d">${fmt(down)} ${ARROW.down}</span></div></div>`; };
  // the clocks and their rings are filled in by `clocks()`, four times a second, so a card's HTML only changes when its content does
  const C = 2 * Math.PI * 22, ring = (cls: string) => `<svg class="mx-ring ${cls}" viewBox="0 0 50 50"><circle cx="25" cy="25" r="22" class="bg"/><circle cx="25" cy="25" r="22" class="fg" data-ring style="stroke-dasharray:${C}"/></svg>`;

  const ended = (s: MarketState) => {
    const r = s.recent[0]; if (!r) return `<section class="mx-card ended empty"><header><span>ENDED</span></header><p class="mx-dim">No round has ended yet.</p></section>`;
    const mine = s.myResults?.[r.epoch], o = r.outcome || 'void';
    const head = o === 'up' ? `${ARROW.up} UP WON` : o === 'down' ? `${ARROW.down} DOWN WON` : o === 'tie' ? '= A TIE' : 'NO PRICE';
    const d = r.lockPrice != null && r.closePrice != null ? r.closePrice - r.lockPrice : null;
    return `<section class="mx-card ended ${o}"><header><span>ENDED</span><b>#${r.epoch}</b></header>
      <div class="mx-res ${o}">${head}</div>
      ${o === 'void' ? '<p class="mx-dim">No price in time. Every bet came back.</p>' : `<div class="mx-pr"><span>START</span><b>${usd(r.lockPrice)}</b></div><div class="mx-pr"><span>END</span><b>${usd(r.closePrice)}</b></div><div class="mx-pr"><span>MOVE</span><b class="${o}">${d == null ? '—' : `${d > 0 ? '+' : d < 0 ? '−' : ''}${usd(Math.abs(d))}`}</b></div>`}
      ${pools(r.up, r.down)}
      <div class="mx-you ${mine ? (mine.payout > mine.chips ? 'won' : mine.payout === mine.chips ? 'back' : 'lost') : 'none'}">${mine ? `YOUR CALL ${ARROW[mine.side]} ${mine.side.toUpperCase()} ${fmt(mine.chips)} &middot; ${mine.payout > mine.chips ? `WON +${fmt(mine.payout)}` : mine.payout === mine.chips ? 'RETURNED' : 'LOST'}` : 'You were not in this round'}</div></section>`;
  };
  const liveCard = (s: MarketState) => {
    const L = s.live, p = s.price ?? s.oraclePrice;
    if (!L) return `<section class="mx-card live empty"><header><span>LIVE</span></header><div class="mx-arrow flat">&#9679;</div><p class="mx-dim">No round is running yet. The next one starts when betting closes.</p></section>`;
    const left = (s.open?.lockAt ?? 0) - now(), pricing = s.pending || left <= 0, d = p != null && L.lockPrice != null ? p - L.lockPrice : null, dir = d == null || d === 0 ? 'flat' : d > 0 ? 'up' : 'down';
    const my = mineIn(s, L.epoch), win = my && d != null && d !== 0 ? (d > 0) === (my.side === 'up') : null;
    return `<section class="mx-card live ${dir}"><header><span><i class="mx-dot"></i>LIVE</span><b>#${L.epoch}</b></header>
      <div class="mx-big"><div class="mx-arrow ${dir}">${dir === 'up' ? ARROW.up : dir === 'down' ? ARROW.down : '='}</div><div class="mx-delta ${dir}">${d == null ? '—' : `${d > 0 ? '+' : d < 0 ? '−' : ''}${usd(Math.abs(d))}`}<small>${d == null || !L.lockPrice ? '' : `${((Math.abs(d) / L.lockPrice) * 100).toFixed(3)}%`}</small></div></div>
      <div class="mx-pr"><span>LOCKED AT</span><b>${usd(L.lockPrice)}</b></div><div class="mx-pr"><span>NOW</span><b class="${dir}">${usd(p)}</b></div>
      <div class="mx-clock">${ring('res')}<span>${pricing ? '<i class="mk-spin"></i> TAKING THE END PRICE' : 'ENDS IN <b data-clk></b>'}</span></div>
      ${pools(L.up, L.down)}
      <div class="mx-you ${my ? (win === null ? 'even' : win ? 'won' : 'lost') : 'none'}">${my ? `YOUR CALL ${ARROW[my.side]} ${my.side.toUpperCase()} ${fmt(my.chips)} &middot; ${win === null ? 'EVEN' : win ? 'WINNING' : 'LOSING'}` : 'You are not in this round'}</div></section>`;
  };
  const nextCard = (s: MarketState) => {
    const O = s.open; if (!s.enabled || !O) return `<section class="mx-card next empty"><header><span>NEXT</span></header><p class="mx-dim">${s.enabled ? 'Opening…' : 'The exchange is closed for a moment.'}</p></section>`;
    const left = O.lockAt - now(), open = left > 0, my = mineIn(s, O.epoch);
    return `<section class="mx-card next ${open ? 'open' : 'closing'}"><header><span>NEXT &middot; TAKING BETS</span><b>#${O.epoch}</b></header>
      <div class="mx-clock big">${ring('bet')}<span>${open ? 'BETS CLOSE IN <b data-clk></b>' : '<i class="mk-spin"></i> LOCKING THE START PRICE'}</span></div>
      ${my ? `<div class="mx-placed ${my.side}"><small>YOUR CALL</small><b>${ARROW[my.side]} ${my.side.toUpperCase()} &middot; ${fmt(my.chips)} CHIP${my.chips === 1 ? '' : 'S'}</b><small>${open ? 'its start price is taken when betting closes' : 'taking its start price now'}</small></div>` : `
      <div class="mx-sides"><button class="mx-side up ${side === 'up' ? 'sel' : ''}" data-s="up" ${open ? '' : 'disabled'}><b>${ARROW.up} UP</b><small>pays ${s.payout}&times;</small></button><button class="mx-side down ${side === 'down' ? 'sel' : ''}" data-s="down" ${open ? '' : 'disabled'}><b>${ARROW.down} DOWN</b><small>pays ${s.payout}&times;</small></button></div>
      <div id="chipwrap"></div>
      <button class="mx-go ${side}" id="go" ${open && !busy ? '' : 'disabled'}><span>CALL ${side.toUpperCase()} &middot; ${fmt(bet)} CHIP${bet === 1 ? '' : 'S'}</span><small>win ${fmt(bet * s.payout)}</small></button>`}
      ${pools(O.up, O.down)}</section>`;
  };
  const paint = (fresh = false) => {
    const s = st; if (!s) return;
    $px.textContent = usd(s.price ?? s.oraclePrice);
    const moved = shownEpoch && s.open && s.open.epoch !== shownEpoch;
    [ended(s), liveCard(s), nextCard(s)].forEach((html, i) => { const slot = cards.children[i] as HTMLElement; if (slot.dataset.h !== html) { slot.innerHTML = html; slot.dataset.h = html; } });
    clocks();
    if (moved) { cards.classList.remove('moved'); void cards.offsetWidth; cards.classList.add('moved'); audio.play('hit', 0.3); }
    shownEpoch = s.open?.epoch ?? 0;
    const cw = root.querySelector<HTMLElement>('#chipwrap');
    if (cw && !cw.dataset.w) { if (!s.wagers.includes(bet)) bet = s.wagers[0]; cw.dataset.w = '1'; cw.innerHTML = `<div class="mx-chips">${chipRow(bet, s.wagers, 'mkchips')}</div>`; wireChips(root, v => { bet = v; paint(); }, () => busy, 'mkchips'); }
    $(root, '#recent').innerHTML = s.recent.slice(0, 10).map(r => `<i class="mk-pill ${r.outcome || 'none'}" title="#${r.epoch}">${r.outcome === 'up' ? ARROW.up : r.outcome === 'down' ? ARROW.down : r.outcome === 'tie' ? '=' : '&times;'}</i>`).join('') || '<span class="mx-dim">No rounds yet</span>';
    const crowd = [...(s.open ? s.crowd[s.open.epoch] ?? [] : []), ...(s.live ? s.crowd[s.live.epoch] ?? [] : [])];
    $(root, '#crowd').textContent = crowd.length ? `${crowd.length} call${crowd.length === 1 ? '' : 's'} in play` : '';
    void fresh;
  };
  // the live round ends, and the next one locks, at the same moment: when betting closes
  function clocks() {
    const s = st; if (!s?.open) return; const left = Math.max(0, s.open.lockAt - now()), k = Math.min(1, left / (s.roundS * 1000));
    root.querySelectorAll<HTMLElement>('[data-clk]').forEach(b => { b.textContent = clock(left); }); root.querySelectorAll<SVGElement>('[data-ring]').forEach(r => { r.style.strokeDashoffset = String(C * (1 - k)); });
  }
  // one listener for the whole row of cards: the cards are redrawn, the listener stays
  cards.addEventListener('click', (e) => {
    const el = e.target as HTMLElement, sb = el.closest<HTMLButtonElement>('.mx-side');
    if (sb && !busy && !sb.disabled) { side = sb.dataset.s as MarketSide; audio.play('hit', 0.25); vib(4); paint(); return; }
    if (el.closest('#go')) void placeBet();
  });
  async function placeBet() {
    const s = st; if (busy || !s?.enabled || !s.open || !backend.marketBet || !canCover(root, bet)) return;
    busy = true; hideResult(root); vib(10); audio.play('hit', 0.4); const go = root.querySelector('#go');
    try {
      const epoch = s.open.epoch, r = await pending(go, () => backend.marketBet!(epoch, side, bet));
      placed.set(epoch, { betId: r.betId, who: 'You', side, chips: bet, mine: true }); setBal(root);
      bus.emit('toast', `${side.toUpperCase()} ${bet} on round #${epoch}. Good luck!`);
      st = await backend.market!().catch(() => st);
    } catch (e) { oops(root, e); }
    finally { busy = false; paint(); }
  }
  // the chart tab in the offline demo: its own simulated prices
  const draw = () => {
    if (!alive) return; frame = requestAnimationFrame(draw); if (tv || tab !== 'c') return; const s = st; if (!s) return;
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const c = cv.getContext('2d')!; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    const pts = s.history.slice(-300); $(root, '#cvn').hidden = pts.length > 1; if (pts.length < 2) return;
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0], lock = s.live?.lockPrice ?? null;
    let lo = Math.min(...pts.map(q => q[1]), lock ?? Infinity), hi = Math.max(...pts.map(q => q[1]), lock ?? -Infinity); const pad = Math.max((hi - lo) * 0.15, hi * 0.0002); lo -= pad; hi += pad;
    const X = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * (w - 50), Y = (v: number) => h - 8 - ((v - lo) / (hi - lo)) * (h - 16), last = pts[pts.length - 1][1], col = lock == null ? '#7fd8ff' : last >= lock ? '#3dffa0' : '#ff4d6d';
    c.beginPath(); pts.forEach(([t, v], i) => (i ? c.lineTo(X(t), Y(v)) : c.moveTo(X(t), Y(v)))); c.strokeStyle = col; c.lineWidth = 2; c.stroke();
    if (lock != null) { const y = Math.round(Y(lock)) + 0.5; c.setLineDash([4, 4]); c.strokeStyle = '#ffd24a'; c.beginPath(); c.moveTo(0, y); c.lineTo(w - 50, y); c.stroke(); c.setLineDash([]); c.fillStyle = '#ffd24a'; c.font = '10px "Num", monospace'; c.fillText('LOCK', w - 46, y + 3); }
  };
  const poll = async () => {
    if (!root.isConnected) shutdown(); if (!alive) return;
    try {
      const was = st?.open?.epoch; st = await backend.market!(); if (tab === 'p' && !busy) paint(was !== st.open?.epoch); else $px.textContent = usd(st.price ?? st.oraclePrice);
      for (const r of st.recent.slice(0, 3)) { const mine = placed.get(r.epoch); if (mine && !shown.has(mine.betId)) { const res = await backend.marketResult?.(mine.betId); if (res) onSettled(res); } }
    } catch (e) { if (!st) cards.innerHTML = `<p class="mx-dim" style="padding:20px">${e instanceof BackendError ? esc(e.message) : 'Reconnecting…'}</p>`; }
    if (alive) timer = window.setTimeout(poll, 1000);
  };
  void poll(); clk = window.setInterval(() => { if (alive && tab === 'p') clocks(); }, 250); frame = requestAnimationFrame(draw);
}

// ---------------------------------------------------------------------------------------------- TALK TO A HOST
const chatLogs: Record<AgentId, { who: 'host' | 'you'; text: string; dec?: AgentDecision; proof?: AgentProof; off?: boolean; wait?: boolean; typed?: boolean }[]> = { fortuna: [], nakamoto: [] };
function hostChat(root: Root, close: () => void, agent: AgentId) {
  const don = agent === 'fortuna', name = don ? 'DON FORTUNA' : 'FATHER NAKAMOTO';
  const log = chatLogs[agent];
  if (!log.length) log.push({ who: 'host', text: don ? 'Welcome to my house. Ask me what I decided last, or ask me anything about the games.' : 'Peace be with you. Ask what I decided last, or ask me anything about FAITH and the Church.' });
  const QUICK = don ? ['How do I win more?', 'What is Harmony?', 'Is it fair?', 'What is a Happy Hour?'] : ['How do I grow FAITH?', 'What is Harmony?', 'What are alms?', 'What is a Vigil?'];
  const render = () => {
    shell(root, close, don ? 'casino' : 'church', name, `
    <div class="ch">
      <div class="ch-who"><div class="ch-face"><div class="spr idle" style="${spriteCss(don ? 'c_pit_boss' : 'm_monk', 'idle_down', 4)}"></div></div><b>${name}</b><small>${don ? 'Owner of the Casino' : 'Keeper of the Church'}</small>
        <div class="ch-tag">AI HOST &middot; DECIDES EVERY 10 MIN</div>
        <button class="g-key" id="latest">YOUR LATEST DECISION?</button>
        <button class="g-key dark" id="honest">HOW YOU'RE KEPT HONEST</button></div>
      <div class="ch-main">
        <div class="ch-log" id="log">${log.map(m => m.who === 'you'
          ? `<div class="ch-m you"><p>${esc(m.text)}</p></div>`
          : m.wait ? '<div class="ch-m host wait"><p><i></i><i></i><i></i></p></div>'
          : `<div class="ch-m host ${m.off ? 'off' : ''}"><p>${m.typed === false ? '' : esc(m.text)}</p>${m.dec ? decisionRow(m.dec) : ''}${m.proof && m.typed !== false ? '<span class="ai-sig ok">&#10003; SIGNED ANSWER</span>' : ''}</div>`).join('')}</div>
        <div class="ch-quick">${QUICK.map(q => `<button class="chip" data-q="${q}">${q}</button>`).join('')}</div>
        <form class="ch-in" id="form"><input id="ask" maxlength="200" autocomplete="off" placeholder="Ask ${don ? 'Don Fortuna' : 'the Father'} about the game..." /><button class="g-key" type="submit">ASK</button></form>
      </div>
    </div>`);
    const lg = $(root, '#log'); lg.scrollTop = lg.scrollHeight;
    feedCache = log.filter(m => m.dec).map(m => m.dec!);
    wireDecisions(root, close, render);
    $(root, '#honest').addEventListener('click', () => honestView(root, close, render));
    $(root, '#latest').addEventListener('click', async () => {
      log.push({ who: 'you', text: 'What did you decide last?' });
      const feed = backend.agentFeed ? await backend.agentFeed(agent, 1) : [];
      const d = feed[0];
      log.push(d ? { who: 'host', text: d.action === 'none' ? 'I held steady. Here is what I wrote:' : d.proof ? 'Here is my latest move, signed and sealed:' : 'Here is my latest move:', dec: d } : { who: 'host', text: 'I have not made a move yet tonight. Come back in a few minutes.' });
      render();
    });
    /** the host's answer appears letter by letter, like the speech bubbles in the world */
    const typeOut = (m: (typeof log)[number]) => {
      const i = log.indexOf(m);
      const p = root.querySelectorAll<HTMLElement>('#log .ch-m')[i]?.querySelector('p');
      if (!p) { m.typed = true; return; }
      let n = 0;
      const step = Math.max(1, Math.round(m.text.length / 140));       // long answers still finish in ~2.5 s
      const t = window.setInterval(() => {
        if (!p.isConnected) { window.clearInterval(t); m.typed = true; return; }
        n = Math.min(m.text.length, n + step); p.textContent = m.text.slice(0, n);
        const lg = root.querySelector('#log'); if (lg) lg.scrollTop = lg.scrollHeight;
        if (n >= m.text.length) {
          window.clearInterval(t); m.typed = true;
          if (m.proof) p.insertAdjacentHTML('afterend', '<span class="ai-sig ok">&#10003; SIGNED ANSWER</span>');
        }
      }, 18);
    };
    const ask = async (q: string) => {
      q = q.trim().slice(0, 200); if (q.length < 2) return;
      log.push({ who: 'you', text: q }); log.push({ who: 'host', text: '', wait: true }); render();
      const msg = log[log.length - 1];
      try {
        const r = backend.askHost ? await backend.askHost(agent, q) : { answer: 'I am busy running the house. Try again later.', relevant: true };
        Object.assign(msg, { wait: false, typed: false, text: r.answer, proof: r.proof, off: !r.relevant });
      } catch (e) { Object.assign(msg, { wait: false, typed: false, text: errText(e), off: true }); }
      audio.play('hit', 0.2); render();
      ($(root, '#ask') as HTMLInputElement)?.focus();
      typeOut(msg);
    };
    $$(root, '.ch-quick .chip').forEach(b => b.addEventListener('click', () => ask(b.dataset.q!)));
    $(root, '#form').addEventListener('submit', (e) => { e.preventDefault(); const i = $(root, '#ask') as HTMLInputElement; const v = i.value; i.value = ''; void ask(v); });
  };
  render();
}
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// ---------------------------------------------------------------------------------------------- SETTINGS
export interface SettingsActions { replay: (r: 'casino' | 'church') => void; skip: () => void; reset: () => void }
export function openSettings(m: HTMLElement, close: () => void, act: SettingsActions) {
  bus.emit('modalOpened');
  m.className = 'open'; m.innerHTML = '<div class="gm-wrap"></div>';
  const root = m.firstElementChild as HTMLElement;
  m.addEventListener('pointerdown', (e) => { if (e.target === m) close(); }, { once: true });
  const get = (k: string, d = '1') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const set = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* */ } };
  let walletId = '';
  const shortId = (id: string) => (id.length > 20 ? `${id.slice(0, 6)}...${id.slice(-6)}` : id);
  if (backend.mode === 'chain' && backend.wallet) void backend.wallet().then(w => {
    walletId = w.accountId; const s = root.querySelector('#st-addr'); if (s) s.textContent = shortId(walletId);
  }).catch(() => { const s = root.querySelector('#st-addr'); if (s) s.textContent = 'no wallet yet'; });
  const render = () => {
    const pad = !document.getElementById('controls')?.classList.contains('hidden');
    const b = blessingOf(store.eco.faith), p = store.profile;
    shell(root, close, 'plaza' as any, 'SETTINGS', `
    <div class="st">
      <div class="st-card"><div class="st-name">${p?.username ?? 'Wanderer'}</div><div class="st-sub">${b.title.toUpperCase()}${b.bps ? ` &middot; BLESSING +${(b.bps / 100).toFixed(1)}%` : ''} &middot; ${backend.mode === 'mock' ? 'DEMO MODE' : 'SOLANA DEVNET'}</div>
        <div class="stone"><div class="plate"><small>CHIPS</small><b>${fmt(store.eco.chips)}</b></div><div class="plate"><small>LUCK</small><b>${Math.floor(store.eco.luck)}</b></div><div class="plate"><small>FAITH</small><b>${Math.floor(store.eco.faith)}</b></div></div></div>
      <div class="st-grid">
        <div class="st-sec"><h4>SOUND &amp; FEEL</h4>
          <button class="tg ${audio.muted ? '' : 'on'}" data-a="sound"><span>MUSIC</span><i></i></button>
          <button class="tg ${audio.sfxMuted ? '' : 'on'}" data-a="sfx"><span>SOUND EFFECTS</span><i></i></button>
          <button class="tg ${get('cnc.haptics') === '0' ? '' : 'on'}" data-a="haptics"><span>VIBRATION</span><i></i></button>
          <button class="tg ${pad ? 'on' : ''}" data-a="pad"><span>X / O BUTTONS</span><i></i></button></div>
        <div class="st-sec"><h4>HELP</h4>
          <div class="cs-row"><button class="g-key" data-a="how">HOW TO PLAY</button><button class="g-key" data-a="lore">&#128214; READ THE BACKSTORY</button></div>
          <button class="g-key" data-a="guide">YOUR CHIPS, LUCK AND FAITH</button>
          <div class="cs-row"><button class="g-key dark" data-a="tc">CASINO TOUR</button><button class="g-key dark" data-a="th">CHURCH TOUR</button></div>
          <button class="g-key dark" data-a="skip">SKIP CURRENT TOUR</button></div>
        <div class="st-sec"><h4>ACCOUNT</h4>
          ${backend.mode === 'chain' && backend.wallet ? `<div class="st-addr" title="Your Solana wallet (devnet)"><span id="st-addr">${walletId ? shortId(walletId) : '...'}</span><button class="g-key" data-a="copyaddr" aria-label="Copy wallet address">COPY</button></div>` : ''}
          ${backend.signOut ? `<button class="g-key danger" data-a="signout">${'SIGN OUT'}</button>` : '<button class="g-key danger" data-a="reset">NEW CHARACTER</button>'}
          <div class="st-out" id="out"></div></div>
      </div>
      <p class="st-credit">Art: bubbabba &middot; Jephed, Game Between The Lines (gamebetweenthelines.com) &middot; Music &amp; sound by the team</p>
    </div>`);
    // hidden: tap the credits 5 times to show / hide the screen-size read-out (for the iPhone home-screen app)
    let taps = 0; $(root, '.st-credit').addEventListener('click', () => {
      if (++taps < 5) return;
      try { localStorage.setItem('cnc.vp', localStorage.getItem('cnc.vp') === '1' ? '0' : '1'); } catch { /* */ }
      location.reload();
    });
    $$(root, '[data-a]').forEach(btn => btn.addEventListener('click', async () => {
      const a = btn.dataset.a!;
      if (a === 'sound') { audio.setMuted(!audio.muted); bus.emit('soundChanged'); render(); }
      if (a === 'sfx') { audio.setSfxMuted(!audio.sfxMuted); render(); if (!audio.sfxMuted) audio.play('hit', 0.4); }
      if (a === 'haptics') { set('cnc.haptics', get('cnc.haptics') === '0' ? '1' : '0'); render(); }
      if (a === 'pad') { const c = document.getElementById('controls')!; const on = c.classList.toggle('hidden') === false; set('cnc.pad', on ? '1' : '0'); render(); }
      if (a === 'lore') { close(); showBackstory(); return; }
      if (a === 'guide') { guide(root, close); return; }
      if (a === 'how') { shell(root, close, 'plaza' as any, 'HOW TO PLAY', `<div class="st">${howToHtml()}<button class="g-key dark" id="bk" style="align-self:center;min-width:160px">BACK TO SETTINGS</button></div>`); playHowTo(root); $(root, '#bk').addEventListener('click', render); }
      if (a === 'tc') { close(); act.replay('casino'); } if (a === 'th') { close(); act.replay('church'); } if (a === 'skip') { close(); act.skip(); }
      if (a === 'copyaddr') {
        if (!walletId) return;
        const ok = await copyText(walletId);
        btn.textContent = ok ? 'COPIED!' : 'FAILED'; if (!ok) $(root, '#out').textContent = walletId;
        setTimeout(() => { if (btn.isConnected) btn.textContent = 'COPY'; }, 1600);
      }
      if (a === 'key') {
        const k: string = (window as any).cncExportKey?.() ?? '';
        const out = $(root, '#out');
        if (!k) { out.textContent = 'No key yet. Play once in chain mode first.'; return; }
        try { await navigator.clipboard.writeText(k); out.textContent = 'Copied. Keep it secret: it controls your account.'; } catch { out.textContent = k; }
      }
      if (a === 'reset') {
        const out = $(root, '#out');
        if (btn.dataset.sure) { act.reset(); return; }
        btn.dataset.sure = '1'; btn.textContent = 'TAP AGAIN TO CONFIRM'; out.textContent = 'This starts over on this device.';
      }
      if (a === 'signout') {
        const out = $(root, '#out');
        if (btn.dataset.sure) { backend.signOut!(); clearProfile(); location.reload(); return; }
        btn.dataset.sure = '1'; btn.textContent = 'TAP AGAIN TO SIGN OUT';
        out.textContent = 'Your chips stay in your account. Sign back in any time with your email.';
      }
    }));
  };
  render();
}

// ---------------------------------------------------------------------------------------------- registry
const GAMES: Partial<Record<PanelKind, (root: Root, close: () => void, id?: string) => void>> = {
  monitor, ledger, board, market, commission, places,
  chat: (root, close, id) => hostChat(root, close, id === 'nakamoto' ? 'nakamoto' : 'fortuna'),
  guide, slots: (root, close) => slots(root, close), coinflip, dice, roulette, blackjack, cashier, offering, candles, missions, altar, confessional, wheel: fortune,
  harmony: (root, close) => harmony(root, close),
  plot: (root, close, id) => plot(root, close, Number((id ?? 'plot-1').replace('plot-', '')) || 1),
};

/** returns true if a real panel exists for this kind */
export function openGame(kind: PanelKind, m: HTMLElement, close: () => void, id?: string): boolean {
  const g = GAMES[kind]; if (!g) return false;
  bus.emit('modalOpened'); audio.hold();
  m.className = 'open'; m.innerHTML = '<div class="gm-wrap"></div>';
  g(m.firstElementChild as HTMLElement, close, id);
  m.addEventListener('pointerdown', (e) => { if (e.target === m) close(); }, { once: true });
  return true;
}
