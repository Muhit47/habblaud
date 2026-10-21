// Action queue steps for a character. Instantiated during planning (never per-frame).
import type { Dir, HeldItem, IconName, Pose } from '../../art/api';
import type { Gathering } from '../social/gathering';

export type Step =
  /** Walks (or runs) to tile (tx, ty); then optionally to precise position (fx, fy) and faces `dir`. */
  | { t: 'go'; tx: number; ty: number; run?: boolean; fx?: number; fy?: number; dir?: Dir; held?: HeldItem; path?: number[]; i?: number; fine?: boolean }
  /** Snaps into spot (seat or usage spot). Requires character at approach tile. */
  | { t: 'enter'; spot: string }
  /** Leaves current spot back to approach tile (standing up). */
  | { t: 'exit' }
  /** Holds a pose for a duration. */
  | { t: 'act'; pose: Pose; ms: number; held?: HeldItem; dir?: Dir; icon?: IconName; machine?: string; seated?: boolean }
  /** Waits for condition (or timeout), in a given pose. */
  | { t: 'until'; cond: () => boolean; minMs: number; maxMs: number; pose?: Pose; held?: HeldItem; dir?: Dir }
  /** Spawns inside elevator and exits onto forward tile. */
  | { t: 'elevOut'; elev: number; phase: number }
  /** Entra no elevador e some. */
  | { t: 'elevIn'; elev: number; phase: number }
  /** Uses restroom stall: enters, disappears, door closes; exits afterward. */
  | { t: 'stall'; spot: string; ms: number; phase: number }
  /** Liga/desliga a luz da sala no interruptor (precisa estar no spot do interruptor). */
  | { t: 'switch'; room: string; on: boolean; phase: number; onlyIfLast?: boolean }
  /** Participates in gathering (TV, game, chat...) until it concludes; pose directed by social/social.ts. */
  | { t: 'gather'; g: Gathering }
  /** Efeito colateral imediato. */
  | { t: 'do'; fn: () => void }
  /** Removes character from world. */
  | { t: 'remove' };
