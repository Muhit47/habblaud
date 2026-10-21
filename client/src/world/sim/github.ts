// GitHub in the office, simulation side: room celebrations and alarms arriving in snapshot
// (RoomInfo.effect), with server timestamps mapped to browser clock, and
// character celebrations at start of party. Rendering (confetti, siren beacon, red floor
// tint, banner, and "!" bubble) is handled in render/github-fx.ts.
import type { RoomInfo } from '../../../../shared/types';
import { hash32 } from '../../../../shared/hash';
import { inRect } from '../layout/geometry';
import type { Character } from './character';
import type { Sim } from './sim';

/** Active effect in a room, on browser clock. */
export interface RoomFx {
  roomId: string;
  kind: 'party' | 'alarm';
  text: string;
  /** Responsible agent (author/merger; or who observed CI failure). */
  agentId?: string;
  /** Server `at`: effect identifier (different value = new effect, animation restarts). */
  key: number;
  /** Start and finish on browser clock. */
  start: number;
  end: number;
  /** Agents who already celebrated this party. */
  cheered: Set<string>;
  /** Forced via debugging (debug.roomEffect): snapshot does not clear it. */
  sticky?: boolean;
}

/** Duration of celebratory jumping with raised arms ('cheer': 2 frames of 260 ms). */
export const PARTY_CHEER_MS = 2_600;
/** Seat enter/exit transition (matches simulation). */
const SEAT_MS = 180;
/** Maximum staggered delay before celebration (room does not jump in unison). */
const CHEER_STAGGER_MS = 700;
/** Party with less remaining time than this does not trigger new celebrations. */
const CHEER_MIN_LEFT_MS = 3_000;

/** Reconciles room effects with snapshot. Pure (DOM-free), testable. */
export class RoomFxState {
  readonly active = new Map<string, RoomFx>();

  /**
   * Applies snapshot effects. Server and browser clocks may drift: calculation is based on
   * elapsed and remaining time relative to server clock (`serverTime`).
   */
  sync(rooms: readonly RoomInfo[], serverTime: number, now: number): void {
    const seen = new Set<string>();
    for (const r of rooms) {
      const e = r.effect;
      if (!e || e.until <= serverTime) continue;
      seen.add(r.id);
      const end = now + (e.until - serverTime);
      const cur = this.active.get(r.id);
      if (cur && cur.key === e.at && cur.kind === e.kind) {
        cur.end = end;
        cur.text = e.text;
        cur.agentId = e.agentId;
        continue;
      }
      const elapsed = Math.max(0, Math.min(serverTime - e.at, e.until - e.at));
      this.active.set(r.id, { roomId: r.id, kind: e.kind, text: e.text, agentId: e.agentId, key: e.at, start: now - elapsed, end, cheered: new Set() });
    }
    for (const [id, fx] of [...this.active]) if (!seen.has(id) && !fx.sticky) this.active.delete(id);
  }

  /** Currently visible room effect, if active. */
  get(roomId: string, now: number): RoomFx | undefined {
    const fx = this.active.get(roomId);
    return fx && now < fx.end ? fx : undefined;
  }

  /** Agents with active alarm in own room ("!" speech bubble): agent ID -> effect. */
  alarmOwner(agentId: string, now: number): RoomFx | undefined {
    for (const fx of this.active.values()) if (fx.kind === 'alarm' && fx.agentId === agentId && now < fx.end) return fx;
    return undefined;
  }

  /** Esquece os vencidos e faz a sala comemorar as festas em andamento. */
  update(sim: Sim, now: number): void {
    for (const [id, fx] of this.active) {
      if (now >= fx.end) {
        this.active.delete(id);
        continue;
      }
      if (fx.kind === 'party' && fx.end - now >= CHEER_MIN_LEFT_MS) celebrate(sim, fx, now);
    }
  }
}

/** Deterministic per-character celebration onset delay. */
export function cheerDelay(charId: string): number {
  return hash32(charId) % CHEER_STAGGER_MS;
}

/**
 * Party celebration: agents seated at own desk/spot stand and jump with raised
 * arms; walking, gathered, or busy agents display a 🎉 bubble. Responsible agent
 * receives a star and confetti. Agents needing attention (raised hand) or departing are
 * excluded.
 */
export function celebrate(sim: Sim, fx: RoomFx, now: number): void {
  const room = sim.rooms.get(fx.roomId);
  if (!room || !room.present) return;
  for (const ch of sim.chars.values()) {
    if (fx.cheered.has(ch.id) || !inParty(ch, fx.roomId, room.layout.rect, now)) continue;
    if (now - fx.start < cheerDelay(ch.id)) continue;
    fx.cheered.add(ch.id);
    const mine = ch.id === fx.agentId;
    if (mine) {
      ch.setIcon('star', PARTY_CHEER_MS, now);
      sim.pushEffect({ kind: 'confetti', charId: ch.id, at: now });
    }
    const home = sim.spots.get(ch.homeSpot);
    if (home && ch.atSpot === home.id && !ch.step && !ch.queue.length && !ch.gathering) {
      ch.reactUntil = now + PARTY_CHEER_MS + 2 * SEAT_MS + 200;
      if (home.seated) ch.queue.push({ t: 'exit' });
      ch.queue.push({ t: 'act', pose: 'cheer', ms: PARTY_CHEER_MS });
      if (home.seated) ch.queue.push({ t: 'enter', spot: home.id });
    } else if (!mine) {
      ch.chatEmoji = '🎉';
      ch.chatUntil = now + 2_400;
    }
  }
}

/** Eligible to celebrate room party: assigned to (or inside) room, visible, and available. */
function inParty(ch: Character, roomId: string, rect: { x: number; y: number; w: number; h: number }, now: number): boolean {
  if (ch.gone || ch.leaving || ch.inside || ch.arriving || ch.alpha < 0.5 || now < ch.hiddenUntil) return false;
  if (ch.mode === 'wait' || ch.mode === 'leave' || ch.mode === 'deliver') return false;
  return ch.roomId === roomId || inRect(rect, ch.tx, ch.ty);
}
