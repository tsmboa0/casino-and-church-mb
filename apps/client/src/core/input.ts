/**
 * One input surface for keyboard, touch and (later) gamepad.
 * The game never reads raw device events (PLAN §5.4).
 */
export type Btn = 'interact' | 'cancel' | 'menu' | 'context';

class InputState {
  /** held directions, -1..1 */
  x = 0;
  y = 0;
  run = false;
  private held = new Set<string>();
  private edge: Record<Btn, boolean> = { interact: false, cancel: false, menu: false, context: false };
  private down: Record<Btn, boolean> = { interact: false, cancel: false, menu: false, context: false };
  // direction sources (merged)
  private touchDir = { x: 0, y: 0 };
  enabled = true;

  constructor() {
    const map: Record<string, Btn> = {
      z: 'interact', Enter: 'interact', ' ': 'interact',
      x: 'cancel', Escape: 'cancel',
      c: 'menu', v: 'context',
    };
    window.addEventListener('keydown', (e) => {
      const tg = e.target as HTMLElement | null;
      if (!e.key || (tg && (/^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName) || tg.isContentEditable))) return;      // typing is not playing; autofill sends key events with no key
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
      if (!e.repeat) {
        this.held.add(k);
        if (map[k]) this.press(map[k]);
      }
      this.recompute();
    });
    window.addEventListener('keyup', (e) => {
      if (!e.key) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      this.held.delete(k);
      if (map[k]) this.release(map[k]);
      this.recompute();
    });
    window.addEventListener('blur', () => { this.held.clear(); this.recompute(); });
  }

  private recompute() {
    const h = this.held;
    let x = (h.has('ArrowRight') || h.has('d') ? 1 : 0) - (h.has('ArrowLeft') || h.has('a') ? 1 : 0);
    let y = (h.has('ArrowDown') || h.has('s') ? 1 : 0) - (h.has('ArrowUp') || h.has('w') ? 1 : 0);
    if (x === 0) x = this.touchDir.x;
    if (y === 0) y = this.touchDir.y;
    this.x = x; this.y = y;
    this.run = false;                    // one pace everywhere: a normal walk (no running on hard pushes, swipes or held buttons)
  }

  setTouchDir(x: number, y: number) { this.touchDir = { x, y }; this.recompute(); }
  press(b: Btn) { if (!this.down[b]) this.edge[b] = true; this.down[b] = true; this.recompute(); }
  release(b: Btn) { this.down[b] = false; this.recompute(); }
  /** true once per press */
  pressed(b: Btn): boolean { const v = this.edge[b]; this.edge[b] = false; return v && this.enabled; }
  isDown(b: Btn) { return this.down[b]; }
  clearEdges() { (Object.keys(this.edge) as Btn[]).forEach(k => (this.edge[k] = false)); }
}
export const input = new InputState();
