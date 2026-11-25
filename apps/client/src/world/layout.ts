/**
 * The world, declared as data — revision 3 (designed zones, no coordinate-compaction maps).
 *
 *   87 x 31 tiles (1392 x 496 px). Rows 0-1 are the north wall faces, the floor is rows 2..28, row 29 is the south cap.
 *
 *     cols  0..38   THE CASINO      entrance on the east wall (col 39), boulevard rows 9..11
 *     cols 40..45   THE CROSSROADS  the road between the realms; the Harmony Wheel stands on its north side
 *     cols 47..86   THE CHURCH      entrance on the west wall (col 46); cross-shaped: the boulevard is the transept,
 *                                   the nave runs north-south with the altar at the north wall
 *
 * Every coordinate below is a WORLD tile. Props are placed by their BOTTOM-LEFT tile (tx, ty = the sprite's lowest row).
 */
import { TILE, WORLD_W, CASINO_WALL_X, CHURCH_WALL_X, DOOR_Y0, DOOR_Y1, FLOOR_BOTTOM, type Facing } from '../config';

export interface Rect { x: number; y: number; w: number; h: number }
export type Sizes = Record<string, { w: number; h: number }>;

export type GroundOp =
  | { t: 'frame'; name: string; x: number; y: number }
  | { t: 'rect'; x: number; y: number; w: number; h: number; color: string };

export interface GlowDef { color: number; r: number; a: number; dx?: number; dy?: number; flicker?: number }
export interface PropDef {
  key: string; x: number; y: number;            // px, bottom-left
  solid: Rect | null;                           // px, world space (resolved)
  anim: boolean;
  high?: boolean;                               // always drawn above characters (ceiling things)
  flip?: boolean; tint?: number; alpha?: number; scale?: number;
  glow?: GlowDef;
}
export interface LightDef { x: number; y: number; r: number; color: number; a: number; flicker?: number }
export interface ShaftDef { x: number; y: number; w: number; h: number; color: number; a: number; skew: number }
/** around: the floor beside/behind the machine; standing there shows a "come round the front" hint, spoken by `op` (an npc id) if set */
export interface Interactable { id: string; kind: string; label: string; rect: Rect; npc?: string; around?: Rect; op?: string }
export interface NpcDef {
  id: string; char: string; name: string; x: number; y: number; facing: Facing;
  role: 'owner' | 'priest' | 'patron'; wander?: Rect; speed?: number;
}
export interface DoorDef { key: string; x: number; y: number; trigger: Rect }
export interface Spawn { x: number; y: number }
export interface SignDef { x: number; y: number; text: string; kind: 'sale' | 'casino' | 'church' | 'zone' | 'tag' | 'dirL' | 'dirR' | 'gateC' | 'gateH' | 'ticker' | 'limit' | 'btc'; anchor?: string; plot?: number }
export interface PlotSpot { id: number; x: number; y: number }   // world px: bottom-centre of the plot, where the machine stands
export interface BarDef extends Rect { style: 'casino' | 'church' | 'plaza' }

export interface World {
  ops: GroundOp[];
  bars: BarDef[];
  props: PropDef[];
  colliders: Rect[];
  lights: LightDef[];
  shafts: ShaftDef[];
  interactables: Interactable[];
  npcs: NpcDef[];
  doors: DoorDef[];
  signs: SignDef[];
  plots: PlotSpot[];
  spawns: { casino: Spawn; church: Spawn };
  hosts: { casino: Spawn; church: Spawn };
  routes: { casino: Spawn[]; church: Spawn[] };
  plazaCenter: Spawn;
}

const pad = (n: number) => String(n).padStart(3, '0');
const T = TILE;
/** generated textures (PreloadScene) that props can use */
const GEN: Sizes = { 'x/confess': { w: 48, h: 48 }, 'x/ledger': { w: 32, h: 24 }, 'x/board': { w: 64, h: 48 }, 'x/craps': { w: 128, h: 64 }, 'x/pillar': { w: 16, h: 48 }, 'x/fortune': { w: 48, h: 72 }, 'x/harmony': { w: 48, h: 72 }, 'x/tradewall': { w: 128, h: 64 }, 'x/bull': { w: 24, h: 24 }, 'x/bear': { w: 24, h: 24 }, 'x/commission': { w: 48, h: 40 } };

