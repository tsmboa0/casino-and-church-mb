import { openGame, openSettings } from './games';
import { backend, type RealmEvent } from '../core/backend';
import { icon } from './icons';
import { store } from '../core/state';
import { bus, type PanelKind } from '../core/bus';
import { input } from '../core/input';
import { audio } from '../core/audio';
import type { Realm, Zone } from '../config';

const el = (id: string) => document.getElementById(id)!;

export function mountHud(avatarSheet: (id: string) => string) {
  const hud = el('hud');
  hud.innerHTML = `
    <div class="bar">
      <button class="exitbtn" id="btn-exit" aria-label="Exit"><svg viewBox="0 0 8 8" shape-rendering="crispEdges"><path d="M1 1h2v1h2V1h2v2H6v2h1v2H5V6H3v1H1V5h1V3H1z" fill="#fff4f4"/></svg></button>
      <div class="b-l">
        <div class="face-chip" id="hud-face"></div>
        <div class="who"><div class="nm" id="hud-name">Wanderer</div>
        </div>
      </div>
      <div class="b-c"><div class="realm" id="realm-badge"><i></i><span>CASINO</span></div></div>
      <div class="b-r">
        <div class="evpills" id="evpills"></div>
        <div class="chips" id="hud-chips" role="status" aria-label="Chips">${icon('coin', 14)}<b id="val-chips">0</b></div>
        <button class="sysbtn" id="btn-places" aria-label="Places: go to any location" title="Places">${icon('map', 14)}</button>
        <button class="sysbtn" id="btn-sound" aria-label="Music" title="Music on/off (game sounds stay on)"></button>
        <button class="sysbtn" id="btn-menu" aria-label="Menu">${icon('gear', 14)}</button>
      </div>
    </div>`;
  const refresh = () => {
    const p = store.profile; if (p) { el('hud-name').textContent = p.username; el('hud-face').style.cssText = avatarSheet(p.avatar); }
    el('val-chips').textContent = store.eco.chips.toLocaleString();
    el('hud-chips').setAttribute('aria-label', `Chips ${store.eco.chips}, LUCK ${Math.floor(store.eco.luck)}, FAITH ${Math.floor(store.eco.faith)}`);
    const rb = el('realm-badge'); rb.className = `realm ${store.realm}`; rb.querySelector('span')!.textContent = store.realm === 'casino' ? 'THE CASINO' : store.realm === 'church' ? 'THE CHURCH' : 'THE CROSSROADS';
  };
  const paintSound = () => { el('btn-sound').innerHTML = icon(audio.muted ? 'mute' : 'sound', 14); };
  el('btn-sound').addEventListener('click', () => { audio.setMuted(!audio.muted); paintSound(); });
  bus.on('soundChanged', paintSound);
  store.on(refresh); refresh(); paintSound();
  el('btn-menu').addEventListener('click', () => bus.emit('menu'));
  el('btn-places').addEventListener('click', () => bus.emit('panel', 'places', 'Places', 'places'));
  el('btn-exit').addEventListener('click', () => bus.emit('exit'));
  // live realm events (Happy Hour / Vigil): a pill per event with a countdown; tap it to open the Crossroads board
  const pills = el('evpills');
  let events: RealmEvent[] = [];
  const paintEvents = () => {
    const now = Date.now(); events = events.filter(e => e.endsAt > now);
    pills.innerHTML = events.map(e => { const s = Math.ceil((e.endsAt - now) / 1000); return `<button class="evpill ${e.kind}" title="${e.kind === 'happy_hour' ? 'LUCK' : 'FAITH'} +${e.boostBps / 100}%">${e.kind === 'happy_hour' ? 'HAPPY HOUR' : 'VIGIL'} <b>+${e.boostBps / 100}%</b> <i>${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}</i></button>`; }).join('');
    document.body.classList.toggle('ev-happy', events.some(e => e.kind === 'happy_hour'));
    document.body.classList.toggle('ev-vigil', events.some(e => e.kind === 'vigil'));
  };
  const loadEvents = async () => { try { events = (await backend.activeEvents?.()) ?? []; } catch { events = []; } paintEvents(); };
  bus.on('eventsChanged', loadEvents); window.setInterval(paintEvents, 1000); window.setInterval(loadEvents, 15000); void loadEvents();
  pills.addEventListener('click', () => bus.emit('panel', 'board', 'The Word at the Crossroads', 'board'));
  return {
    refresh,
    show: (v: boolean) => hud.classList.toggle('show', v),
    height: () => (hud.querySelector('.bar') as HTMLElement).getBoundingClientRect().height,
  };
}

