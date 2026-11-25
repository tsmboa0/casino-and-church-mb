/** "The rollup is updating": shown while it does not answer. It happened twice on 25 Nov; nothing was lost either time. */
let el: HTMLElement | null = null;
export function rollupBanner(on: boolean) {
  if (on === !!el) return;
  if (!on) { el?.remove(); el = null; return; }
  el = document.createElement('div'); el.id = 'rollup-banner'; el.setAttribute('role', 'status');
  el.innerHTML = '<b>THE TABLES ARE PAUSED</b><span>The rollup is catching its breath. Your chips and bets are safe. This clears by itself.</span>';
  document.body.appendChild(el);
}
