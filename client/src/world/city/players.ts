// Street players (pure): local player (immediate local motion, collision via city.ts `isWalkable`, A* pathing,
// `move` dispatch up to 10/s) and others (position samples at 5/s for 20 nearest and 2.5/s for
// others, rendered slightly delayed and interpolated; delay tracks inter-sample interval of
// each player). Positions in TILES (feet anchor; matching protocol).
import type { Dir } from '../../art/api';
import type { Direction } from '../../../../shared/world/protocol';
import { walkable as cityWalkable } from './layout';

/** Speeds (tiles/s): matching office. Server permits up to 6 × 1.2. */
export const WALK_TPS = 3.2;
export const RUN_TPS = 6;
/**
 * Delay for rendering others (ms): largest recent sample interval per player plus network margin,
 * ensuring a future sample is always available (5/s: ~260 ms; 2.5/s: ~460 ms), bounded by min and max.
 */
export const INTERP_MIN_MS = 150;
export const INTERP_MAX_MS = 700;
const INTERP_MARGIN_MS = 60;
/** Intervals larger than this do not reflect cadence (player stopped, server sent nothing): ignored. */
const CADENCE_MAX_GAP_MS = 1_000;
/** Count of recent intervals tracked. */
const CADENCE_GAPS = 4;
/** Delay adjustment per clock ms (increasing, rendering progresses at 0.5×; decreasing, at 1.25×): never regresses. */
const DELAY_UP_RATE = 0.5;
const DELAY_DOWN_RATE = 0.25;
/** Minimum interval between `move` dispatches (10/s). */
export const MOVE_INTERVAL_MS = 100;
/** Buffered samples per player. */
const MAX_SAMPLES = 10;

export const DIR_TO_PROTO: Readonly<Record<Dir, Direction>> = { up: 'n', down: 's', left: 'w', right: 'e' };
export const PROTO_TO_DIR: Readonly<Record<Direction, Dir>> = { n: 'up', s: 'down', w: 'left', e: 'right' };

/** Dominant displacement direction (preserves previous direction when stopped). */
export function dirOf(dx: number, dy: number, fallback: Dir): Dir {
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return fallback;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

// ------------------------------------------------------------------ other players

export interface Sample {
  t: number;
  x: number;
  y: number;
  dir: Direction;
  moving: boolean;
}

/** Buffers sample in chronological order, capped at limit. */
export function pushSample(samples: Sample[], s: Sample): void {
  const last = samples[samples.length - 1];
  if (last && s.t < last.t) s = { ...s, t: last.t };
  samples.push(s);
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

export interface Interpolated {
  x: number;
  y: number;
  dir: Direction;
  moving: boolean;
  /** Estimated velocity (tiles/s) between two samples. */
  speed: number;
}

/** Target delay (ms) for player samples: largest of recent inter-sample intervals plus margin. */
export function interpDelay(samples: readonly Sample[]): number {
  let worst = 0;
  let n = 0;
  for (let i = samples.length - 1; i > 0 && n < CADENCE_GAPS; i--) {
    const gap = samples[i]!.t - samples[i - 1]!.t;
    if (gap <= 0 || gap > CADENCE_MAX_GAP_MS) continue;
    worst = Math.max(worst, gap);
    n++;
  }
  return Math.min(INTERP_MAX_MS, Math.max(INTERP_MIN_MS, worst + INTERP_MARGIN_MS));
}

/** Adjusts current delay toward target gradually (`dtMs` clock), preventing temporal regression. */
export function stepDelay(current: number, target: number, dtMs: number): number {
  if (target > current) return Math.min(target, current + dtMs * DELAY_UP_RATE);
  return Math.max(target, current - dtMs * DELAY_DOWN_RATE);
}

/**
 * Position at timestamp `t` ("now" minus delay): linear interpolation between enclosing samples; before first,
 * returns first; after last, returns last (stationary if sample has gone stale).
 */
export function sampleAt(samples: readonly Sample[], t: number): Interpolated | null {
  const n = samples.length;
  if (!n) return null;
  const first = samples[0]!;
  if (t <= first.t) return { x: first.x, y: first.y, dir: first.dir, moving: first.moving && n > 1, speed: 0 };
  for (let i = 1; i < n; i++) {
    const b = samples[i]!;
    if (t > b.t) continue;
    const a = samples[i - 1]!;
    const span = Math.max(1, b.t - a.t);
    const k = Math.min(1, Math.max(0, (t - a.t) / span));
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, dir: b.dir, moving: dist > 1e-3 || b.moving, speed: (dist * 1000) / span };
  }
  const last = samples[n - 1]!;
  // last sample indicated "moving", but elapsed time is long: stopped (next arrives on movement)
  const stale = t - last.t > 400;
  return { x: last.x, y: last.y, dir: last.dir, moving: last.moving && !stale, speed: 0 };
}

// ------------------------------------------------------------------ local player

export type Walkable = (x: number, y: number) => boolean;

/**
 * Moves (dx, dy) tiles from (x, y), one axis at a time (sliding along obstacles), avoiding unwalkable cells.
 * Large steps are subdivided into at most half-tile increments to prevent corner clipping.
 */
export function stepMove(x: number, y: number, dx: number, dy: number, can: Walkable = cityWalkable): { x: number; y: number; blocked: boolean } {
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 0.5));
  let blocked = false;
  for (let i = 0; i < n; i++) {
    const nx = x + dx / n;
    if (can(nx, y)) x = nx;
    else blocked = true;
    const ny = y + dy / n;
    if (can(x, ny)) y = ny;
    else blocked = true;
  }
  return { x, y, blocked };
}