// ------------------------------------------------------------------ toasts & realm banner
export function mountFeedback() {
  const toasts = el('toasts'), banner = el('banner');
  toasts.setAttribute('aria-live', 'polite'); toasts.setAttribute('role', 'log');
  bus.on('toast', (msg: string) => {
    const t = document.createElement('div'); t.className = 'toast px'; t.textContent = msg; toasts.appendChild(t);
    setTimeout(() => t.classList.add('out'), 2600); setTimeout(() => t.remove(), 3100);
  });
  bus.on('realm', (r: Zone, first: boolean) => {
    const copy = r === 'casino'
      ? { t: 'THE CASINO', s: 'LUCK rises here. FAITH fades.' }
      : r === 'church' ? { t: 'THE CHURCH', s: 'FAITH grows here. LUCK runs dry.' }
      : { t: 'THE CROSSROADS', s: 'Choose your path.' };
    banner.className = `banner ${r}`; banner.innerHTML = `<div class="bn-t">${copy.t}</div><div class="bn-s">${copy.s}</div>`;
    void banner.offsetWidth; banner.classList.add('go');
    void first;
  });
}

// ------------------------------------------------------------------ modal (panel stubs + menu)
const PANEL_COPY: Record<PanelKind, { t: string; body: string; tag: string }> = {
  slots: { t: 'Slots', tag: 'PHASE 2', body: 'Three reels, dealt on-chain by Don Fortuna\'s wallet. Every spin builds LUCK.' },
  coinflip: { t: 'Coin Flip Pit', tag: 'PHASE 2', body: 'Heads or tails. Provably fair commit-reveal, settled in seconds.' },
  wheel: { t: 'Wheel of Fortune', tag: 'PHASE 3', body: 'Fill your LUCK to 100 and the wheel is yours to spin.' },
  cashier: { t: 'Cashier Cage', tag: 'PHASE 2', body: 'Deposit test NEAR for chips. Withdraw whenever you like.' },
  plot: { t: "Founders' Plot", tag: 'PHASE 4', body: 'Earn your standing, mint a deed, and own a machine on the floor.' },
  altar: { t: 'Altar of Fortune', tag: 'PHASE 3', body: 'Offer your LUCK and it becomes FAITH. Both burning bright brings Harmony.' },
  offering: { t: 'Offering Box', tag: 'PHASE 2', body: 'Tithe chips to grow FAITH. A share of every wager ends up here.' },
  missions: { t: 'Mission Board', tag: 'PHASE 3', body: 'Quests from the projects that keep the faith. Do the deed, earn the reward.' },
  dice: { t: 'Dice Den', tag: 'LIVE', body: '' },
  roulette: { t: 'Roulette', tag: 'LIVE', body: '' },
  harmony: { t: 'Harmony Wheel', tag: 'LIVE', body: '' },
  monitor: { t: 'House Monitor', tag: 'LIVE', body: '' }, chat: { t: 'Talk', tag: 'LIVE', body: '' }, ledger: { t: 'The Ledger', tag: 'LIVE', body: '' }, board: { t: 'The Word at the Crossroads', tag: 'LIVE', body: '' },
  blackjack: { t: 'Blackjack', tag: 'OUT OF ORDER', body: 'The dealer is on a break. Blackjack opens in a later update.' },
  candles: { t: 'Votive Candles', tag: 'PHASE 3', body: 'Light a candle once a day. Time it right for a deeper FAITH.' },
  confessional: { t: 'Confessional', tag: 'LIVE', body: '' },
  places: { t: 'Places', tag: 'LIVE', body: 'Go to any location.' },
  market: { t: 'BTC Exchange', tag: 'LIVE', body: 'Call BTC up or down for the next minute.' },
  commission: { t: 'Commission Desk', tag: 'LIVE', body: 'Commission a mission for the Quest Board.' },
};

