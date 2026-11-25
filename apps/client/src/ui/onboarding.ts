import { howToHtml, playHowTo } from './howto';
import { AVATARS, ATLAS_BASE, type Realm } from '../config';
import { store, clearProfile, type Profile } from '../core/state';
import { atlasDom } from '../core/atlasDom';
import { icon } from './icons';
import { backend } from '../core/backend';
import { bus } from '../core/bus';
import { loadWallet, shortAddress, walletEnabled } from '../wallet';
import { NAME_MAX, PASSWORD_MIN, cleanName, nameProblem, passwordProblem } from '@cnc/shared';

let MANIFEST: any = null;
export const setManifest = (m: any) => { MANIFEST = m; };

/** CSS for a sprite-sheet cell of a character (idle/walk rows), scale k */
export function spriteCss(id: string, row = 'idle_down', k = 3): string {
  const c = MANIFEST?.chars?.[id]; if (!c) return '';
  const r = c.rows[row] ?? c.rows.idle_down;
  return `--k:${k};--cols:${c.cols};--rows:${Object.keys(c.rows).length};--row:${r.row};--frames:${r.frames};--ms:${r.frames * r.ms}ms;background-image:url(${ATLAS_BASE}chars/${id}.png)`;
}
/** head crop used by the HUD chip */
export function faceCss(id: string): string {
  const c = MANIFEST?.chars?.[id]; if (!c) return '';
  const k = 2;
  return `background-image:url(${ATLAS_BASE}chars/${id}.png);background-size:${c.cols * 16 * k}px ${Object.keys(c.rows).length * 32 * k}px;background-position:0 -14px`;
}

/** the title's two wings: a small THE over a big CASINO (left) and CHURCH (right); the middle carries the buttons */
const WING_CASINO = '<div class="wing casino"><span class="the">THE</span><span class="big">CASINO</span></div>';
const WING_CHURCH = '<div class="wing church"><span class="the">THE</span><span class="big">CHURCH</span></div>';

const NAMES_A =['Lucky', 'Gilded', 'Humble', 'Silver', 'Wandering', 'Velvet', 'Midnight', 'Neon', 'Sacred', 'Crimson'];
const NAMES_B = ['Fox', 'Saint', 'Dealer', 'Pilgrim', 'Magpie', 'Gambler', 'Cardinal', 'Raven', 'Pioneer', 'Sparrow'];
const rnd = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const randomName = () => `${rnd(NAMES_A)}${rnd(NAMES_B)}${Math.floor(Math.random() * 90 + 10)}`.slice(0, NAME_MAX);

