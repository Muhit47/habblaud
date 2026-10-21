// GitHub in the office, rendering side: celebrations (confetti falling in room) and alarms (red siren
// in room corners, rotating floor light, pulsating red floor tint, and "!" bubble over observer of
// CI failure), plus short banner ("PR #12 merged!") rendered by overlay in screen space.
// Under prefers-reduced-motion: no flashing or rotation (static light, fixed tint, no confetti shower).
// Performance: only traverses rooms with active effects (typically none); cached sprites; confetti
// utilizes fixed particle pool, rate-limited per room.
import { TILE } from '../../art/api';
import type { HeadInfo } from './renderer';
import type { Particles } from './particles';
import type { RoomFx } from '../sim/github';
import type { Sim } from '../sim/sim';

const UI_FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';
const BANNER_FONT = `800 11.5px ${UI_FONT}`;
const BANNER_H = 22;

/** Voltas do giroflex (ms por volta). */
const SPIN_MS = 900;
/** Confetti per second in each celebrating room (~160 airborne per room; pool holds 600). */
const CONFETTI_RATE = 42;

let reducedMq: MediaQueryList | null | undefined;

/** prefers-reduced-motion (MediaQueryList tracks system preference autonomously). */
export function reducedMotion(): boolean {
  if (reducedMq === undefined) reducedMq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  return !!reducedMq?.matches;
}

/** Fade-in (300 ms) and fade-out (600 ms) of an effect: 0..1. */
export function fxFade(fx: Pick<RoomFx, 'start' | 'end'>, now: number): number {
  return Math.max(0, Math.min(1, (now - fx.start) / 300, (fx.end - now) / 600));
}

// ------------------------------------------------------------------ sprites (generated once)

type Rows = readonly string[];

function sprite(rows: Rows, pal: Readonly<Record<string, string>>): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = rows[0].length;
  c.height = rows.length;
  const ctx = c.getContext('2d')!;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const col = pal[row[x]];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(x, y, 1, 1);
    }
  });
  return c;
}

// Siren beacon: red dome over metal base. Full revolution frames: front-facing bulb (center glow),
// moving right, back-facing (dark dome), and returning from left.
const BEACON_ROWS: Rows[] = [
  ['..kkkkk..', '.kRbwbrk.', 'kRRbwbRrk', 'kRRbwbRrk', 'kRRRRRRrk', 'kmmmmmmmk', 'kMMMMMMMk', '.kkkkkkk.'],
  ['..kkkkk..', '.kRRRwbk.', 'kRRRRRwbk', 'kRRRRRwbk', 'kRRRRRRrk', 'kmmmmmmmk', 'kMMMMMMMk', '.kkkkkkk.'],
  ['..kkkkk..', '.kddddek.', 'kdddddddk', 'kdddddddk', 'kdddddeek', 'kmmmmmmmk', 'kMMMMMMMk', '.kkkkkkk.'],
  ['..kkkkk..', '.kbwRRrk.', 'kbwRRRRrk', 'kbwRRRRrk', 'kRRRRRRrk', 'kmmmmmmmk', 'kMMMMMMMk', '.kkkkkkk.'],
];
const BEACON_PAL = { k: '#3a1012', R: '#ff3b3b', r: '#c4161f', b: '#ff9a9a', w: '#fff4f4', d: '#9b161d', e: '#6d0d12', m: '#8d96a6', M: '#5c6372' };

// "!" speech bubble (red with tail) over agent observing CI failure.
const BANG_ROWS: Rows = ['.kkkkkkk.', 'krrrrrrrk', 'krrrwrrrk', 'krrrwrrrk', 'krrrwrrrk', 'krrrrrrrk', 'krrrwrrrk', 'krrrrrrrk', '.kkkkkkk.', '...krk...', '....k....'];
const BANG_PAL = { k: '#4a0d10', r: '#e5383b', w: '#ffffff' };

let beacons: HTMLCanvasElement[] | null = null;
let bang: HTMLCanvasElement | null = null;

function beaconFrames(): HTMLCanvasElement[] {
  return (beacons ??= BEACON_ROWS.map((rows) => sprite(rows, BEACON_PAL)));
}

