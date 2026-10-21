// Like, stamp and "knock on door" in city (Phase 5): closest reachable door (like within 4 tiles of
// door; knock and stamp within 2; never on own building), client rate limits (like 10/min; knock 1/min
// per building) and heart flying to nameplate. Pure (tested); rendering is in social.ts.
import { lotDoor, type CityPoint } from '../../../../shared/world/city';
import type { WorldBuildingPublic } from '../../../../shared/world/protocol';
import { nearestDoor } from './layout';

/** Distances (tiles) to `lotDoor(lot).front`, matching world server logic. */
export const LIKE_DISTANCE = 4;
export const KNOCK_DISTANCE = 2;
export const STAMP_DISTANCE = 2;
/**
 * Knock on door: once per minute per building (server rejects earlier attempts). Client-side margin: commands
 * are batched every 200 ms and may arrive closer together than dispatched.
 */
export const KNOCK_EVERY_MS = 62_000;
/** Flying time of heart to nameplate. */
export const HEART_MS = 900;

export interface DoorTarget {
  building: WorldBuildingPublic;
  front: CityPoint;
  /** Distance (tiles) to door front. */
  dist: number;
}

/**
 * Nearest door (within `max` tiles) of a city building that is not mine. `buildingAt` returns building for
 * each lot (scene state).
 */
export function doorTarget(
  me: { x: number; y: number },
  buildingAt: (lot: CityPoint) => WorldBuildingPublic | undefined,
  myBuildingId: string | null,
  max: number,
): DoorTarget | null {
  const d = nearestDoor(me.x, me.y, (lot) => {
    const b = buildingAt(lot);
    return !!b && b.id !== myBuildingId;
  }, max);
  if (!d) return null;
  const building = buildingAt(d.lot);
  if (!building) return null;
  return { building, front: d.front, dist: Math.hypot(d.front.x - me.x, d.front.y - me.y) };
}

/** Distance (tiles) from me to building door. */
export function doorDistance(me: { x: number; y: number }, b: Pick<WorldBuildingPublic, 'lot'>): number {
  const f = lotDoor(b.lot).front;
  return Math.hypot(f.x - me.x, f.y - me.y);
}

/** What building buttons show now: like (nearby), knock (nearby and owner accepts) and rejection reason. */
export interface DoorActions {
  canLike: boolean;
  canKnock: boolean;
  liked: boolean;
  mine: boolean;
}

export function doorActions(b: WorldBuildingPublic, me: { x: number; y: number } | null, myBuildingId: string | null): DoorActions {
  const mine = !!myBuildingId && b.id === myBuildingId;
  const dist = me ? doorDistance(me, b) : Infinity;
  return {
    canLike: !mine && dist <= LIKE_DISTANCE + 1e-9,
    canKnock: !mine && b.knocks === true && dist <= KNOCK_DISTANCE + 1e-9,
    liked: b.likedByMe === true,
    mine,
  };
}

/** Knock on door: timestamp when each building was last knocked on (client side only). */
export class KnockBook {
  private readonly at = new Map<string, number>();

  /** Remaining wait time (ms) to knock again on this building. */
  wait(buildingId: string, now: number): number {
    const t = this.at.get(buildingId);
    return t === undefined ? 0 : Math.max(0, t + KNOCK_EVERY_MS - now);
  }

  take(buildingId: string, now: number): boolean {
    if (this.wait(buildingId, now) > 0) return false;
    this.at.set(buildingId, now);
    return true;
  }
}

/** Heart flying from `from` to `to` (world px), along an arc. */
export interface HeartFlight {
  from: { x: number; y: number };
  to: { x: number; y: number };
  start: number;
  /** Undo like: heart falls from nameplate, broken. */
  broken?: boolean;
}

/** Heart position (world px), scale and opacity; null once arrived. */
export function heartAt(f: HeartFlight, now: number): { x: number; y: number; scale: number; alpha: number } | null {
  const t = (now - f.start) / HEART_MS;
  if (t < 0 || t >= 1) return null;
  if (f.broken) {
    // falls from sign, wobbling
    return { x: f.to.x + Math.sin(t * 9) * 3, y: f.to.y + t * t * 26, scale: 1, alpha: 1 - t };
  }
  const e = 1 - (1 - t) * (1 - t);
  const lift = Math.sin(t * Math.PI) * 26;
  const x = f.from.x + (f.to.x - f.from.x) * e;
  const y = f.from.y + (f.to.y - f.from.y) * e - lift;
  const scale = t < 0.15 ? 0.6 + (t / 0.15) * 0.8 : t > 0.8 ? 1.4 - ((t - 0.8) / 0.2) * 0.6 : 1.4;
  return { x, y, scale, alpha: t > 0.9 ? (1 - t) * 10 : 1 };
}

/** Pixel art heart (7×6), 1 = color, 2 = highlight. */
export const HEART_PIXELS: readonly string[] = ['.11.11.', '1211111', '1111111', '.11111.', '..111..', '...1...'];