export interface MoveIntent {
  /** Key movement direction (-1..1 along each axis; 0,0 = none). */
  dx: number;
  dy: number;
  run: boolean;
}

export class LocalPlayer {
  x: number;
  y: number;
  dir: Dir = 'down';
  moving = false;
  running = false;
  /** Click path points (tiles), formatted as [x0, y0, x1, y1...]. */
  private path: number[] = [];
  private pathI = 0;
  private pathRun = false;
  /** Duration (ms) in current pose, for animation frames. */
  animT = 0;

  constructor(
    x: number,
    y: number,
    private readonly can: Walkable = cityWalkable,
  ) {
    this.x = x;
    this.y = y;
  }

  get hasPath(): boolean {
    return this.pathI < this.path.length;
  }

  /** Path (tile points) to navigate. */
  follow(points: number[], run: boolean): void {
    this.path = points;
    this.pathI = 0;
    this.pathRun = run;
  }

  stopPath(): void {
    this.path = [];
    this.pathI = 0;
  }

  /** Server correction (`pos`): snaps there immediately and discards path. */
  correct(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.stopPath();
  }

  /** Advances `dt` seconds. Key inputs take precedence over click path. */
  update(dt: number, intent: MoveIntent): void {
    const prevMoving = this.moving;
    const prevRun = this.running;
    dt = Math.min(0.1, Math.max(0, dt));
    let dx = intent.dx;
    let dy = intent.dy;
    if (dx || dy) {
      this.stopPath();
      const len = Math.hypot(dx, dy);
      // normalized diagonal: never faster than sprint speed
      dx /= len;
      dy /= len;
      const v = (intent.run ? RUN_TPS : WALK_TPS) * dt;
      const r = stepMove(this.x, this.y, dx * v, dy * v, this.can);
      this.dir = dirOf(dx, dy, this.dir);
      this.moving = Math.hypot(r.x - this.x, r.y - this.y) > 1e-4;
      this.running = intent.run && this.moving;
      this.x = r.x;
      this.y = r.y;
    } else if (this.hasPath) {
      let budget = (this.pathRun ? RUN_TPS : WALK_TPS) * dt;
      this.moving = true;
      this.running = this.pathRun;
      while (budget > 0 && this.hasPath) {
        const tx = this.path[this.pathI]!;
        const ty = this.path[this.pathI + 1]!;
        const ddx = tx - this.x;
        const ddy = ty - this.y;
        const d = Math.hypot(ddx, ddy);
        if (d <= budget) {
          this.x = tx;
          this.y = ty;
          budget -= d;
          this.pathI += 2;
          if (d > 1e-6) this.dir = dirOf(ddx, ddy, this.dir);
        } else {
          this.x += (ddx / d) * budget;
          this.y += (ddy / d) * budget;
          this.dir = dirOf(ddx, ddy, this.dir);
          budget = 0;
        }
      }
      if (!this.hasPath) {
        this.moving = false;
        this.running = false;
      }
    } else {
      this.moving = false;
      this.running = false;
    }
    if (prevMoving !== this.moving || prevRun !== this.running) this.animT = 0;
    else this.animT += dt * 1000;
  }
}

/** Converts A* path (integer local grid tiles) into points (tile centers) to fine destination. */
export function pathPoints(cells: readonly number[], ox: number, oy: number, goal: { x: number; y: number } | null): number[] {
  const out: number[] = [];
  for (let i = 0; i < cells.length; i += 2) out.push(cells[i]! + ox + 0.5, cells[i + 1]! + oy + 0.5);
  if (goal && out.length >= 2) {
    // final point snaps to exact click coordinate (within same tile)
    out[out.length - 2] = goal.x;
    out[out.length - 1] = goal.y;
  } else if (goal && !out.length) out.push(goal.x, goal.y);
  return out;
}

/**
 * Wire position in hundredths of a tile, always truncated down: rounding could place a character flush with
 * north or west lot edge (y = 11.996) inside lot (12.00), triggering server `pos` correction. Truncating
 * never changes tile.
 */
export function wirePos(v: number): number {
  return Math.floor(v * 100) / 100;
}

/**
 * When to dispatch `move`: at most once per 100 ms, only when position or "moving" state changed since last. Stop
 * state always dispatches (in next available interval).
 */
export class MoveSender {
  private lastAt = -Infinity;
  private last: { x: number; y: number; dir: Direction; moving: boolean } | null = null;

  constructor(private readonly send: (m: { t: 'move'; x: number; y: number; dir: Direction; moving: boolean }) => void) {}

  tick(now: number, p: { x: number; y: number; dir: Dir; moving: boolean }): boolean {
    if (now - this.lastAt < MOVE_INTERVAL_MS) return false;
    const cur = { x: wirePos(p.x), y: wirePos(p.y), dir: DIR_TO_PROTO[p.dir], moving: p.moving };
    const l = this.last;
    if (l && l.x === cur.x && l.y === cur.y && l.dir === cur.dir && l.moving === cur.moving) return false;
    this.lastAt = now;
    this.last = cur;
    this.send({ t: 'move', ...cur });
    return true;
  }

  /**
   * Re-emits stopped position (background tab: server keeps player in street).
   * Timeless: caller uses different clock from `tick`; storing its timestamp previously silenced dispatches until `reset`.
   */
  keepAlive(p: { x: number; y: number; dir: Dir }): void {
    const cur = { x: wirePos(p.x), y: wirePos(p.y), dir: DIR_TO_PROTO[p.dir], moving: false };
    this.lastAt = -Infinity;
    this.last = cur;
    this.send({ t: 'move', ...cur });
  }

  /** Clears last dispatched state (following correction, next tick dispatches again). */
  reset(): void {
    this.last = null;
    this.lastAt = -Infinity;
  }
}