function bangSprite(): HTMLCanvasElement {
  return (bang ??= sprite(BANG_ROWS, BANG_PAL));
}

/** Siren beacon frame at revolution phase `ph` (0 = facing forward): forward, right, backward, left. */
export function beaconFrame(ph: number): number {
  return Math.min(3, Math.floor(((((ph + 0.125) % 1) + 1) % 1) * 4));
}

/** Bulb orientation towards camera at phase `ph` (1 = facing viewer, 0 = side or backward). */
export function beaconFacing(ph: number): number {
  return Math.max(0, Math.cos(ph * Math.PI * 2));
}

const glows = new Map<number, HTMLCanvasElement>();

/**
 * Red halo (radial gradient, rendered on top with opacity): tints both bright
 * and dark wall surfaces — with 'lighter', red fades over white.
 */
function redGlow(size: number): HTMLCanvasElement {
  let c = glows.get(size);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,36,48,0.75)');
  g.addColorStop(0.45, 'rgba(255,36,48,0.3)');
  g.addColorStop(1, 'rgba(255,36,48,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  glows.set(size, c);
  return c;
}

// ------------------------------------------------------------------ world

interface View {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Room rectangles (world px): complete room and floor area (excluding walls). */
function roomRects(r: { x: number; y: number; w: number; h: number }) {
  return {
    room: { x: r.x * TILE, y: r.y * TILE, w: r.w * TILE, h: r.h * TILE },
    floor: { x: (r.x + 0.5) * TILE, y: (r.y + 2) * TILE, w: (r.w - 1) * TILE, h: (r.h - 3) * TILE },
  };
}

export class RoomFxRenderer {
  /** Acumulador da taxa de confete por sala. */
  private acc = new Map<string, number>();

  private visibleRoom(sim: Sim, fx: RoomFx, v: View) {
    const room = sim.rooms.get(fx.roomId);
    if (!room || !room.present || room.phase === 'dismantling') return null;
    const rects = roomRects(room.layout.rect);
    const p = rects.room;
    if (p.x > v.x1 || p.x + p.w < v.x0 || p.y - 8 > v.y1 || p.y + p.h < v.y0) return null;
    return rects;
  }

  /** Pulsating red floor tint in alarmed rooms (rendered before furniture and characters). */
  drawFloor(ctx: CanvasRenderingContext2D, sim: Sim, now: number, v: View): void {
    if (!sim.roomFx.active.size) return;
    const still = reducedMotion();
    for (const fx of sim.roomFx.active.values()) {
      if (fx.kind !== 'alarm' || now >= fx.end) continue;
      const rects = this.visibleRoom(sim, fx, v);
      if (!rects) continue;
      const pulse = still ? 0.5 : 0.5 + 0.5 * Math.sin(((now - fx.start) / 1100) * Math.PI * 2);
      const f = rects.floor;
      ctx.globalAlpha = fxFade(fx, now) * (0.08 + 0.09 * pulse);
      ctx.fillStyle = '#ff2a36';
      ctx.fillRect(f.x, f.y, f.w, f.h);
    }
    ctx.globalAlpha = 1;
  }

  /** Confetti falling in celebrating rooms (rendered before particle physics step). */
  emit(particles: Particles, sim: Sim, now: number, dt: number, v: View): void {
    if (!sim.roomFx.active.size) {
      if (this.acc.size) this.acc.clear();
      return;
    }
    const still = reducedMotion();
    for (const [id, fx] of sim.roomFx.active) {
      if (fx.kind !== 'party' || now >= fx.end || still) {
        this.acc.delete(id);
        continue;
      }
      const rects = this.visibleRoom(sim, fx, v);
      if (!rects) continue;
      // starts intense and tapers off over final 2 s
      const k = Math.min(1, (fx.end - now) / 2000) * (now - fx.start < 1500 ? 1.6 : 1);
      let a = (this.acc.get(id) ?? 0) + Math.min(0.1, dt) * CONFETTI_RATE * k;
      const f = rects.floor;
      const top = rects.room.y + 4;
      while (a >= 1) {
        a -= 1;
        const y = top + Math.random() * 6;
        particles.confettiFall(f.x + 2 + Math.random() * (f.w - 4), y, f.y + f.h - 4 - y);
      }
      this.acc.set(id, a);
    }
    for (const id of this.acc.keys()) if (!sim.roomFx.active.has(id)) this.acc.delete(id);
  }

