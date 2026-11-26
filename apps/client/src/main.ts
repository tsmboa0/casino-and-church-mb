import Phaser from 'phaser';
import '@fontsource/pixelify-sans/400.css';
import '@fontsource/pixelify-sans/700.css';
import '@fontsource/silkscreen/400.css';
import '@fontsource/silkscreen/700.css';
import './styles.css';
import { store, clearProfile } from './core/state';
import { initBackend, backend } from './core/backend';
import { input } from './core/input';
import { bus } from './core/bus';
import { audio } from './core/audio';
import { PreloadScene } from './world/PreloadScene';
import { WorldScene } from './world/WorldScene';
import { mountControls, setControlsVisible } from './ui/controls';
import { mountHud, mountFeedback, mountModal } from './ui/hud';
import { startOnboarding, faceCss, setManifest, showSplash } from './ui/onboarding';
import { maybeShowInstallHint } from './ui/installHint';
import { setPlaces } from './ui/games';
import { ATLAS_BASE, type Zone } from './config';

/** Render at the device's real pixel resolution (crisp), capped so very large screens stay fast. */
/**
 * The real size of the screen in CSS px. iOS home-screen apps (standalone, viewport-fit=cover) report an
 * innerHeight / visualViewport.height that stops short of the bottom (home-indicator area, sometimes a stale
 * portrait value), so we take the biggest honest measurement: the fixed full-screen #stage box, the window,
 * and in standalone landscape the physical screen itself.
 */
function screenSize() {
  // a bare fixed inset:0 box: what the browser thinks the viewport is (never stretched by us, so rotation stays honest)
  let probe = document.getElementById('vp-probe');
  if (!probe) { probe = document.createElement('div'); probe.id = 'vp-probe'; probe.style.cssText = 'position:fixed;inset:0;visibility:hidden;pointer-events:none;z-index:-1'; document.body.appendChild(probe); }
  const r = probe.getBoundingClientRect();
  let w = Math.max(window.innerWidth, r?.width ?? 0), h = Math.max(window.innerHeight, r?.height ?? 0);
  const standalone = (navigator as any).standalone === true || window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
  if (standalone && screen.width && screen.height) {
    const long = Math.max(screen.width, screen.height), short = Math.min(screen.width, screen.height);
    if (w > h) { w = Math.max(w, long); h = Math.max(h, short); } else { w = Math.max(w, short); h = Math.max(h, long); }
  }
  return { w: Math.round(w), h: Math.round(h) };
}
const typing = () => document.activeElement?.tagName === 'INPUT';
function deviceSize() {
  const { w, h } = screenSize();
  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, Math.sqrt(4_200_000 / (w * h))));
  return { w: Math.round(w * dpr), h: Math.round(h * dpr) };
}

/** phones and tablets go fullscreen on tap; a desktop browser stays a normal window */
const touchDevice = () => window.matchMedia('(pointer: coarse)').matches;

