// Character state: position, pose, animation, step queue, and visual markers.
import type { AgentInfo } from '../../../../shared/types';
import type { Appearance, Dir, HeldItem, IconName, Pose } from '../../art/api';
import { mulberry32 } from '../../../../shared/hash';
import { FOOT_DX, FOOT_DY, TILE } from '../constants';
import type { Mode } from './behavior';
import type { Gathering } from '../social/gathering';
import type { ShellStage } from './shell';
import type { Step } from './steps';

export class Character {
  readonly id: string;
  info: AgentInfo;
  appearance: Appearance;
  readonly rng: () => number;

  // position (world px; feet) and logical tile (always walkable when stopped)
  x = 0;
  y = 0;
  tx = 0;
  ty = 0;
  dir: Dir = 'down';
  pose: Pose = 'stand';
  held: HeldItem = 'none';
  seated = false;
  alpha = 1;
  visible = true;
  /** Forced depth (seats). null = uses y. */
  sortY: number | null = null;
  /** Elapsed time (ms) in current pose, to select animation frame. */
  animT = 0;

  // comportamento
  mode: Mode = 'idle';
  queue: Step[] = [];
  step: Step | null = null;
  stepT = 0;
  stepStarted = false;
  /** Replan as soon as current non-interruptible step finishes. */
  replan = false;
  /** Desk/stool/workstation spot (reserved while character exists). */
  homeSpot: string | null = null;
  /** Spot currently occupied (seat/machine), in addition to home spot. */
  atSpot: string | null = null;
  /** Temporary spots reserved during roaming excursion. */
  tempSpots: string[] = [];
  roomId: string;
  leaving = false;
  gone = false;
  arriving = false;
  missingSince: number | null = null;
  /** Next roaming departure for idle agent (epoch ms). */
  nextOutingAt = 0;
  /** Gathering group participating in (or en route to). */
  gathering: Gathering | null = null;
  /** Shell-waiting agent: next attempt to join a gathering (epoch ms; 0 = schedule). */
  nextSocialAt = 0;
  /** Render only after this instant (elevator arrival queue). */
  hiddenUntil = 0;
  /** Hidden (inside booth or closed elevator). */
  inside = false;
  /** Next time planner may run (avoids unnecessary per-frame replanning). */
  thinkAt = 0;
  /** Subagent has delivered results to parent. */
  delivered = false;
  /** Fim do uso da cabine (ms epoch). */
  stallUntil = 0;
  /** Origin for seating snap/unsnap (short interpolation). */
  enterFrom: { x: number; y: number } | null = null;
  /** Crowded room: tile where character works standing (no reserved seat). */
  standTile: { x: number; y: number } | null = null;
  /** Individual walking cadence (±8%), preventing synchronized single-file walking. */
  readonly speedK: number;
  /** Lateral path offset (px): prevents characters sharing path from overlapping. */
  readonly lane: number;
  /** Current visual offset (px), smoothed toward lateral lane while walking. */
  offX = 0;
  offY = 0;

  // marcadores
  icon: IconName | null = null;
  iconUntil = 0;
  iconAt = 0;
  bubbleText: string | null = null;
  bubbleIcon = '';
  bubbleAt = 0;
  bubbleUntil = 0;
  /** Mini conversation speech bubble (emoji). */
  chatEmoji = '';
  chatUntil = 0;
  /** Short speech bubble with text from gatherings: invites, banter, cheers, bets. */
  sayText = '';
  sayAt = 0;
  sayUntil = 0;
  lastActivityId: string | null = null;
  activityChangedAt = 0;

  // shell wait ('shell' mode; logic in sim/shell.ts)
  /** Start (epoch ms) of current wait: oldest shell job. 0 = not waiting. */
  shellSince = 0;
  /** Number of pending shells ("×N" in hourglass indicator). */
  shellCount = 0;
  shellLabel = '';
  /** Gag visual stage (recalculated each frame from wait duration). */
  shellStage: ShellStage | null = null;
  /** When entered 'shell' mode (world clock): speech bubble cadence in 'important' mode. */
  shellEnteredAt = 0;
  /** Cached bubble text: updated only when displayed duration changes (no per-frame string allocations). */
  shellText = '';
  shellTextKey = -1;
  /**
   * Reaction to shell completion (cheer/lament) active until this instant: mode change
   * does not interrupt it (step queue returns to desk, then planner follows current status).
   */
  reactUntil = 0;
  /** `at` of last handled 'ShellDone' Activity (events prior to arrival are not celebrated). */
  shellDoneAt = 0;
  /** Render: next popcorn kernel popping from bucket (epoch ms). */
  popcornAt = 0;

  constructor(info: AgentInfo, appearance: Appearance) {
    this.id = info.id;
    this.info = info;
    this.appearance = appearance;
    this.roomId = info.roomId;
    this.rng = mulberry32((info.seed ^ 0x9e3779b9) >>> 0);
    // derived from dedicated generator so behavior RNG sequence remains unaffected
    const r = mulberry32((info.seed ^ 0x51ed27a3) >>> 0);
    this.speedK = 0.92 + r() * 0.16;
    this.lane = Math.round((r() * 2 - 1) * 3.5);
  }

  /** Aproxima o deslocamento visual da faixa (andando) ou do centro (parado). */
  updateLane(dt: number): void {
    const walking = this.pose === 'walk' || this.pose === 'run';
    const horiz = this.dir === 'left' || this.dir === 'right';
    const tx = walking && !horiz ? this.lane : 0;
    const ty = walking && horiz ? this.lane * 0.6 : 0;
    const k = Math.min(1, dt * 5);
    this.offX += (tx - this.offX) * k;
    this.offY += (ty - this.offY) * k;
    if (Math.abs(this.offX) < 0.05) this.offX = 0;
    if (Math.abs(this.offY) < 0.05) this.offY = 0;
  }

  /** Places feet at default tile baseline point. */
  placeAtTile(tx: number, ty: number): void {
    this.tx = tx;
    this.ty = ty;
    this.x = tx * TILE + FOOT_DX;
    this.y = ty * TILE + FOOT_DY;
  }

  setPose(pose: Pose, held: HeldItem = 'none'): void {
    if (this.pose !== pose) {
      this.pose = pose;
      this.animT = 0;
    }
    this.held = held;
  }

  setIcon(icon: IconName | null, ms: number, now: number): void {
    this.icon = icon;
    this.iconAt = now;
    this.iconUntil = icon ? now + ms : 0;
  }

  showBubble(icon: string, text: string, ms: number, now: number): void {
    this.bubbleIcon = icon;
    this.bubbleText = text;
    this.bubbleAt = now;
    this.bubbleUntil = now + ms;
  }

  depth(): number {
    return this.sortY ?? this.y;
  }
}

/** Dominant direction of displacement vector. */
export function dirOf(dx: number, dy: number, fallback: Dir): Dir {
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return fallback;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

/** Direction from A facing toward B. */
export function facing(ax: number, ay: number, bx: number, by: number): Dir {
  return dirOf(bx - ax, by - ay, 'down');
}