  /**
   * Siren beacon in two upper room corners in alarmed rooms, rotating floor light, and "!" bubble on
   * responsible agent. Rendered above lighting layer (shines at night and in darkened rooms).
   */
  drawLights(ctx: CanvasRenderingContext2D, sim: Sim, heads: ReadonlyMap<string, HeadInfo>, now: number, v: View): void {
    if (!sim.roomFx.active.size) return;
    const still = reducedMotion();
    for (const fx of sim.roomFx.active.values()) {
      if (fx.kind !== 'alarm' || now >= fx.end) continue;
      const fade = fxFade(fx, now);
      const rects = this.visibleRoom(sim, fx, v);
      if (rects) this.drawBeacons(ctx, rects, now - fx.start, fade, still);
      // "!" bubble on responsible agent (wherever they stand), right of head icon; overlay
      // shifts activity bubble upward to avoid collision
      const head = fx.agentId ? heads.get(fx.agentId) : undefined;
      if (head?.visible) {
        const s = bangSprite();
        const bob = still ? 0 : Math.round(Math.abs(Math.sin((now - fx.start) / 260)) * 2);
        ctx.globalAlpha = fade;
        ctx.drawImage(s, Math.round(head.x + 4), Math.round(head.y - s.height - 1 - bob));
        ctx.globalAlpha = 1;
      }
    }
  }

  private drawBeacons(ctx: CanvasRenderingContext2D, rects: ReturnType<typeof roomRects>, t: number, fade: number, still: boolean): void {
    const frames = beaconFrames();
    const r = rects.room;
    const f = rects.floor;
    const spots = [r.x + 4, r.x + r.w - 4];
    // static (prefers-reduced-motion): forward-facing bulbs, illuminated, non-rotating
    const ph = still ? 0 : t / SPIN_MS;
    /** Orientation of bulb `i` facing viewer (0..1); right bulb offset by half-turn. */
    const facing = (i: number) => (still ? 0.6 : beaconFacing(ph + i * 0.5));
    // rotating light: sweep beam from each bulb traversing room floor (opposite phases)
    if (!still) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      const sweep = redGlow(128);
      const cx = f.x + f.w / 2;
      const cy = f.y + f.h / 2;
      for (let i = 0; i < 2; i++) {
        const a = ph * Math.PI * 2 + i * Math.PI;
        ctx.globalAlpha = 0.3 * fade;
        ctx.drawImage(sweep, Math.round(cx + Math.cos(a) * f.w * 0.3 - 64), Math.round(cy + Math.sin(a) * f.h * 0.3 - 64));
      }
      ctx.restore();
    }
    // bulb halo (bleeds subtly outside room boundaries, realistic lighting behavior)
    const glow = redGlow(48);
    for (const [i, x] of spots.entries()) {
      ctx.globalAlpha = (0.25 + 0.75 * facing(i)) * fade;
      ctx.drawImage(glow, Math.round(x - 24), Math.round(r.y + 3 - 24));
    }
    ctx.globalAlpha = fade;
    for (const [i, x] of spots.entries()) {
      const s = frames[still ? 0 : beaconFrame(ph + i * 0.5)];
      const sx = Math.round(x - s.width / 2);
      const sy = Math.round(r.y + 7 - s.height);
      ctx.drawImage(s, sx, sy);
      // facing viewer directly: short ray flares emanating from dome
      if (!still && facing(i) > 0.75) {
        ctx.fillStyle = '#ff6b6b';
        const cy = sy + 2;
        ctx.fillRect(sx - 4, cy, 3, 1);
        ctx.fillRect(sx + s.width + 1, cy, 3, 1);
        ctx.fillRect(sx - 2, cy - 3, 1, 1);
        ctx.fillRect(sx - 3, cy - 4, 1, 1);
        ctx.fillRect(sx + s.width + 1, cy - 3, 1, 1);
        ctx.fillRect(sx + s.width + 2, cy - 4, 1, 1);
        ctx.fillRect(sx + Math.floor(s.width / 2), sy - 3, 1, 2);
      }
    }
    ctx.globalAlpha = 1;
  }
}