async function boot() {
  // the server health check runs while the fonts and the art load (it used to hold up the first screen)
  const backendReady = initBackend();
  await Promise.all([
    document.fonts.load('8px "Silkscreen"'), document.fonts.load('8px "Num"', '0'), document.fonts.load('9px "Pixelify Sans"'), document.fonts.load('700 9px "Silkscreen"'),
  ]).catch(() => { /* fonts are progressive */ });

  const q = new URLSearchParams(location.search);
  // ?vp=1: show what the browser reports about the screen (for the iPhone home-screen bottom strip)
  let vpOn = false; try { vpOn = localStorage.getItem('cnc.vp') === '1'; } catch { /* */ }
  if (q.get('vp') || vpOn) {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:50%;top:6px;transform:translateX(-50%);z-index:99999;background:#000c;color:#7dffb0;font:11px/1.35 ui-monospace,monospace;padding:6px 9px;border:1px solid #7dffb0;white-space:pre;pointer-events:none';
    const safe = document.createElement('div');
    safe.style.cssText = 'position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.append(box, safe);
    const tick = () => {
      const v = window.visualViewport, cs = getComputedStyle(safe), pr = document.getElementById('vp-probe')?.getBoundingClientRect();
      const cv = document.querySelector('#game canvas')?.getBoundingClientRect(), bd = document.body.getBoundingClientRect();
      box.textContent = [
        `inner ${innerWidth}x${innerHeight}  screen ${screen.width}x${screen.height}  dpr ${devicePixelRatio}`,
        `visual ${v ? `${Math.round(v.width)}x${Math.round(v.height)} @${Math.round(v.offsetTop)}` : '-'}  probe ${pr ? `${Math.round(pr.width)}x${Math.round(pr.height)}` : '-'}`,
        `body ${Math.round(bd.width)}x${Math.round(bd.height)}  canvas ${cv ? `${Math.round(cv.width)}x${Math.round(cv.height)} @${Math.round(cv.top)}` : '-'}`,
        `--appH ${getComputedStyle(document.documentElement).getPropertyValue('--appH') || '-'}  safe t${cs.paddingTop} r${cs.paddingRight} b${cs.paddingBottom} l${cs.paddingLeft}`,
        `standalone ${(navigator as any).standalone === true}  display-mode ${matchMedia('(display-mode: standalone)').matches ? 'standalone' : matchMedia('(display-mode: fullscreen)').matches ? 'fullscreen' : 'browser'}`,
      ].join('\n');
    };
    tick(); window.setInterval(tick, 500);
  }
  (window as any).__audio = audio;
  if (import.meta.env.DEV) Object.defineProperty(window, '__backend', { get: () => backend });
  const size = deviceSize();
  const game = new Phaser.Game({
    type: Phaser.AUTO, parent: 'game', width: size.w, height: size.h, backgroundColor: '#14101c',
    pixelArt: true, roundPixels: true,
    scale: { mode: Phaser.Scale.NONE },
    render: { powerPreference: 'high-performance', batchSize: 4096 },
    fps: { target: 60, smoothStep: true },
    input: { keyboard: false, mouse: false, touch: false, gamepad: false },
    scene: [PreloadScene, WorldScene],
  });
  const css = () => { const s = screenSize(); game.canvas.style.width = `${s.w}px`; game.canvas.style.height = `${s.h}px`; };
  css();
  // ---- keep the page itself from EVER zooming. A thumb on the D-pad plus a thumb on the X button is two
  //      simultaneous touches, which iOS reads as a pinch. So: cancel every multi-touch, cancel the gesture
  //      events, cancel double-tap, and if the page still gets zoomed, reset it immediately.
  const stop = (e: Event) => e.preventDefault();
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(t => document.addEventListener(t, stop, { passive: false } as any));
  document.addEventListener('wheel', (e) => { if ((e as WheelEvent).ctrlKey) e.preventDefault(); }, { passive: false });
  const guard = (e: TouchEvent) => {
    const t = e.target as HTMLElement | null;
    if (e.touches.length > 1) { e.preventDefault(); return; }                        // never allow a pinch
    if (t?.closest('#controls, #game, #labels')) e.preventDefault();                 // game surface: no browser gestures at all
  };
  document.addEventListener('touchstart', guard, { passive: false });
  document.addEventListener('touchmove', (e) => { if ((e as TouchEvent).touches.length > 1 || (e.target as HTMLElement).closest('#controls, #game, #labels, #onboarding')) e.preventDefault(); }, { passive: false });
  let lastTap = 0;
  document.addEventListener('touchend', (e) => { const n = Date.now(); if (n - lastTap < 350 && !(e.target as HTMLElement).closest('input')) e.preventDefault(); lastTap = n; }, { passive: false });
  const vmeta = document.querySelector('meta[name=viewport]') as HTMLMetaElement;
  const VIEW = 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=overlays-content';
  const resetZoom = () => {
    vmeta.setAttribute('content', VIEW.replace('maximum-scale=1', 'maximum-scale=1.01'));    // nudge so iOS re-reads it
    requestAnimationFrame(() => { vmeta.setAttribute('content', VIEW); window.scrollTo(0, 0); window.dispatchEvent(new Event('resize')); });
  };
  const checkZoom = () => { const sc = window.visualViewport?.scale ?? 1; if (Math.abs(sc - 1) > 0.02) resetZoom(); };
  window.visualViewport?.addEventListener('resize', checkZoom);
  window.visualViewport?.addEventListener('scroll', () => { if ((window.visualViewport?.offsetLeft ?? 0) > 1 || (window.visualViewport?.offsetTop ?? 0) > 1) checkZoom(); });
  window.setInterval(checkZoom, 400);
  document.addEventListener('focusout', () => setTimeout(() => { window.scrollTo(0, 0); window.dispatchEvent(new Event('resize')); }, 80));
  // UI scale: 1x on phones, up to 1.7x on big windows so the HUD stays readable
  // the UI layer covers the whole screen; only while the soft keyboard is up does it follow the (smaller) visual viewport
  const vvSync = () => {
    const v = window.visualViewport, r = document.documentElement.style;
    if (typing() && v) { r.setProperty('--vvh', `${v.height}px`); r.setProperty('--vvt', `${v.offsetTop}px`); return; }
    const s = screenSize();
    r.setProperty('--vvh', `${s.h}px`); r.setProperty('--vvt', '0px');
    // iOS home-screen apps lay the page out ~20px short of the screen and clip everything below: stretch the page itself
    r.setProperty('--appH', `${s.h}px`); r.setProperty('--appW', `${s.w}px`);
  };
  document.addEventListener('focusin', vvSync); document.addEventListener('focusout', () => setTimeout(vvSync, 120));
  window.setInterval(vvSync, 700);
  vvSync(); window.visualViewport?.addEventListener('resize', vvSync); window.visualViewport?.addEventListener('scroll', vvSync); window.addEventListener('resize', vvSync);
  const uiScale = () => document.documentElement.style.setProperty('--ui', String(Math.max(1, Math.min(1.7, screenSize().h / 420))));
  uiScale();
  // one debounced resize path for window resize, rotation, fullscreen and the visual viewport; ignored while typing
  let rt = 0;
  const resize = () => {
    window.clearTimeout(rt);
    rt = window.setTimeout(() => {
      if (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '')) return;       // soft keyboard: keep the layout stable
      window.scrollTo(0, 0);
      const s = deviceSize(); game.scale.resize(s.w, s.h); css(); uiScale();
    }, 90);
  };
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));
  document.addEventListener('fullscreenchange', () => setTimeout(resize, 200));
  window.visualViewport?.addEventListener('resize', resize);
  // watchdog: whatever the browser did (URL bar, keyboard, fullscreen, rotation), the canvas must match the real window
  window.setInterval(() => {
    if (document.activeElement?.tagName === 'INPUT') return;
    const s = deviceSize();
    if (game.scale.width !== s.w || game.scale.height !== s.h) { game.scale.resize(s.w, s.h); }
    css();
  }, 700);

  // Android/desktop browsers: go fullscreen on the first tap and again if the user leaves it (needs a gesture each time).
  // iPhone Safari has no fullscreen API for pages, so the only way there is Add to Home Screen (manifest + meta tags).
  document.addEventListener('pointerdown', () => {
    if (!touchDevice() || document.fullscreenElement || !document.documentElement.requestFullscreen) return;
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  }, { capture: true });
  mountControls(document.getElementById('controls')!);
  mountFeedback();
  const offline = await backendReady;
  if (offline) bus.emit('toast', offline);

  const manifest = await (await fetch(`${ATLAS_BASE}manifest.json`)).json();
  // a fresh clone draws placeholder art (scripts/ensure-art.mjs): say so, and where the real thing is
  if (manifest.placeholder) {
    const b = document.createElement('a');
    b.id = 'art-note'; b.href = 'https://casino-and-church.vercel.app'; b.target = '_blank'; b.rel = 'noopener';
    b.textContent = 'Placeholder art: the licensed art is not in the repository. Everything works; the real look is at casino-and-church.vercel.app';
    document.body.append(b);
  }
  // hand over from the inline loading screen (index.html) to the game's own screens
  const dropBootSplash = () => { const b = document.getElementById('boot-splash'); if (!b) return; b.style.opacity = '0'; setTimeout(() => b.remove(), 400); };
  setManifest(manifest);
  const hud = mountHud(faceCss);
  const world = await new Promise<WorldScene>((res) => {
    const t = setInterval(() => { const s = game.scene.getScene('World') as WorldScene; if (s?.world && s.scene.isActive()) { clearInterval(t); res(s); } }, 50);
  });
  mountModal({ replay: (r) => world.replayTour(r), reset: () => { clearProfile(); location.reload(); } });
  setPlaces(world.placeList());
  // the canvas is a picture to assistive tech and browser agents: say how to move without it
  document.getElementById('game')?.setAttribute('aria-label', 'The game world. Use the Places button (map pin, top right) to go to any location.');
  /**
   * window.cnc: a small API for automated testers and browser agents (documented in AGENTS.md / llms.txt).
   * Everything it does, a player can do by hand.
   */
  (window as any).cnc = {
    version: 1,
    state: () => ({
      mode: backend.mode, signedIn: !!store.profile, profile: store.profile, realm: store.realm,
      chips: store.eco.chips, bonus: store.eco.bonus, luck: Math.round(store.eco.luck * 10) / 10, faith: Math.round(store.eco.faith * 10) / 10, testSol: store.eco.sol,
      panelOpen: document.getElementById('modal')?.classList.contains('open') ?? false,
      panelTitle: document.querySelector('#modal .gm-title span')?.textContent ?? null,
    }),
    places: () => world.placeList(),
    go: (place: string) => world.travelTo(place),
    close: () => (document.querySelector('#modal [data-close]') as HTMLElement | null)?.click(),
  };
  bus.on('modalOpened', () => { world.setPlayerLocked(true); input.clearEdges(); });
  bus.on('modalClosed', () => { world.setPlayerLocked(false); });
  bus.on('skipTour', () => world.skipTour());
  bus.on('realm', (z: Zone) => audio.zone(z));                    // crossing a doorway swaps the music
  bus.on('gateAnswer', (enter: boolean) => world.resolveGate(enter));
  // tiny UI click sound on every button
  document.addEventListener('pointerdown', (e) => { if ((e.target as HTMLElement).closest('.btn, .fb, .av, .realm-card, .sysbtn')) audio.play('hit', 0.45); });

  const syncInset = () => world.setInsetTop(0);                  // full-screen scene: HUD floats on top
  window.addEventListener('resize', () => setTimeout(syncInset, 60));

  const play = (p: any) => {
    store.setProfile(p);
    void backend.setProfile?.(p.username, p.avatar).catch((e) => {
      // never block play on the name; but say so if someone else holds it (e.g. claimed while you were offline)
      if ((e as { code?: string })?.code === 'name_taken') bus.emit('toast', `Another player already uses the name ${p.username}. Start a NEW GAME to pick your own.`);
    });
    hud.refresh(); hud.show(true); setControlsVisible(true);
    syncInset();
    document.body.classList.add('playing');
    audio.music('main');                                         // main theme at the crossroads
    world.beginPlay(p);
    // ?play=roulette (or market, cashier, altar, commission, don, ...): go straight there once in the world
    const target = q.get('play');
    if (target) setTimeout(() => { if (!world.travelTo(target)) bus.emit('toast', `No place called "${target}". Open Places to see them all.`); }, 1200);
  };
  const agent = q.get('agent') === '1';
  if (q.get('wallettest') === '1') void import('./wallet/testPanel').then((m) => m.mountTestPanel());

  // ---- dev/screenshot hooks
  dropBootSplash();
  if (q.get('skip')) {
    const prof = { username: q.get('name') ?? 'Wanderer', avatar: q.get('avatar') ?? 'c_tourist', startRealm: (q.get('realm') as any) ?? 'casino', toursDone: { casino: q.get('tour') !== '1', church: q.get('tour') !== '1' } };
    play(prof);
    return;
  }
  if (q.get('at')) { const [x, y] = q.get('at')!.split(',').map(Number); world.debugAt(x, y); return; }

  // ---- ?agent=1: no tap-to-start, no backstory, no tours, no music (a browser agent can drive it from here)
  if (agent) {
    if (backend.mode === 'mock') {                                  // the demo needs no account: straight in
      const p = store.profile ?? { username: 'Agent', avatar: 'c_tourist', startRealm: 'plaza' as any, toursDone: { casino: true, church: true } };
      play({ ...p, toursDone: { casino: true, church: true } });
      return;
    }
    startOnboarding(manifest, (p: any) => play({ ...p, toursDone: { casino: true, church: true } }), { agent: true });
    return;
  }

  // ---- the real flow: splash (first gesture -> music) -> title -> name -> character -> realm -> play
  maybeShowInstallHint();                                            // phones in a browser tab: the home-screen app plays best
  await showSplash(() => {
    audio.unlock();
    audio.music('main');
    if (touchDevice()) { try { document.documentElement.requestFullscreen?.().catch(() => {}); } catch { /* not supported */ } }
    try { (screen.orientation as any)?.lock?.('landscape')?.catch(() => {}); } catch { /* not supported */ }
  });
  startOnboarding(manifest, play);
}
boot();
