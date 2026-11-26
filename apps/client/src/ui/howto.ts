/** "How to play": a short numbered list, one plain sentence per step, typed out line by line.
 *  Shared by the onboarding (step 3) and Settings. Wording adapts to touch vs keyboard. */
function steps(): string[] {
  const touch = window.matchMedia('(pointer: coarse)').matches;
  return [
    'You start at the Crossroads, between the Casino and the Church.',
    touch ? 'Drag anywhere on the screen to walk, or tap where you want to go.' : 'Walk with the arrow keys or WASD, or click where you want to go.',
    'Head left for the Casino, right for the Church.',
    'Each host meets you at the door. Follow them for a short tour.',
    touch ? 'Stand in front of a game and tap its gold label to play.' : 'Stand in front of a game and press X (or click its gold label) to play.',
    'Casino bets fill your LUCK. Candles, tithes and quests fill your FAITH.',
    'LUCK fades in the Church. FAITH fades in the Casino.',
    'Keep both above 50 to spin the Harmony Wheel at the Crossroads.',
  ];
}

/** Each line renders twice: an invisible copy that reserves the final size (so nothing jumps), and a live copy that types. */
export function howToHtml(): string {
  const e = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
    .replace(/\bLUCK\b/g, '<b class="lk">LUCK</b>').replace(/\bFAITH\b/g, '<b class="fa">FAITH</b>');
  return `<ol class="howlist">${steps().map((s, i) => `<li data-i="${i}"><span class="hl-n">${i + 1}</span><span class="hl-t"><span class="hl-ghost">${e(s)}</span><span class="hl-live" data-html="${e(s).replace(/"/g, '&quot;')}"></span></span></li>`).join('')}</ol>
    <p class="hl-foot">Chips are free play money on Solana devnet.</p>`;
}

/** Type the list out, one line after another. A tap or click on the list shows everything at once. */
export function playHowTo(root: ParentNode) {
  const list = root.querySelector<HTMLElement>('.howlist'); if (!list) return;
  const items = [...list.querySelectorAll<HTMLElement>('li')];
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let timer = 0, done = false;
  const finish = () => {
    done = true; window.clearTimeout(timer);
    items.forEach(li => { const live = li.querySelector<HTMLElement>('.hl-live')!; live.innerHTML = live.dataset.html!; li.classList.add('on', 'done'); });
  };
  if (reduce) return finish();
  list.addEventListener('pointerdown', finish, { once: true });
  // type plain text, then swap in the highlighted words when the line is complete
  const typeLine = (k: number) => {
    if (done || !list.isConnected) return;
    if (k >= items.length) { done = true; return; }
    const li = items[k], live = li.querySelector<HTMLElement>('.hl-live')!;
    const tmp = document.createElement('div'); tmp.innerHTML = live.dataset.html!;
    const text = tmp.textContent ?? '';
    li.classList.add('on');
    let n = 0;
    const tick = () => {
      if (done || !list.isConnected) return;
      n = Math.min(text.length, n + 2); live.textContent = text.slice(0, n);
      if (n < text.length) { timer = window.setTimeout(tick, 22); return; }
      live.innerHTML = live.dataset.html!; li.classList.add('done');
      timer = window.setTimeout(() => typeLine(k + 1), 260);
    };
    tick();
  };
  timer = window.setTimeout(() => typeLine(0), 250);
}