// ------------------------------------------------------------------ banner (screen space)

/** Occupied screen bounds (CSS px). */
export interface BannerRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Short banner for celebration ("🎉 PR #12 merged!", gold with notched ends) or alarm
 * ("🚨 CI failed (main)", red) centered at `cx`, with top at `top` (CSS px). Enters descending,
 * fades out; celebration sways gently and alarm pulses — static under prefers-reduced-motion. Without
 * room for text, falls back to emoji badge. Returns occupied bounds (so speech bubbles deviate).
 */
export function drawFxBanner(
  ctx: CanvasRenderingContext2D,
  fx: RoomFx,
  cx: number,
  top: number,
  maxW: number,
  now: number,
  fit: (font: string, text: string, maxW: number) => string,
  measure: (font: string, text: string) => number,
): BannerRect | null {
  const fade = fxFade(fx, now);
  if (fade <= 0) return null;
  const still = reducedMotion();
  const party = fx.kind === 'party';
  const emoji = party ? '🎉' : '🚨';
  const enter = still ? 0 : Math.max(0, 1 - (now - fx.start) / 260);
  const wave = !still && party ? Math.sin((now - fx.start) / 320) * 1.5 : 0;
  const y = Math.round(top - enter * 10 + wave);
  const notch = 6;
  const text = maxW >= 70 ? fit(BANNER_FONT, `${emoji} ${fx.text}`, maxW - 24 - 2 * notch) : '';
  ctx.save();
  ctx.globalAlpha = fade;
  ctx.font = BANNER_FONT;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const pulse = still ? 0 : 0.5 + 0.5 * Math.sin(((now - fx.start) / 700) * Math.PI * 2);
  const body = party ? '#ffcf3a' : pulse > 0.5 ? '#ef3340' : '#c8202e';
  const edge = party ? '#c98a12' : '#7a0d16';
  const ink = party ? '#3a2606' : '#ffffff';
  if (!text || text === '…') {
    // emoji only, in circular badge
    const r = 11;
    ctx.fillStyle = 'rgba(16,20,32,0.25)';
    ctx.beginPath();
    ctx.arc(cx, y + r + 1.5, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(cx, y + r, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `13px ${UI_FONT}`;
    ctx.fillText(emoji, cx, y + r + 1);
    ctx.restore();
    return { x: cx - r, y, w: 2 * r, h: 2 * r };
  }
  const tw = measure(BANNER_FONT, text);
  const w = Math.round(tw + 24 + 2 * notch);
  const x = Math.round(cx - w / 2);
  const h = BANNER_H;
  const ribbon = (dy: number) => {
    ctx.beginPath();
    ctx.moveTo(x, y + dy);
    ctx.lineTo(x + w, y + dy);
    ctx.lineTo(x + w - notch, y + dy + h / 2);
    ctx.lineTo(x + w, y + dy + h);
    ctx.lineTo(x, y + dy + h);
    ctx.lineTo(x + notch, y + dy + h / 2);
    ctx.closePath();
  };
  ctx.fillStyle = 'rgba(16,20,32,0.28)';
  ribbon(2);
  ctx.fill();
  ctx.fillStyle = edge;
  ribbon(1);
  ctx.fill();
  ctx.fillStyle = body;
  ribbon(0);
  ctx.fill();
  if (party) {
    // colorful pennants along top border
    const colors = ['#ff4d6d', '#3fa7ff', '#3ddc84', '#b06bff'];
    for (let i = 0, px = x + notch + 6; px < x + w - notch - 6; i++, px += 9) {
      ctx.fillStyle = colors[i % colors.length];
      ctx.beginPath();
      ctx.moveTo(px - 3, y);
      ctx.lineTo(px + 3, y);
      ctx.lineTo(px, y + 4);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.fillStyle = ink;
  ctx.fillText(text, Math.round(cx), y + h / 2 + 1);
  ctx.restore();
  return { x, y, w, h };
}