export function mountModal(actions: { replay: (r: Realm) => void; reset: () => void }) {
  const m = el('modal');
  const close = () => { m.className = ''; m.innerHTML = ''; audio.release(); bus.emit('modalClosed'); };
  // Escape closes whatever panel is open
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && m.classList.contains('open')) { e.preventDefault(); close(); } });
  const open = (html: string) => {
    m.className = 'open'; m.innerHTML = `<div class="sheet px">${html}</div>`;
    m.querySelector('[data-close]')?.addEventListener('click', close);
    m.addEventListener('pointerdown', (e) => { if (e.target === m) close(); }, { once: true });
  };
  bus.on('exit', () => {
    if (m.classList.contains('open')) return close();          // a panel is open: the red button closes it
    bus.emit('modalOpened');
    open(`<div class="sh-h"><h3>Leave the game?</h3></div><p>Your chips, LUCK and FAITH are saved on this device.</p>
      <div class="sh-f"><button class="btn ghost" data-close>STAY</button><button class="btn danger-fill" id="leave">EXIT</button></div>`);
    m.querySelector('#leave')!.addEventListener('click', () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => { /* already leaving */ }); location.reload(); });
  });
  bus.on('panel', (kind: PanelKind, label: string, id?: string) => {
    if (openGame(kind, m, close, id)) return;
    const c = PANEL_COPY[kind]; bus.emit('modalOpened');
    open(`<div class="sh-h"><h3>${label}</h3><span class="tag">${c.tag}</span></div><p>${c.body}</p>
      <p class="dim">The contracts and game logic are the next build phase. The world, the controls and the economy HUD are live.</p>
      <div class="sh-f"><button class="btn ghost" data-close>BACK</button></div>`);
  });
  bus.on('menu', () => openSettings(m, close, { replay: actions.replay, skip: () => bus.emit('skipTour'), reset: actions.reset }));
  // ---- "Enter the Church?" confirmation when you step into a realm doorway from the crossroads
  const gate = el('gate');
  let gateRealm: Realm | null = null;
  const answer = (enter: boolean) => {
    if (!gateRealm) return; gateRealm = null; gate.className = ''; gate.innerHTML = '';
    bus.emit('gateAnswer', enter);
  };
  bus.on('realmGate', (realm: Realm, leave = false) => {
    gateRealm = realm; input.clearEdges();
    const c = leave
      ? (realm === 'casino'
        ? { k: 'LEAVE', t: 'LEAVE THE CASINO?', s: 'Back at the Crossroads nothing fades. Your LUCK stops rising, but your FAITH stops draining too.', host: 'Don Fortuna will keep your seat warm.', yes: 'LEAVE', no: 'STAY' }
        : { k: 'LEAVE', t: 'LEAVE THE CHURCH?', s: 'Back at the Crossroads nothing fades. Your FAITH stops rising, but your LUCK stops draining too.', host: 'Father Nakamoto will keep a candle lit.', yes: 'LEAVE', no: 'STAY' })
      : (realm === 'casino'
        ? { k: 'ENTER', t: 'THE CASINO?', s: 'Luck rises here. Your FAITH will slowly fade while you stay.', host: 'Don Fortuna is waiting.', yes: 'ENTER', no: 'STAY OUT' }
        : { k: 'ENTER', t: 'THE CHURCH?', s: 'Faith grows here. Your LUCK will slowly run dry while you stay.', host: 'Father Nakamoto is waiting.', yes: 'ENTER', no: 'STAY OUT' });
    gate.className = `open ${realm}`;
    gate.innerHTML = `<div class="gate-card"><div class="g-k">${c.k}</div><div class="g-t">${c.t}</div><p>${c.s}</p><small>${c.host}</small>
      <div class="g-b"><button class="btn big" id="g-yes">${c.yes}</button><button class="btn ghost" id="g-no">${c.no}</button></div></div>`;
    el('g-yes').addEventListener('click', () => answer(true));
    el('g-no').addEventListener('click', () => answer(false));
  });
  setInterval(() => { if (!gateRealm) return; if (input.pressed('interact')) answer(true); else if (input.pressed('cancel')) answer(false); }, 60);

  // ○ closes
  setInterval(() => { if (m.classList.contains('open') && input.pressed('cancel')) close(); }, 60);
}