function hash(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function buildWorld(sizes: Sizes): World {
  const ops: GroundOp[] = [];
  const bars: BarDef[] = [];
  const props: PropDef[] = [];
  const colliders: Rect[] = [];
  const lights: LightDef[] = [];
  const shafts: ShaftDef[] = [];
  const interactables: Interactable[] = [];
  const npcs: NpcDef[] = [];
  const doors: DoorDef[] = [];
  const signs: SignDef[] = [];
  const plots: PlotSpot[] = [];

  // ------------------------------------------------------------------ ground helpers
  type Fam = 'cf' | 'mf';
  const frame = (name: string, tx: number, ty: number) => ops.push({ t: 'frame', name, x: tx * T, y: ty * T });
  const fvar = (p: Fam, base: number, x0: number, y0: number, w: number, h: number, wt = [5, 2, 2, 1]) => {
    const tot = wt.reduce((a, b) => a + b, 0);
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      let r = hash(x, y) % tot, i = 0;
      while (r >= wt[i]) { r -= wt[i]; i++; }
      frame(`${p}/${pad(base + i)}`, x, y);
    }
  };
  const fblock = (p: Fam, base: number, x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) frame(`${p}/${pad(base + (y % 2) * 2 + (x % 2))}`, x, y);
  };
  const rug = (p: Fam, ids: number[], x0: number, y0: number, w: number, h: number) => {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const col = w === 1 ? 1 : i === 0 ? 0 : i === w - 1 ? 2 : 1;
      const row = h === 1 ? 1 : j === 0 ? 0 : j === h - 1 ? 2 : 1;
      frame(`${p}/${pad(ids[row * 3 + col])}`, x0 + i, y0 + j);
    }
  };
  /** A runner network: the union of rectangles is framed as ONE carpet (borders only on the outside). */
  const roads = (p: Fam, ids: number[], rects: Rect[]) => {
    const m = new Set<string>();
    rects.forEach(r => { for (let j = 0; j < r.h; j++) for (let i = 0; i < r.w; i++) m.add(`${r.x + i},${r.y + j}`); });
    const has = (x: number, y: number) => m.has(`${x},${y}`);
    m.forEach(k => {
      const [x, y] = k.split(',').map(Number);
      const w = has(x - 1, y), e = has(x + 1, y), n = has(x, y - 1), s = has(x, y + 1);
      const col = !w && e ? 0 : w && !e ? 2 : 1;
      const row = !n && s ? 0 : n && !s ? 2 : 1;
      frame(`${p}/${pad(ids[row * 3 + col])}`, x, y);
    });
  };
  const RUG = {
    cRed: [112, 113, 114, 127, 128, 129, 142, 143, 144],
    cGreen: [118, 119, 120, 133, 134, 135, 148, 149, 150],
    mRed: [89, 90, 91, 98, 99, 100, 107, 108, 109],
    mBlue: [92, 93, 94, 101, 102, 103, 110, 111, 112],
    mGold: [95, 96, 97, 104, 105, 106, 113, 114, 115],
  };
  const wallStrip = (set: string, x0: number, y0: number, ids: number[]) => ids.forEach((id, i) => frame(`${set}/${pad(id)}`, x0 + i, y0));
  const bar = (x: number, y: number, w: number, h: number, style: BarDef['style']) => bars.push({ x, y, w, h, style });
  const block = (x: number, y: number, w: number, h: number) => colliders.push({ x, y, w, h });

  // ------------------------------------------------------------------ prop helpers
  const sz = (key: string) => GEN[key] ?? sizes[key] ?? { w: 16, h: 16 };
  interface PO { solid?: false | Rect; high?: boolean; flip?: boolean; tint?: number; alpha?: number; scale?: number; still?: boolean; glow?: GlowDef; dx?: number; dy?: number }
  const P = (key: string, tx: number, ty: number, o: PO = {}): PropDef => {
    const { w, h } = sz(key);
    const x = tx * T + (o.dx ?? 0), y = (ty + 1) * T + (o.dy ?? 0);
    let solid: Rect | null = null;
    if (o.solid !== false) {
      if (o.solid) solid = { x: x + o.solid.x, y: y - h + o.solid.y, w: o.solid.w, h: o.solid.h };
      else { const fh = Math.max(8, Math.min(h - 6, Math.round(h * 0.62))); solid = { x: x + 1, y: y - fh, w: w - 2, h: fh }; }
    }
    const p: PropDef = { key, x, y, solid, anim: !o.still, high: o.high, flip: o.flip, tint: o.tint, alpha: o.alpha, scale: o.scale, glow: o.glow };
    props.push(p);
    if (solid) colliders.push(solid);
    return p;
  };
  const light = (tx: number, ty: number, r: number, color: number, a = 0.5, flicker = 0) => lights.push({ x: tx * T, y: ty * T, r, color, a, flicker });
  const NS = false as const;
  const CANDLE = { color: 0xffb347, r: 20, a: 0.42, dx: 8, dy: -22, flicker: 0.12 };
  const CHAND = { color: 0xffd27a, r: 46, a: 0.24, dx: 24, dy: -6, flicker: 0.03 };
  const patron = (id: string, char: string, name: string, tx: number, ty: number, f: Facing) =>
    npcs.push({ id, char, name, x: tx * T + 8, y: ty * T + 14, facing: f, role: 'patron' });
  const area = (tx: number, ty: number, w: number, h: number): Rect => ({ x: tx * T, y: ty * T, w: w * T, h: h * T });
  const tag = (tx: number, ty: number, text: string) => signs.push({ x: tx * T, y: ty * T, text, kind: 'tag', anchor: '-50%, -50%' });

  const CW = CASINO_WALL_X / T, HW = CHURCH_WALL_X / T;                  // wall columns 39 and 46
  const botY = FLOOR_BOTTOM;                                              // 464 (29 * 16)
  const midY = (DOOR_Y0 + DOOR_Y1) / 2;                                   // centre of the boulevard (world px)

  // =====================================================================================
  //  GROUND
  // =====================================================================================
  // ---- casino: ONE carpet; zones are made by marble platforms, railings and light, not by a patchwork of rugs
  fvar('cf', 1, 0, 2, 39, 27);                                  // red medallion carpet everywhere
  fblock('cf', 33, 0, 2, 9, 5);                                 // Fortuna's office: parquet
  fblock('cf', 21, 30, 2, 9, 7);                                // cashier: marble
  fblock('cf', 21, 17, 3, 5, 6);                                // the Wheel of Fortune dais: marble
  fblock('cf', 33, 0, 21, 11, 8);                               // lounge: parquet
  fblock('cf', 21, 12, 21, 16, 8);                              // founders' gallery: marble
  [13, 18, 23].forEach(px => rug('cf', RUG.cGreen, px, 23, 4, 4)); // the three plot pads
  roads('cf', RUG.cRed, [
    { x: 1, y: 9, w: 38, h: 3 },                                // the Boulevard
    { x: 28, y: 12, w: 2, h: 7 },                               // Pit Avenue
    { x: 1, y: 19, w: 37, h: 2 },                               // the south promenade
  ]);

  // ---- crossroads: cobbles on the road, a stone dais for the Harmony Wheel, a dim garden south of the barrier
  fvar('mf', 1, 40, 2, 6, 10, [4, 2, 2, 1]);
  fblock('mf', 21, 41, 3, 4, 6);
  fvar('mf', 45, 40, 12, 6, 17, [3, 2, 2, 1]);

  // ---- church
  fblock('mf', 21, 47, 2, 40, 27);                              // stone slabs
  fvar('mf', 29, 57, 2, 17, 4);                                 // the sanctuary: red and gold tiles
  fblock('mf', 61, 77, 2, 10, 5);                               // the sanctum: wood
  fblock('mf', 61, 77, 12, 10, 9);                              // the scriptorium: wood
  fvar('mf', 13, 70, 22, 17, 7);                                // pilgrims' hall: planks
  fvar('mf', 45, 47, 22, 14, 7, [3, 2, 2, 1]);                  // the cloister garden
  roads('mf', RUG.mGold, [
    { x: 47, y: 9, w: 39, h: 3 },                               // the transept (the Boulevard)
    { x: 64, y: 5, w: 3, h: 23 },                               // the nave aisle, from the altar to the font
  ]);

  // ---- the two realm walls
  [CW, HW].forEach(c => {
    ops.push({ t: 'rect', x: c * T, y: 2 * T, w: T, h: DOOR_Y0 - 2 * T, color: '#2b2740' });
    ops.push({ t: 'rect', x: c * T, y: DOOR_Y1, w: T, h: botY - DOOR_Y1, color: '#2b2740' });
  });

  // =====================================================================================
  //  WALLS
  // =====================================================================================
  // casino north wall: office panelling (0..8), casino wall (9..29), cashier lobby (30..38)
  const north: number[] = [];
  for (let x = 9; x < 30; x++) north.push([1, 2, 3][x % 3]);
  [12, 26].forEach(x => (north[x - 9] = 5));
  wallStrip('cw/vip', 0, 0, [1, 2, 5, 1, 8, 9, 10, 2, 5]);
  wallStrip('cw/casino', 9, 0, north);
  wallStrip('cw/lobby', 30, 0, [1, 2, 5, 1, 2, 3, 5, 1, 2]);
  wallStrip('cw/vip', 0, 7, [1, 2, 3, 3, 1, 1, 2, 3, 1]);               // office south face (door at cols 4..5)
  wallStrip('mw/town', 39, 0, [1, 8, 11, 12, 13, 5, 8, 6]);             // crossroads

  // church north wall: three stained-glass windows over the sanctuary, sanctum panelling to the east
  const cn: number[] = [];
  for (let x = 47; x < 77; x++) cn.push([1, 2, 3, 4, 5, 6][(x - 47) % 6]);
  [59, 64, 69].forEach(x => { cn[x - 47] = 11; cn[x - 46] = 12; cn[x - 45] = 13; });
  [50, 54, 74].forEach(x => (cn[x - 47] = 8));
  wallStrip('mw/chapel', 47, 0, cn);
  wallStrip('mw/manor', 77, 0, [1, 2, 8, 9, 10, 3, 1, 2, 8, 9]);
  wallStrip('mw/manor', 77, 7, [1, 2, 3, 3, 1, 1, 2, 3, 3, 1]);         // sanctum south face (door at cols 81..82)

  // wall caps (the tops of walls seen from above)
  bar(0, 32, 6, botY - 32 + 6, 'casino');                               // west edge
  bar(WORLD_W - 6, 32, 6, botY - 32 + 6, 'church');                     // east edge
  bar(0, botY, CASINO_WALL_X + T, 6, 'casino'); bar(CASINO_WALL_X + T, botY, CHURCH_WALL_X - CASINO_WALL_X - T, 6, 'plaza'); bar(CHURCH_WALL_X, botY, WORLD_W - CHURCH_WALL_X, 6, 'church');
  [[CASINO_WALL_X + 8, 'casino'], [CHURCH_WALL_X + 8, 'church']].forEach(([cx, st]) => {
    bar((cx as number) - 5, 32, 10, DOOR_Y0 - 32, st as BarDef['style']);
    bar((cx as number) - 5, DOOR_Y1, 10, botY + 6 - DOOR_Y1, st as BarDef['style']);
  });
  bar(9 * T - 3, 32, 6, 5 * T + 6, 'casino');                           // office east side
  bar(77 * T - 3, 32, 6, 5 * T + 6, 'church');                          // sanctum west side

  block(0, 0, WORLD_W, 2 * T);                                          // north wall faces
  bars.forEach(b => block(b.x - 2, b.y, b.w + 4, b.h));
  [CW, HW].forEach(c => { block(c * T, 2 * T, T, DOOR_Y0 - 2 * T); block(c * T, DOOR_Y1, T, botY - DOOR_Y1); });
  block(0, 7 * T, 4 * T, 2 * T); block(6 * T, 7 * T, 3 * T, 2 * T);                           // office face
  doors.push({ key: 'c/doors/door_vip', x: 4 * T, y: 9 * T, trigger: area(2, 7, 6, 4) });
  // the House Monitor: Don's wall of screens, mounted OUTSIDE his office, left of the door, facing the boulevard
  P('c/security/cctv_wall', 0, 8, { solid: NS, scale: 0.6, dx: 13, dy: -5 });      // a compact bank of screens on the wall
  light(2, 8, 40, 0x7dffb0, 0.3, 0.08);
  interactables.push({ id: 'monitor', kind: 'monitor', label: 'House Monitor', rect: area(0, 9, 4, 1) });
  block(77 * T, 7 * T, 4 * T, 2 * T); block(83 * T, 7 * T, 4 * T, 2 * T);                     // sanctum face
  doors.push({ key: 'm/doors/door_manor', x: 81 * T, y: 9 * T, trigger: area(79, 7, 6, 4) });
  // the Ledger: an open book in a plaque on the sanctum's outer wall, left of the door, facing the transept
  P('x/ledger', 78, 8, { dx: 8, dy: -4, solid: NS });
  light(79.5, 7.8, 36, 0xffd27a, 0.34, 0.08);
  interactables.push({ id: 'ledger', kind: 'ledger', label: 'The Ledger', rect: area(78, 9, 3, 1) });

  // =====================================================================================
  //  CASINO
  // =====================================================================================
  // ---- Fortuna's office (NW): the boss watches the floor on his monitors
  P('c/security/cctv_wall', 2, 3, { solid: NS });
  P('c/lobby/host_desk', 3, 5);
  P('c/lounge/sofa_red', 6, 6, { solid: NS }); P('c/lounge/armchair_navy', 1, 6, { solid: NS });
  P('c/cage/floor_safe', 0, 4); P('c/cage/gold_bars', 7, 3, { solid: NS }); P('c/lobby/palm', 8, 4); P('c/security/key_cabinet', 6, 3);
  light(4.5, 4.5, 74, 0xffd27a, 0.22);
  npcs.push({ id: 'owner', char: 'c_pit_boss', name: 'Don Fortuna', x: 4.5 * T, y: 4 * T + 4, facing: 'down', role: 'owner' });
  interactables.push({ id: 'npc-owner', kind: 'npc', label: 'Talk', npc: 'owner', rect: area(2, 6, 6, 1) });

  // ---- slot banks along the north wall (Jephed animated machines), either side of the wheel
  const bank = (x0: number, id: string) => {
    [0, 2, 4].forEach((d, i) => { P(`j/slot${i % 2}`, x0 + d, 4); P(i % 2 ? 'c/tables/stool_red' : 'c/slots/stool_blue', x0 + d, 5, { solid: NS, still: true, dx: 8 }); });
    P('c/slots/end_lamp', x0 - 1, 4, { glow: { color: 0xffd27a, r: 26, a: 0.4, dy: -34, flicker: 0.08 } });
    P('c/slots/end_lamp', x0 + 6, 4, { glow: { color: 0xffd27a, r: 26, a: 0.4, dy: -34, flicker: 0.08 } });
    light(x0 + 3, 3.5, 70, 0xff4d8d, 0.22, 0.05);
    interactables.push({ id, kind: 'slots', label: 'Slots', rect: area(x0, 5, 6, 3) });
  };
  bank(10, 'slots-west'); bank(23, 'slots-east');
  patron('p-grandma', 'c_grandma', 'Regular', 12, 5.2, 'up');

  // ---- the Wheel of Fortune: the centrepiece of the floor, on a marble dais between two gold pillars
  P('x/fortune', 18, 7, { solid: { x: 6, y: 52, w: 36, h: 20 } });              // centred: pillars at cols 17 and 21
  P('c/lobby/gold_pillar', 17, 7); P('c/lobby/gold_pillar', 21, 7);
  light(19.5, 5, 90, 0xffc94a, 0.32, 0.06); light(19.5, 8.5, 50, 0xff3a8e, 0.22);
  interactables.push({ id: 'wheel', kind: 'wheel', label: 'Wheel of Fortune', rect: area(17, 8, 5, 1), around: area(15.6, 4.6, 7.8, 3.4) });

  // ---- the cashier, right by the entrance (NE)
  P('c/cage/deposit_boxes', 31, 3); P('c/cage/chip_cabinet', 33, 3); P('c/cage/vault_shelf', 35, 3); P('c/cage/money_counter', 37, 3, { solid: NS });
  P('c/cage/cage_window', 31, 6); P('c/cage/cage_bars', 34, 6); P('c/cage/atm', 37, 6);
  [31, 36].forEach(x => P('c/lounge/stanchion', x, 8, { solid: NS, still: true })); P('c/lounge/velvet_rope', 32, 8, { solid: NS, still: true }); P('c/lounge/velvet_rope', 34, 8, { solid: NS, still: true });
  bar(30 * T - 3, 32, 6, 3 * T, 'casino');
  light(34, 5, 84, 0x7dffd0, 0.3, 0.04);
  interactables.push({ id: 'cashier', kind: 'cashier', label: 'Cashier', rect: area(31, 7, 7, 2) });
  patron('p-cashier', 'c_cashier', 'Teller', 32, 4.3, 'down'); patron('p-cashier2', 'c_cashier', 'Teller', 35, 4.3, 'down');

  // ---- the entrance
  P('c/lobby/flower_vase', 38, 8); P('c/lobby/flower_vase', 38, 13);
  light(CW - 0.6, midY / T, 64, 0xb24dff, 0.26);

  // ---- THE BTC EXCHANGE (west pit, across the boulevard from Fortuna's office): a marble trading floor, a giant
  //      candlestick ticker wall (the live BTC price runs on its marquee), the bull and the bear, green/red/cyan neon.
  //      One-minute UP/DOWN rounds priced by an oracle on the rollup (onchain market.rs).
  fblock('cf', 21, 0, 12, 9, 7);
  P('x/tradewall', 0, 15, { dx: 6, solid: { x: 2, y: 44, w: 124, h: 20 } });
  P('x/bull', 1, 18, { dx: -4, solid: { x: 2, y: 12, w: 20, h: 12 } });
  P('x/bear', 6, 18, { dx: 4, solid: { x: 2, y: 12, w: 20, h: 12 } });
  light(4.4, 13.4, 96, 0x3dd6ff, 0.3, 0.05); light(1.2, 17.6, 34, 0x3dffa0, 0.36, 0.1); light(7.6, 17.6, 34, 0xff4d6d, 0.36, 0.1);
  interactables.push({ id: 'market', kind: 'market', label: 'BTC Exchange', rect: area(1.6, 16, 5.6, 1.9) });
  signs.push({ x: 70, y: 12.45 * T, text: 'BTC', kind: 'btc', anchor: '-50%, -50%' });                    // the wall's marquee
  // ---- blackjack (out of order) and roulette, south of the boulevard
  // one tile east of where it was: a gap between the table and the BTC Exchange's ticker wall
  P('j/blackjack', 10, 16);
  [11, 13, 15].forEach(x => P('c/tables/stool_red', x, 17, { solid: NS, still: true }));
  patron('p-dealer', 'c_dealer_f', 'Dealer', 13, 13.3, 'down');
  signs.push({ x: 9.6 * T, y: 16.4 * T, text: 'MAX', kind: 'limit', anchor: '-50%, -100%' });   // live table limit (the painted sign said $25)
  interactables.push({ id: 'blackjack', kind: 'blackjack', label: 'Blackjack', rect: area(10, 17, 6, 2), around: area(9, 12, 8, 5), op: 'p-dealer' });
  light(13, 14.5, 60, 0xffd27a, 0.24, 0.03);

  P('j/roulette_a', 18, 16);
  [19, 21, 23].forEach(x => P('c/tables/stool_green', x, 17, { solid: NS, still: true }));
  patron('p-croupier', 'c_croupier', 'Croupier', 23.5, 13.2, 'down');
  P('c/tables/chips', 25, 16, { solid: NS, still: true });
  interactables.push({ id: 'roulette', kind: 'roulette', label: 'Roulette', rect: area(18, 17, 7, 2), around: area(16.6, 12, 9.4, 5), op: 'p-croupier' });
  light(21.5, 14.5, 64, 0xffd27a, 0.24, 0.03);

  // ---- the coin-flip pit, right by the entrance (south)
  P('j/oval', 31, 17);
  [32, 34, 36].forEach((x, i) => P(i % 2 ? 'c/tables/stool_red' : 'c/tables/stool_green', x, 18, { solid: NS, still: true }));
  patron('p-hr', 'c_high_roller', 'High Roller', 37.6, 17.4, 'left');
  light(34.5, 15, 64, 0xffd24a, 0.26, 0.05);
  interactables.push({ id: 'coinflip', kind: 'coinflip', label: 'Coin Flip', rect: area(31, 18, 7, 1), around: area(30.3, 12, 8.6, 6) });

  // ---- the dice den (SE): a full-size craps table (same scale as the other tables), video poker against the south wall
  P('x/craps', 30, 25, { solid: { x: 4, y: 20, w: 120, h: 40 } });
  [31, 33, 35, 37].forEach((x, i) => P(i % 2 ? 'c/tables/stool_green' : 'c/tables/stool_red', x, 26, { solid: NS, still: true }));
  [31, 33, 35, 37].forEach(x => P('c/slots/video_poker', x, 28));
  signs.push({ x: 38.5 * T, y: 22.4 * T, text: 'MAX', kind: 'limit', anchor: '-50%, -100%' });
  light(34, 23.5, 70, 0xffd27a, 0.26, 0.03);
  patron('p-dice', 'c_croupier', 'Stickman', 34, 20.6, 'down');
  interactables.push({ id: 'dice', kind: 'dice', label: 'Dice Den', rect: area(30, 26, 8, 2), around: area(29, 21, 10, 5), op: 'p-dice' });

  // ---- founders' gallery: three plots players can own
  [13, 18, 23].forEach((px, i) => {
    signs.push({ x: (px + 2) * T, y: 22.6 * T, text: `FOR SALE #${i + 1}`, kind: 'sale', plot: i + 1 });
    plots.push({ id: i + 1, x: (px + 2) * T, y: 26 * T });
    P('c/lounge/stanchion', px, 22, { solid: NS, still: true }); P('c/lounge/stanchion', px + 3, 22, { solid: NS, still: true });
    light(px + 2, 25, 34, 0x7dffb0, 0.2);
    interactables.push({ id: `plot-${i + 1}`, kind: 'plot', label: `Founders' Plot ${i + 1}`, rect: area(px, 26, 4, 2) });
  });
  P('c/lobby/spade_statue', 12, 27); P('c/lobby/spade_statue', 27, 27);

  // ---- lounge & bar (SW)
  P('c/lounge/stage', 1, 23); P('c/lounge/spotlight', 0, 22, { solid: NS }); P('c/lounge/spotlight', 5, 22, { solid: NS }); P('c/lounge/mic_stand', 3, 22, { solid: NS });
  patron('p-singer', 'c_lounge_singer', 'Songbird', 2.5, 21.6, 'down');
  P('c/lounge/piano', 6, 23);
  for (let x = 0; x < 5; x++) P(`c/lounge/bar_counter_${x === 0 ? 'l' : x === 4 ? 'r' : 'm'}`, 1 + x, 26);
  P('c/lounge/back_bar', 1, 28); P('c/lounge/back_bar', 4, 28, { solid: { x: 0, y: 12, w: 32, h: 20 } });
  patron('p-bartender', 'c_bartender', 'Bartender', 3, 27, 'up');
  P('c/lounge/booth_navy', 7, 26); P('c/lounge/cocktail_table', 9, 24, { solid: NS }); P('c/lounge/armchair_red', 10, 24, { solid: NS });
  light(4, 24.5, 60, 0xc06bff, 0.26, 0.05);
  patron('p-waitress', 'c_cocktail_waitress', 'Server', 8, 22.4, 'down');

  // =====================================================================================
  //  CROSSROADS: the road between the realms, and the Harmony Wheel
  // =====================================================================================
  P('x/harmony', 41, 7, { dx: 8, solid: { x: 6, y: 52, w: 36, h: 20 } });
  P('c/outside/street_lamp', 40, 7, { glow: { color: 0xd58cff, r: 34, a: 0.34, dx: 8, dy: -42, flicker: 0.04 } });
  P('c/outside/street_lamp', 45, 7, { glow: { color: 0xffd27a, r: 34, a: 0.34, dx: 8, dy: -42, flicker: 0.04 } });
  light(43, 5, 80, 0xffe9a0, 0.3, 0.05);
  interactables.push({ id: 'harmony', kind: 'harmony', label: 'Harmony Wheel', rect: area(41, 8, 4, 1), around: area(40, 3, 6, 5) });
  // the barrier south of the road, and a quiet garden beyond it (a casino statue facing a church statue)
  P('x/board', 41, 16, { solid: { x: 0, y: 8, w: 64, h: 40 } });                 // THE WORD AT THE CROSSROADS: the two hosts' moves
  interactables.push({ id: 'board', kind: 'board', label: 'The Word at the Crossroads', rect: area(41, 13, 4, 1) });
  signs.push({ x: 43 * T, y: 14.15 * T, text: 'THE HOSTS ARE DECIDING...', kind: 'ticker', anchor: '-50%, -50%' });
  [40, 45].forEach(x => P('c/outside/bollard_lit', x, 14, { glow: { color: 0xffe0a0, r: 16, a: 0.3, dx: 8, dy: -8 } }));
  P('c/lobby/spade_statue', 41, 20); P('m/chapel/saint_statue', 44, 20);
  P('c/outside/street_lamp', 42, 22, { glow: { color: 0xffe0a0, r: 30, a: 0.25, dx: 8, dy: -42 } });
  P('c/strip/palm_tree', 40, 26); P('c/strip/palm_tree', 44, 26);

  // =====================================================================================
  //  CHURCH
  // =====================================================================================
  // ---- the sanctuary: the altar at the head of the nave, under the three windows
  P('m/chapel/chapel_altar', 64, 4, { glow: { color: 0xffb347, r: 58, a: 0.32, dx: 24, dy: -20, flicker: 0.1 } });
  [62, 68].forEach(x => P('m/chapel/candle_stand', x, 4, { glow: CANDLE }));
  [60, 70].forEach(x => P('m/chapel/chapel_banner', x, 4)); [58, 72].forEach(x => P('m/chapel/saint_statue', x, 4));
  P('m/chapel/lectern', 61, 6); P('m/chapel/censer', 69, 6);
  P('m/chapel/chapel_organ', 74, 4); P('m/chapel/wooden_cross', 56, 4);
    interactables.push({ id: 'altar', kind: 'altar', label: 'Altar of Fortune', rect: area(62, 5, 2, 2) }, { id: 'altar-r', kind: 'altar', label: 'Altar of Fortune', rect: area(67, 5, 2, 2) });

  // ---- the nave: pews either side of the aisle, north and south of the transept
  const pews = (rows: number[]) => rows.forEach(r => { [57, 60].forEach(x => P('m/chapel/pew', x, r)); [68, 71].forEach(x => P('m/chapel/pew', x, r)); });
  pews([7]); pews([13, 15, 17, 19]);
  [55, 75].forEach(x => { P('x/pillar', x, 8); P('x/pillar', x, 15); });
  P('m/tavern/wheel_chandelier', 64, 7, { high: true, solid: NS, glow: { color: 0xffc46a, r: 54, a: 0.22, dx: 16, dy: -8, flicker: 0.05 } });
  P('m/tavern/wheel_chandelier', 64, 16, { high: true, solid: NS, glow: { color: 0xffc46a, r: 54, a: 0.22, dx: 16, dy: -8, flicker: 0.05 } });
  patron('p-lady', 'm_lady', 'Parishioner', 58, 12.6, 'up'); patron('p-pilgrim', 'm_baker', 'Pilgrim', 72, 14.6, 'up'); patron('p-knight', 'm_knight', 'Knight', 69, 18.6, 'up');

  // ---- by the door: the quest board (north), the votive candles (north-east of it), the offering box (south)
  P('m/market/notice_board', 47, 7); P('m/chapel/hymn_board', 49, 7); P('m/chapel/chapel_banner', 50, 7);
  interactables.push({ id: 'missions', kind: 'missions', label: 'Quest Board', rect: area(47, 8, 4, 1) });
  P('m/chapel/votive_rack', 51, 4, { glow: { color: 0xff8a3a, r: 44, a: 0.42, dx: 16, dy: -12, flicker: 0.14 } });
  [50, 53].forEach(x => P('m/chapel/candle_stand', x, 4, { glow: CANDLE }));
  interactables.push({ id: 'candles', kind: 'candles', label: 'Votive Candles', rect: area(50, 5, 4, 2) });
  P('m/manor/clothes_chest', 49, 14); P('m/chapel/alms_box', 51, 14, { solid: { x: 0, y: 4, w: 16, h: 12 } }); P('m/chapel/stone_font', 52, 15);
  [48, 54].forEach(x => P('m/chapel/candle_stand', x, 14, { glow: CANDLE }));
  interactables.push({ id: 'offering', kind: 'offering', label: 'Offering Box', rect: area(48, 12, 6, 2) });
  patron('p-wash', 'm_washerwoman', 'Sacristan', 53, 13, 'down');
  // ---- the confessional, on the west aisle south of the offering box
  P('x/confess', 49, 20, { solid: { x: 2, y: 20, w: 44, h: 26 } });
  P('m/chapel/candle_stand', 48, 20, { solid: NS, glow: CANDLE });
  interactables.push({ id: 'confessional', kind: 'confessional', label: 'Confessional', rect: area(49, 21, 3, 1) });

  // ---- the sanctum (NE): Father Nakamoto's study
  P('m/manor/manor_fireplace', 80, 4, { glow: { color: 0xff7a2a, r: 56, a: 0.4, dx: 24, dy: -18, flicker: 0.16 } });
  P('m/manor/manor_bookcase', 78, 3); P('m/manor/manor_bookcase', 84, 3);
  P('m/manor/lord_chair', 84, 6, { solid: { x: 2, y: 28, w: 28, h: 18 } }); P('m/manor/writing_desk', 77, 6);
  P('m/manor/candelabra', 83, 6, { glow: { color: 0xffb347, r: 18, a: 0.35, dx: 8, dy: -24, flicker: 0.12 } });
  P('m/manor/suit_of_armour', 86, 6);
  npcs.push({ id: 'priest', char: 'm_monk', name: 'Father Nakamoto', x: 80 * T, y: 6 * T + 8, facing: 'down', role: 'priest' });   // by his hearth
  interactables.push({ id: 'npc-priest', kind: 'npc', label: 'Talk', npc: 'priest', rect: area(78.5, 5.8, 3.5, 1.2) }); P('m/manor/wall_torch', 79, 1, { solid: NS }); P('m/manor/wall_torch', 85, 1, { solid: NS });

  // ---- the scriptorium (SE)
  [77, 80, 83].forEach(x => P('m/manor/manor_bookcase', x, 13));
  [78, 82].forEach(x => P('m/manor/writing_desk', x, 17)); P('m/manor/chess_table', 85, 17);
  [77, 86].forEach(x => P('m/manor/candelabra', x, 17, { glow: CANDLE }));
  // ---- THE COMMISSION DESK: where projects (and players) commission missions for the Quest Board. The scribe keeps it.
  P('x/commission', 79, 20, { solid: { x: 2, y: 18, w: 44, h: 22 } });
  patron('p-scribe', 'm_bard', 'Scribe', 80.5, 18.1, 'down');                           // the clerk, behind the desk
  light(80.5, 19.2, 54, 0xffc46a, 0.42, 0.12);
  interactables.push({ id: 'commission', kind: 'commission', label: 'Commission Desk', rect: area(79, 21, 3, 1.3) });

  // ---- pilgrims' hall (south-east)
  P('m/tavern/tavern_hearth', 78, 28, { glow: { color: 0xff7a2a, r: 60, a: 0.42, dx: 24, dy: -18, flicker: 0.16 } });
  P('m/tavern/keg_rack', 72, 28); P('m/tavern/mug_shelf', 83, 28);
  [72, 81].forEach(x => P('m/tavern/long_table', x, 24)); [72, 81].forEach(x => P('m/tavern/long_bench', x, 22, { solid: NS }));
  P('m/tavern/wheel_chandelier', 77, 23, { high: true, solid: NS, glow: { color: 0xffc46a, r: 50, a: 0.2, dx: 16, dy: -8 } });
  patron('p-inn', 'm_innkeeper', 'Innkeeper', 77, 25.4, 'down'); patron('p-farmer', 'm_farmer', 'Pilgrim', 74, 21.4, 'down');

  // ---- the cloister garden (south-west)
  [48, 56].forEach(x => { P('m/cottage/herb_bed', x, 23, { solid: NS }); P('m/cottage/herb_bed', x, 27, { solid: NS }); });
  P('m/market/town_well', 52, 26, { solid: { x: 2, y: 14, w: 28, h: 18 } }); P('m/chapel/saint_statue', 59, 25); P('m/cottage/bench', 51, 22);
  patron('p-monk2', 'm_blacksmith', 'Gardener', 55, 24.4, 'down');

  // ---- the foot of the nave: the font
  P('m/chapel/stone_font', 64, 27); P('m/chapel/candle_stand', 63, 27, { glow: CANDLE }); P('m/chapel/candle_stand', 67, 27, { glow: CANDLE });

  // ---- stained-glass light falling across the sanctuary
  [59, 64, 69].forEach((x, i) => {
    const cols = [0x3a7bd5, 0xffd24a, 0xe8394a];
    shafts.push({ x: (x + 1.5) * T, y: 2 * T, w: 44, h: 120, color: cols[i], a: 0.24, skew: 26 });
    shafts.push({ x: (x + 1.5) * T + 14, y: 2 * T, w: 24, h: 90, color: 0xffe9a8, a: 0.14, skew: 24 });
    lights.push({ x: (x + 1.5) * T + 34, y: 8 * T, r: 30, color: cols[i], a: 0.18 });
  });

  // =====================================================================================
  //  HOSTS, TOUR ROUTES, SIGNAGE
  // =====================================================================================
  const spawns = { casino: { x: 36 * T, y: midY }, church: { x: 50 * T, y: midY } };
  const hosts = { casino: { x: 35 * T, y: midY }, church: { x: 51 * T, y: midY } };
  const routes = {
    casino: [
      { x: 35 * T, y: midY },            // 0 just inside the entrance
      { x: 34.5 * T, y: 8.6 * T },       // 1 cashier
      { x: 26 * T, y: 7.6 * T },         // 2 east slot bank
      { x: 19.5 * T, y: 8.7 * T },       // 3 the Wheel of Fortune
      { x: 34.5 * T, y: 19.4 * T },      // 4 coin flip (from the promenade)
      { x: 21.5 * T, y: 19.4 * T },      // 5 roulette
      { x: 34.5 * T, y: 27.6 * T },      // 6 dice den
      { x: 20 * T, y: 27.8 * T },        // 7 founders' plots
      { x: 5 * T, y: 9.7 * T },          // 8 office door
      { x: 4.5 * T, y: 6.6 * T },        // 9 inside the office
      { x: 2 * T, y: 9.8 * T },          // 10 in front of the House Monitor
      { x: 4.4 * T, y: 17.1 * T },       // 11 the BTC Exchange, before the ticker wall
    ],
    church: [
      { x: 51 * T, y: midY },            // 0 just inside the door
      { x: 51 * T, y: 12.8 * T },        // 1 offering box
      { x: 51.5 * T, y: 6.6 * T },       // 2 votive candles
      { x: 48.5 * T, y: 8.7 * T },       // 3 quest board
      { x: 65.5 * T, y: 7.4 * T },       // 4 the altar (up the aisle)
      { x: 81 * T, y: 15.8 * T },        // 5 scriptorium
      { x: 77 * T, y: 21.6 * T },        // 6 pilgrims' hall
      { x: 81.5 * T, y: 9.8 * T },       // 7 sanctum door
      { x: 81.5 * T, y: 6.4 * T },       // 8 inside the sanctum
    ],
  };
  const plazaCenter = { x: 43 * T, y: midY };

  // realm titles at the top of each hall
  signs.push({ x: 19.5 * T, y: 3, text: 'THE CASINO', kind: 'casino', anchor: '-50%, 0' });
  signs.push({ x: 65.5 * T, y: 3, text: 'THE CHURCH', kind: 'church', anchor: '-50%, 0' });
  // toll gates across each doorway
  signs.push({ x: CASINO_WALL_X + 8, y: midY, text: 'CASINO', kind: 'gateC', anchor: '-50%, -50%' });
  signs.push({ x: CHURCH_WALL_X + 8, y: midY, text: 'CHURCH', kind: 'gateH', anchor: '-50%, -50%' });
  lights.push({ x: CASINO_WALL_X + 8, y: DOOR_Y0 + 2, r: 46, color: 0xb24dff, a: 0.28 }, { x: CHURCH_WALL_X + 8, y: DOOR_Y0 + 2, r: 46, color: 0xffc860, a: 0.28 });
  // direction signs under the spawn point
  // direction signs: at the top of the road, each one next to its own gate (clear of the board below)
  signs.push({ x: CASINO_WALL_X + T + 2, y: DOOR_Y0 + 2, text: 'CASINO', kind: 'dirL', anchor: '0%, 0' });
  signs.push({ x: CHURCH_WALL_X - 2, y: DOOR_Y0 + 2, text: 'CHURCH', kind: 'dirR', anchor: '-100%, 0' });
  // one label per place (they brighten when you walk near)
  tag(5, 6.9, "FORTUNA'S OFFICE"); tag(2, 9.35, 'HOUSE MONITOR'); tag(13, 2.4, 'SLOTS'); tag(4.4, 18.95, 'BTC EXCHANGE'); tag(26, 2.4, 'SLOTS'); tag(19.5, 9.0, 'WHEEL OF FORTUNE'); tag(34.5, 2.4, 'CASHIER');
  tag(13, 12.5, 'BLACKJACK'); tag(21.5, 12.5, 'ROULETTE'); tag(34.5, 12.5, 'COIN FLIP');
  tag(5.5, 21.5, 'LOUNGE & BAR'); tag(20, 21.5, "FOUNDERS' PLOTS"); tag(36.6, 21.5, 'DICE DEN');
  tag(43, 2.5, 'HARMONY WHEEL'); tag(43, 15.4, 'THE WORD AT THE CROSSROADS');  tag(48.5, 5.4, 'QUEST BOARD'); tag(50.5, 22.4, 'CONFESSIONAL'); tag(52, 2.4, 'VOTIVE CANDLES'); tag(51, 16.6, 'OFFERING BOX');
  tag(81.8, 6.9, 'SANCTUM'); tag(79.5, 9.35, 'THE LEDGER'); tag(82, 11.0, 'SCRIPTORIUM'); tag(80.5, 22.75, 'COMMISSION DESK'); tag(74.5, 21.4, "PILGRIMS' HALL"); tag(53.5, 21.4, 'CLOISTER');

  return { plots, ops, bars, props, colliders, lights, shafts, interactables, npcs, doors, signs, spawns, hosts, routes, plazaCenter };
}