export async function startOnboarding(manifest: any, onDone: (p: Profile) => void, opts: { agent?: boolean } = {}) {
  MANIFEST = manifest;
  const root = document.getElementById('onboarding')!;
  root.className = 'show';
  /** Privy login (email, then a Solana wallet). The offline demo (?demo=1) has none. */
  const privy = walletEnabled;
  let me: string | null = null;                    // the signed-in wallet
  /** live game (a chain backend) = real accounts; the offline demo has none */
  const accounts = !privy && !!backend.signIn;
  const draft: {
    name: string; avatar: string;
    securing?: boolean;                 // an existing guest is setting a password (keeps the wallet and chips)
    created?: boolean;                  // the account exists now: BACK must not sign up twice
    signedIn?: { username: string; avatar: string; toursDone: { casino: boolean; church: boolean } };
  } = { name: '', avatar: AVATARS[0].id };
  const k = window.innerHeight >= 520 ? 3 : 2;
  // never scroll, never clip: scale the current screen to fit whatever the window is
  const fit = () => {
    const c = root.firstElementChild as HTMLElement | null; if (!c) return;
    if (root.classList.contains('kb')) return;                       // the keyboard strip places itself
    c.style.transform = ''; c.style.setProperty('--fit', '1');
    const sc = Math.min(1, ((root.clientHeight || window.innerHeight) - 20) / c.offsetHeight, ((root.clientWidth || window.innerWidth) - 20) / c.offsetWidth);
    if (sc < 1) c.style.transform = `scale(${sc})`;
  };
  new MutationObserver(() => requestAnimationFrame(fit)).observe(root, { childList: true });
  window.addEventListener('resize', fit);

  // ---- the landscape keyboard. On a phone held sideways the keyboard covers most of the screen, so while a field is
  // focused the card becomes a strip pinned to the top of what is still visible: the field's label, the field itself,
  // its hint and the main button. It is the real input (autofill and password managers keep working).
  const phoneSideways = () => matchMedia('(pointer: coarse)').matches && window.innerWidth > window.innerHeight && window.innerHeight < 560;
  let kbTimer = 0;
  const placeStrip = () => {
    const vv = window.visualViewport;
    root.style.setProperty('--kb-top', `${vv ? vv.offsetTop : 0}px`);
    root.style.setProperty('--kb-h', `${vv ? vv.height : window.innerHeight}px`);
  };
  const stripOn = (input: HTMLInputElement) => {
    const card = root.querySelector('.ob.card') as HTMLElement | null; if (!card) return;
    window.clearTimeout(kbTimer);
    // marked with a data attribute: the screens rewrite their hints' classes as you type
    const keep = (e: Element | null | undefined) => e?.setAttribute('data-kb', '1');
    card.querySelectorAll('[data-kb]').forEach(e => e.removeAttribute('data-kb'));
    const field = input.closest('.field'); keep(field);
    // only the field being typed in: its siblings (a second password box, the dice) wait until the keyboard closes
    card.querySelectorAll('[data-kbin]').forEach(e => e.removeAttribute('data-kbin'));
    input.setAttribute('data-kbin', '1');
    // the hint that belongs to this field: the next .hint before any other field
    let sib = field?.nextElementSibling ?? null;
    while (sib && !sib.classList.contains('hint')) sib = sib.classList.contains('field') ? null : sib.nextElementSibling;
    keep(sib);
    keep(card.querySelector(':scope > .row'));
    let label = card.querySelector(':scope > .kb-label') as HTMLElement | null;
    if (!label) { label = document.createElement('div'); label.className = 'kb-label'; card.prepend(label); }
    keep(label);
    label.textContent = (input.placeholder || 'Type here').replace(/\s*\(.*\)$/, '').toUpperCase();
    card.style.transform = '';
    root.classList.add('kb'); placeStrip();
  };
  const stripOff = () => {
    kbTimer = window.setTimeout(() => { root.classList.remove('kb'); root.querySelector('.kb-label')?.remove(); requestAnimationFrame(fit); }, 150);
  };
  // Enter on the phone keyboard just finishes this field: the keyboard closes and the whole card comes back (the
  // screens' own Enter handlers, which submit, are not reached while the strip is up)
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !root.classList.contains('kb')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    (e.target as HTMLElement).blur?.();
  }, true);
  root.addEventListener('focusin', (e) => { const t = e.target; if (t instanceof HTMLInputElement && phoneSideways()) stripOn(t); });
  root.addEventListener('focusout', () => { if (root.classList.contains('kb')) stripOff(); });
  window.visualViewport?.addEventListener('resize', () => { if (root.classList.contains('kb')) placeStrip(); });
  window.visualViewport?.addEventListener('scroll', () => { if (root.classList.contains('kb')) placeStrip(); });

  const dots = (n: number) => `<div class="dots">${[1, 2, 3].map(i => `<i class="${i === n ? 'on' : i < n ? 'done' : ''}"></i>`).join('')}</div>`;
  const finish = (p: Profile) => { root.className = ''; root.innerHTML = ''; onDone(me ? { ...p, wallet: me } : p); };
  /** the profile on this device, if it belongs to the signed-in wallet */
  const mine = () => (store.profile && (!privy || store.profile.wallet === me) ? store.profile : null);

  // ---------------------------------------------------------------- 0. title
  const title = () => {
    const p = mine();
    root.innerHTML = `
    <div class="ob title split">
      ${WING_CASINO}
      <div class="mid spacer"><span class="and">&amp;</span></div>
      ${WING_CHURCH}
      <p class="tagline wide">Balance is survival.</p>
      <div class="under">
        <div class="cta row">${ctaHtml(p)}</div>
        <small class="fine" id="fine">${privy ? 'Solana devnet &middot; play money' : 'Offline demo &middot; play money'}</small>
      </div>
    </div>`;
    root.querySelector('#play')?.addEventListener('click', () => (privy ? void signInWithPrivy() : nameStep()));
    root.querySelector('#out')?.addEventListener('click', () => void signOutOfPrivy());
    root.querySelector('#new')?.addEventListener('click', () => { clearProfile(); store.profile = null; nameStep(); });
    root.querySelector('#cont')?.addEventListener('click', () => finish(p!));
    root.querySelector('#signin')?.addEventListener('click', signInStep);
    root.querySelector('#create')?.addEventListener('click', () => { draft.securing = false; nameStep(); });
    root.querySelector('#secure')?.addEventListener('click', () => { draft.securing = true; draft.name = p?.username ?? ''; nameStep(); });
    root.querySelector('#switch')?.addEventListener('click', () => {
      if (!confirm('Sign out on this device? You can sign back in any time with your username and password.')) return;
      backend.signOut?.(); clearProfile(); store.profile = null; title();
    });
  };
  /** the title's buttons. Live game: real accounts (username + password). Offline demo: no accounts. */
  const ctaHtml = (p: Profile | null) => {
    if (privy) {
      if (me && p) return `<button class="btn big pulse" id="cont"><span>CONTINUE</span><small>${p.username}</small></button><button class="btn ghost" id="out">SIGN OUT</button>`;
      return `<button class="btn big pulse play" id="play"><span>PLAY</span>${me ? `<small>${shortAddress(me)}</small>` : ''}</button>${me ? '<button class="btn ghost" id="out">SIGN OUT</button>' : ''}`;
    }
    if (!accounts) {
      return p ? `<button class="btn big pulse" id="cont"><span>CONTINUE</span><small>${p.username}</small></button><button class="btn ghost" id="new">NEW GAME</button>`
        : `<button class="btn big pulse" id="play">PLAY THE DEMO</button>`;
    }
    const linked = backend.linkedAccount?.();
    if (linked && p) return `<button class="btn big pulse" id="cont"><span>CONTINUE</span><small>${p.username}</small></button><button class="btn ghost" id="switch">SWITCH ACCOUNT</button>`;
    // a guest wallet from before accounts existed: let its owner keep the chips by setting a password
    if (!linked && backend.hasDeviceWallet?.()) return `<button class="btn big pulse" id="secure"><span>SECURE MY ACCOUNT</span><small>${p ? p.username : 'keep your chips'}</small></button><button class="btn ghost" id="signin">SIGN IN</button>`;
    return `<button class="btn big pulse" id="signin">SIGN IN</button><button class="btn ghost" id="create">SIGN UP</button>`;
  };

  // ---------------------------------------------------------------- Privy: PLAY opens its login over the live scene
  const say = (text: string, bad = false) => { const f = root.querySelector<HTMLElement>('#fine'); if (f) { f.textContent = text; f.classList.toggle('bad', bad); } };
  const signInWithPrivy = async () => {
    const b = root.querySelector<HTMLButtonElement>('#play'); if (!b || b.disabled) return;
    b.disabled = true; b.querySelector('span')!.textContent = me ? 'PLAY' : 'ONE MOMENT';
    try {
      const w = await loadWallet();
      b.disabled = false; b.querySelector('span')!.textContent = 'PLAY';   // the player may close Privy and press PLAY again
      const a = await w.login();
      if (!a) return;
      me = a;
      const p = mine();
      if (p) finish(p); else nameStep();
    } catch (e) {
      b.disabled = false; b.querySelector('span')!.textContent = 'PLAY';
      say(e instanceof Error ? e.message : 'Could not open sign-in. Try again.', true);
    }
  };
  const signOutOfPrivy = async () => {
    const b = root.querySelector<HTMLButtonElement>('#out'); if (!b || b.disabled) return;
    b.disabled = true;
    try { await (await loadWallet()).logout(); me = null; draft.name = ''; title(); } catch { b.disabled = false; say('Could not sign out. Try again.', true); }
  };

  // ---------------------------------------------------------------- sign in (any device)
  const signInStep = () => {
    root.innerHTML = `
    <div class="ob card px">
      <h2>Welcome back</h2>
      <p class="sub">Sign in to continue with your chips, LUCK and FAITH.</p>
      <div class="field col"><input id="su" maxlength="${NAME_MAX}" spellcheck="false" autocomplete="username" autocapitalize="off" placeholder="Username" value="${draft.name}" />
        <input id="sp" type="password" autocomplete="current-password" placeholder="Password" /></div>
      <small class="hint" id="s-hint">Your password never leaves this device.</small>
      <div class="row"><button class="btn ghost" id="back">BACK</button><button class="btn" id="go">SIGN IN</button></div>
    </div>`;
    const u = root.querySelector('#su') as HTMLInputElement, pw = root.querySelector('#sp') as HTMLInputElement;
    const go = root.querySelector('#go') as HTMLButtonElement, hint = root.querySelector('#s-hint') as HTMLElement;
    const submit = async () => {
      if (go.disabled) return;
      if (!u.value.trim() || !pw.value) { hint.textContent = 'Enter your username and password.'; hint.className = 'hint bad'; return; }
      if (!backend.linkedAccount?.() && backend.hasDeviceWallet?.()
        && !confirm('This device has a guest wallet with no password. Signing in replaces it, and its chips are lost unless you secure it first. Sign in anyway?')) return;
      go.disabled = true; go.textContent = 'UNLOCKING...'; hint.textContent = 'Unlocking your wallet on this device...'; hint.className = 'hint wait';
      try {
        const r = await backend.signIn!(u.value, pw.value);
        draft.name = r.username;
        if (r.avatar) finish({ username: r.username, avatar: r.avatar, startRealm: 'plaza' as any, toursDone: r.toursDone });
        else { draft.signedIn = r; avatarStep(); }
      } catch (e) {
        hint.textContent = e instanceof Error ? e.message : 'Could not sign in.'; hint.className = 'hint bad';
        go.disabled = false; go.textContent = 'SIGN IN';
      }
    };
    go.addEventListener('click', submit);
    [u, pw].forEach(i => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') void submit(); }));
    root.querySelector('#back')!.addEventListener('click', title);
    // desktop: straight into typing. Phones: show the whole form first; the keyboard comes up when the player taps a field
    if (window.matchMedia('(pointer: fine)').matches) (draft.name ? pw : u).focus();
  };

  // ---------------------------------------------------------------- 1. name
  const nameStep = () => {
    root.innerHTML = `
    <div class="ob card px">
      ${dots(1)}
      <h2>${!accounts ? 'What shall we call you, wanderer?' : draft.securing ? 'Secure your account' : 'Create your account'}</h2>
      <p class="sub">${accounts ? 'Your username is how you sign in, on any device.' : 'Your name travels between both worlds.'}</p>
      <div class="field">
        <input id="nm" maxlength="${NAME_MAX}" spellcheck="false" autocomplete="${accounts ? 'username' : 'off'}" autocapitalize="off" placeholder="${accounts ? 'Username' : 'Your name'}" value="${draft.name}" />
        <button class="btn ghost sq" id="dice" title="Random name">${icon('dice', 20)}</button>
      </div>
      <small class="hint" id="nm-hint">3 to ${NAME_MAX} letters or numbers. Names are unique.</small>
      ${accounts ? `<div class="field col"><input id="pw1" type="password" autocomplete="new-password" placeholder="Password" />
        <input id="pw2" type="password" autocomplete="new-password" placeholder="Type it again" /></div>
      <small class="hint" id="pw-hint">At least ${PASSWORD_MIN} characters. We never see it: forget it and the account cannot be recovered.</small>` : ''}
      <div class="wallet-note" id="wnote" hidden></div>
      <div class="row"><button class="btn ghost" id="back">BACK</button><button class="btn" id="next" disabled>NEXT</button></div>
    </div>`;
    const inp = root.querySelector('#nm') as HTMLInputElement, next = root.querySelector('#next') as HTMLButtonElement;
    const hint = root.querySelector('#nm-hint') as HTMLElement;
    const say = (t: string, kind: '' | 'ok' | 'bad' | 'wait') => { hint.textContent = t; hint.className = `hint ${kind}`; };
    // rules locally, then (debounced) ask the server whether the name is free; the newest answer wins
    let seq = 0, timer = 0;
    const check = () => {
      inp.value = inp.value.replace(/[^A-Za-z0-9_' -]/g, '').slice(0, NAME_MAX);
      draft.name = cleanName(inp.value);
      const problem = draft.name ? nameProblem(draft.name) : null;
      window.clearTimeout(timer);
      if (!draft.name) { next.disabled = true; say(`3 to ${NAME_MAX} letters or numbers. Names are unique.`, ''); return; }
      if (problem) { next.disabled = true; say(problem, 'bad'); return; }
      if (!backend.checkName) { next.disabled = false; say('', 'ok'); return; }
      next.disabled = true; say('Checking...', 'wait');
      const mine = ++seq, name = draft.name;
      timer = window.setTimeout(async () => {
        const r = await backend.checkName!(name).catch(() => ({ available: true } as { available: boolean; reason?: string }));
        if (mine !== seq) return;
        next.disabled = !r.available;
        say(r.available ? `\u2713 ${name} is yours` : (r.reason ?? 'That name is taken'), r.available ? 'ok' : 'bad');
      }, 350);
    };
    inp.addEventListener('input', check); check();
    // say what happens to the wallet, briefly and truthfully
    const note = root.querySelector('#wnote') as HTMLElement;
    note.innerHTML = accounts
      ? `${icon('wallet', 12)}<span>${draft.securing ? 'Your NEAR wallet on this device' : 'A NEAR wallet is created for you. It'} is encrypted with your password on this device; our server only ever stores that locked copy.</span>`
      : me ? `${icon('wallet', 12)}<span>Your Solana wallet ${shortAddress(me)} is ready.</span>`
      : `${icon('wallet', 12)}<span>Demo mode: chips are pretend and nothing is saved on chain.</span>`;
    note.hidden = false;
    // live game: the password creates (or secures) the account before the avatar step
    const pw1 = root.querySelector('#pw1') as HTMLInputElement | null, pw2 = root.querySelector('#pw2') as HTMLInputElement | null;
    const pwHint = root.querySelector('#pw-hint') as HTMLElement | null;
    const proceed = async () => {
      if (next.disabled) return;
      if (!accounts) return storyStep();
      const bad = passwordProblem(pw1!.value) ?? (pw1!.value !== pw2!.value ? 'The two passwords do not match' : null);
      if (bad) { pwHint!.textContent = bad; pwHint!.className = 'hint bad'; return; }
      next.disabled = true; next.textContent = 'CREATING...';
      pwHint!.textContent = draft.securing ? 'Locking your wallet with your password...' : 'Creating your wallet and locking it with your password...'; pwHint!.className = 'hint wait';
      try {
        await backend.signUp!(draft.name, pw1!.value);
        draft.created = true;
        // a guest who already has a character goes straight back in
        const p = store.profile;
        if (draft.securing && p) return finish({ ...p, username: draft.name });
        storyStep();
      } catch (e) {
        pwHint!.textContent = e instanceof Error ? e.message : 'Could not create the account.'; pwHint!.className = 'hint bad';
        next.disabled = false; next.textContent = 'NEXT';
      }
    };
    [inp, pw1, pw2].forEach(i => i?.addEventListener('keydown', (e) => { if (e.key === 'Enter') void proceed(); }));
    root.querySelector('#dice')!.addEventListener('click', () => { inp.value = randomName(); check(); });
    root.querySelector('#back')!.addEventListener('click', title);
    next.addEventListener('click', () => void proceed());
  };

  // ---------------------------------------------------------------- the backstory (new players, before the character)
  const storyStep = () => (opts.agent ? avatarStep() : openBook(root, avatarStep));      // ?agent=1: straight to the character

  // ---------------------------------------------------------------- 2. avatar
  const avatarStep = () => {
    root.innerHTML = `
    <div class="ob card wide px">
      ${dots(2)}
      <h2>Choose your wanderer</h2>
      <div class="av-wrap">
        <div class="av-grid" id="grid">
          ${AVATARS.map(a => `<button class="av ${a.id === draft.avatar ? 'sel' : ''}" data-id="${a.id}" aria-label="${a.name}"><div class="spr idle" style="${spriteCss(a.id, 'idle_down', k)}"></div><span>${a.name.replace('The ', '')}</span></button>`).join('')}
        </div>
        <div class="av-prev px2">
          <div class="stage"><div class="spr walk" id="prev" style="${spriteCss(draft.avatar, 'walk_down', k + 2)}"></div><div class="shadow"></div></div>
          <b id="av-name"></b><small id="av-blurb"></small>
        </div>
      </div>
      <div class="row">${draft.created || draft.signedIn ? '' : '<button class="btn ghost" id="back">BACK</button>'}<button class="btn ghost" id="lore">&#128214; BACKSTORY</button><button class="btn big" id="next">NEXT</button></div>
    </div>`;
    const upd = () => {
      const a = AVATARS.find(x => x.id === draft.avatar)!;
      (root.querySelector('#prev') as HTMLElement).setAttribute('style', spriteCss(a.id, 'walk_down', k + 2));
      root.querySelector('#av-name')!.textContent = a.name; root.querySelector('#av-blurb')!.textContent = a.blurb;
      root.querySelectorAll('.av').forEach(b => b.classList.toggle('sel', (b as HTMLElement).dataset.id === a.id));
    };
    root.querySelectorAll<HTMLElement>('.av').forEach(b => b.addEventListener('click', () => { draft.avatar = b.dataset.id!; upd(); }));
    upd();
    root.querySelector('#back')?.addEventListener('click', nameStep);
    root.querySelector('#lore')!.addEventListener('click', () => storyStep());   // the book again; START comes back here
    root.querySelector('#next')!.addEventListener('click', () => (opts.agent
      ? finish({ username: draft.name, avatar: draft.avatar, startRealm: 'plaza' as any, toursDone: { casino: true, church: true } })
      : howStep()));
  };

  // ---------------------------------------------------------------- 3. how to play
  const howStep = () => {
    root.innerHTML = `
    <div class="ob card wide px howcard">
      ${dots(3)}
      <h2>How to play</h2>
      ${howToHtml()}
      <div class="row"><button class="btn ghost" id="back">BACK</button><button class="btn big" id="go">LET'S GO</button></div>
    </div>`;
    playHowTo(root);
    root.querySelector('#back')!.addEventListener('click', avatarStep);
    root.querySelector('#go')!.addEventListener('click', () => finish({ username: draft.name, avatar: draft.avatar, startRealm: 'plaza' as any, toursDone: draft.signedIn?.toursDone ?? { casino: false, church: false } }));
  };

  title();
  // load Privy behind the title: PLAY opens at once, and somebody already signed in sees CONTINUE
  if (privy) void loadWallet().then((w) => { if (!w.address() || me || !root.querySelector('#play')) return; me = w.address(); title(); }).catch(() => { /* PLAY tries again and says why */ });
}

/** "Tap to start": the first user gesture, which is what lets the browser play music from the home page on. */
export function showSplash(onTap: () => void): Promise<void> {
  return new Promise((res) => {
    const root = document.getElementById('onboarding')!;
    root.className = 'show';
    root.innerHTML = `
    <div class="ob title split splash">
      ${WING_CASINO}
      <div class="mid spacer"><span class="and">&amp;</span></div>
      ${WING_CHURCH}
      <p class="tagline wide">Balance is survival.</p>
      <div class="under">
        <div class="tap">TAP TO START</div>
        <small class="fine">Best played in landscape with sound on${(/iPhone|iPad/.test(navigator.userAgent) && !(navigator as any).standalone) ? '<br>For full screen: Share \u2192 Add to Home Screen' : ''}</small>
      </div>
    </div>`;
    const go = () => { window.removeEventListener('keydown', go); root.removeEventListener('pointerdown', go); onTap(); res(); };
    root.addEventListener('pointerdown', go); window.addEventListener('keydown', go);
  });
}

// ---------------------------------------------------------------- the backstory: an open book, typed by hand
  // paragraphs of lines (each line starts on its own row; a paragraph adds space before the next)
  const STORY: string[][] = [
    ['Most believe crypto is one thing. They are wrong.'],
    ['It is two.'],
    ['On one side lies The Casino — flashing lights, spinning wheels, memecoin madness. Fortunes made, fortunes lost. It is exhilarating, unpredictable, intoxicating.'],
    ['On the other side stands The Church — a hall of sermons, prophecy, and belief. Here, the faithful argue over visions of tomorrow, promising freedom and salvation through code. It is solemn, righteous, inspiring.'],
    ['But here is the truth:', 'The Casino funds the Church.', 'The Church built the Casino.', 'Neither can live without the other.'],
    ['In this game, you are a wanderer between the two realms.'],
    ['In the Casino, your LUCK will rise and fall as you play the casino games.', 'In the Church, your FAITH will grow through writing, quests, and prophecy.'],
    ['But beware—if you spend too long in one realm, the other will fade.', 'Too much gambling, and your FAITH begins to crumble.', 'Too much preaching, and your LUCK runs dry.'],
    ['Balance is survival.', 'LUCK fuels FAITH.', 'FAITH shapes LUCK.', 'Together, they decide your fate.'],
    ['Welcome to The Casino and The Church.'],
  ];
export function openBook(root: HTMLElement, onDone: () => void, doneLabel = 'START', skipLabel = 'SKIP') {
  {
    root.innerHTML = `
    <div class="ob storybook">
      <div class="book">
        <div class="page left" id="pl"><div class="flow" id="fl"><h1 class="bk-h1">BACKSTORY</h1><div class="bk-orn"><i></i><span>&#10022;</span><i></i></div></div><span class="folio">i</span></div>
        <div class="spine"></div>
        <div class="page right" id="pr"><div class="flow" id="fr"></div><span class="folio">ii</span></div>
      </div>
      <div class="bk-bar"><button class="btn ghost" id="skip">${skipLabel}</button><button class="btn big pulse" id="start" hidden>${doneLabel}</button></div>
    </div>`;
    const book = root.querySelector('.book') as HTMLElement;
    const pages = [root.querySelector('#fl') as HTMLElement, root.querySelector('#fr') as HTMLElement];
    const folios = [...root.querySelectorAll<HTMLElement>('.folio')];
    let side = 0, spread = 1, fast = false, alive = true, timer = 0;
    const caret = document.createElement('i'); caret.className = 'bk-caret';
    const fits = (el: HTMLElement) => el.scrollHeight <= el.clientHeight + 1;
    const wait = (ms: number) => new Promise<void>((r) => { timer = window.setTimeout(r, fast ? Math.min(ms, 6) : ms); });
    /** a human typist: uneven keys, a breath after commas, a pause after a sentence */
    const keyDelay = (ch: string) => 0.756 * (ch === '.' || ch === ':' || ch === '—' ? 260 : ch === ',' ? 140 : ch === ' ' ? 45 + Math.random() * 50 : 28 + Math.random() * 42 + (Math.random() < 0.06 ? 120 : 0));
    /**
     * The page is full: go on to the right page, or turn the page. The turning leaf IS the right page (its writing on
     * the front); its back is the next blank left page. The old left page keeps its writing until the leaf lands on
     * it, and the next blank right page lies underneath, so nothing ever just vanishes.
     */
    const nextPage = async () => {
      if (side === 0) { side = 1; return; }
      await wait(fast ? 120 : 650);
      const pr = root.querySelector('#pr') as HTMLElement;
      const leaf = document.createElement('div'); leaf.className = 'bk-leaf';
      leaf.style.cssText = `left:${pr.offsetLeft}px;top:${pr.offsetTop}px;width:${pr.offsetWidth}px;height:${pr.offsetHeight}px`;
      const front = pr.cloneNode(true) as HTMLElement; front.removeAttribute('id'); front.className = 'page right bk-face front';
      front.querySelectorAll('[id]').forEach(e => e.removeAttribute('id')); front.querySelector('.bk-caret')?.remove();
      const back = document.createElement('div'); back.className = 'page left bk-face back';
      back.innerHTML = `<div class="flow"></div><span class="folio">${toRoman(spread * 2 + 1)}</span>`;
      leaf.append(front, back);
      book.append(leaf);
      // under the leaf: the next blank right page (hidden by the leaf until it lifts), in the leaf's shadow
      pages[1].innerHTML = ''; folios[1].textContent = toRoman(spread * 2 + 2);
      const shade = document.createElement('div'); shade.className = 'bk-shade'; pr.append(shade);
      const ms = fast ? 420 : 1100;
      leaf.style.setProperty('--turn', `${ms}ms`); shade.style.animationDuration = `${ms}ms`;
      await new Promise<void>((r) => { timer = window.setTimeout(r, ms); });
      // the leaf has landed on the left: it becomes the new left page
      pages[0].innerHTML = ''; folios[0].textContent = toRoman(spread * 2 + 1);
      leaf.remove(); shade.remove();
      spread++; side = 0;
    };
    const toRoman = (n: number) => ['', 'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii'][n] ?? String(n);
    /** a new line block on the current page; if even an empty one does not fit, move on first */
    const newLine = async (cls: string) => {
      for (let tries = 0; tries < 3; tries++) {
        const p = document.createElement('p'); p.className = cls; p.append(caret);
        pages[side].append(p);
        p.insertBefore(document.createTextNode('M'), caret);              // room for at least one line of text?
        const ok = fits(pages[side]); p.firstChild!.remove();
        if (ok) return p;
        p.remove(); await nextPage();
      }
      throw new Error('page too small');
    };
    const typeLine = async (text: string, cls: string) => {
      let p = await newLine(cls);
      const words = text.split(' ');
      for (let w = 0; w < words.length; w++) {
        if (!alive) return;
        const word = (w ? ' ' : '') + words[w];
        // will the whole word fit here? if not, it goes on the next page (the line continues there)
        const probe = document.createTextNode(word); p.insertBefore(probe, caret);
        const ok = fits(pages[side]); probe.remove();
        if (!ok) { await nextPage(); p = await newLine(`${cls} cont`); }
        const t = document.createTextNode(''); p.insertBefore(t, caret);
        for (const ch of (p.textContent === '' && word.startsWith(' ') ? word.slice(1) : word)) {
          if (!alive) return;
          t.data += ch; await wait(keyDelay(ch));
        }
      }
    };
    const run = async () => {
      await wait(500);
      for (let i = 0; i < STORY.length && alive; i++) {
        const last = i === STORY.length - 1;
        for (let j = 0; j < STORY[i].length && alive; j++) {
          await typeLine(STORY[i][j], `${j === 0 ? 'para' : 'line'}${last ? ' welcome' : ''}`);
        }
        await wait(fast ? 0 : 320);
      }
      if (!alive) return;
      (root.querySelector('#skip') as HTMLElement).hidden = true;
      (root.querySelector('#start') as HTMLElement).hidden = false;
    };
    const leave = () => { alive = false; window.clearTimeout(timer); window.removeEventListener('keydown', onKey); onDone(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!(root.querySelector('#start') as HTMLElement).hidden) leave(); else fast = true; } };
    window.addEventListener('keydown', onKey);
    book.addEventListener('click', () => { fast = true; });                 // tap the book: the typist hurries
    root.querySelector('#skip')!.addEventListener('click', leave);
    root.querySelector('#start')!.addEventListener('click', leave);
    void run().catch(() => { /* a page too small to type on: let them go on */ (root.querySelector('#start') as HTMLElement).hidden = false; });
  }
}

/** the backstory book over the game (from Settings): the world waits while it is open */
export function showBackstory() {
  const root = document.getElementById('onboarding')!;
  root.className = 'show';
  bus.emit('modalOpened');
  openBook(root, () => { root.className = ''; root.innerHTML = ''; bus.emit('modalClosed'); }, 'CLOSE THE BOOK', 'CLOSE');
}
