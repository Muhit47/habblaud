// "Waiting for shell to finish" — PURE rules (testable without DOM) for the office visual gag.
//
// Comedic escalation based on age of oldest shell job:
// - 0–3 min   ('popcorn'):  reclining with popcorn bucket, watching terminal like a movie;
// - 3–10 min  ('restless'): popcorn finished; crossed arms and occasional chair spin;
// - 10–25 min ('cobweb'):   cobweb in corner (expands to 2x after 20 min) and yawns;
// - > 25 min  ('nap'):      napping at desk, covered in cobwebs.
// Always: flipping hourglass over head, monitor on 'progress', and "⏳ <label> · <time>" bubble.
import type { Activity, AgentStatus, ShellJob } from '../../../../shared/types';
import type { Dir, IconName } from '../../art/api';
import { tr } from '../../../../shared/i18n';

export type ShellStage = 'popcorn' | 'restless' | 'cobweb' | 'nap';

/** Activity tool name registered by server when a shell terminates (agreed contract). */
export const SHELL_DONE_TOOL = 'ShellDone';

/** Escalation wait thresholds (ms). */
export const SHELL_RESTLESS_MS = 3 * 60_000;
export const SHELL_COBWEB_MS = 10 * 60_000;
export const SHELL_COBWEB_BIG_MS = 20 * 60_000;
export const SHELL_NAP_MS = 25 * 60_000;

/**
 * FOREGROUND command: only transitions to "waiting" after this delay. Quick commands (ls, git status...)
 * do not interrupt typing.
 */
export const FOREGROUND_WAIT_MS = 10_000;

/** Full chair spin: duration and interval between spins ('restless' stage). */
export const SPIN_MS = 800;
export const SPIN_GAP_MIN_MS = 15_000;
export const SPIN_GAP_MAX_MS = 25_000;
/** First spin right after popcorn finishes (does not wait for full interval). */
const SPIN_FIRST_MS = 2_500;

/** Yawn ('cobweb' stage): duration and interval. */
export const YAWN_MS = 1_300;
export const YAWN_GAP_MIN_MS = 18_000;
export const YAWN_GAP_MAX_MS = 32_000;
const YAWN_FIRST_MS = 4_000;

/** Rain cloud ('storm') is positioned slightly higher than other icons: raindrops fall to character head. */
export const STORM_LIFT = 3;

/** Hourglass flips at this interval (alternates 'hourglass' / 'hourglass_flip'). */
export const HOURGLASS_FLIP_MS = 1_200;

/** Speech bubble in 'important' mode: on entering state, then for 4 s every ~30 s. */
export const SHELL_BUBBLE_ENTER_MS = 6_000;
export const SHELL_BUBBLE_EVERY_MS = 30_000;
export const SHELL_BUBBLE_SHOW_MS = 4_000;
const BUBBLE_FADE_IN_MS = 150;
const BUBBLE_FADE_OUT_MS = 400;

/** Visual gag stage based on wait duration (ms). */
export function shellStage(ageMs: number): ShellStage {
  if (ageMs >= SHELL_NAP_MS) return 'nap';
  if (ageMs >= SHELL_COBWEB_MS) return 'cobweb';
  if (ageMs >= SHELL_RESTLESS_MS) return 'restless';
  return 'popcorn';
}

/** Integer scale of cobweb: 0 = no web, 1x after 10 min, 2x after 20 min. */
export function cobwebScale(ageMs: number): 0 | 1 | 2 {
  if (ageMs < SHELL_COBWEB_MS) return 0;
  return ageMs >= SHELL_COBWEB_BIG_MS ? 2 : 1;
}

/** Quadro da ampulheta animada. */
export function hourglassIcon(now: number): IconName {
  return Math.floor(now / HOURGLASS_FLIP_MS) % 2 ? 'hourglass_flip' : 'hourglass';
}

// ------------------------------------------------------------------ shells do agente

/** Counted in wait? In foreground, only unresolved commands without result (background === false). */
function counts(j: ShellJob, foregroundOnly: boolean): boolean {
  return !foregroundOnly || j.background === false;
}

/** Oldest evaluated shell job (allocation-free). `foregroundOnly`: foreground only. */
export function oldestShell(shells: readonly ShellJob[] | undefined, foregroundOnly: boolean): ShellJob | null {
  if (!shells) return null;
  let best: ShellJob | null = null;
  for (const j of shells) {
    if (!counts(j, foregroundOnly) || !Number.isFinite(j.startedAt)) continue;
    if (!best || j.startedAt < best.startedAt) best = j;
  }
  return best;
}

/** Shell count being waited on (matching `oldestShell` criteria). */
export function countShells(shells: readonly ShellJob[] | undefined, foregroundOnly: boolean): number {
  if (!shells) return 0;
  let n = 0;
  for (const j of shells) if (counts(j, foregroundOnly)) n++;
  return n;
}

/**
 * Waiting on foreground command longer than FOREGROUND_WAIT_MS? (status 'working' with lengthy
 * Bash command awaiting result: agent idle watching command run.)
 */
export function foregroundWaiting(shells: readonly ShellJob[] | undefined, now: number): boolean {
  const j = oldestShell(shells, true);
  return !!j && now - j.startedAt > FOREGROUND_WAIT_MS;
}

/**
 * Wait onset (epoch ms) for agent in 'shell' mode: oldest shell (foreground when
 * status is 'working'); without listed shells, instant status changed.
 */
export function shellWaitSince(a: { status: AgentStatus; shells?: ShellJob[]; statusSince: number }): number {
  const j = oldestShell(a.shells, a.status !== 'shell');
  return j ? j.startedAt : a.statusSince;
}

/** Speech bubble label: oldest shell label or generic fallback text. */
export function shellLabel(a: { status: AgentStatus; shells?: ShellJob[] }): string {
  const fg = a.status !== 'shell';
  const j = oldestShell(a.shells, fg);
  const label = j?.label?.trim();
  if (label) return label;
  if (j?.kind === 'monitor') return tr('Monitorando um processo');
  return fg ? tr('Comando no terminal') : tr('Comando em segundo plano');
}

/**
 * Most recent 'ShellDone' Activity for agent (current or recent — another activity may have
 * arrived in same snapshot), or null. Allocation-free.
 */
export function latestShellDone(a: { activity?: Activity; recent?: readonly Activity[] }): Activity | null {
  let best: Activity | null = a.activity?.tool === SHELL_DONE_TOOL ? a.activity : null;
  const recent = a.recent;
  if (recent) {
    for (let i = recent.length - 1; i >= 0; i--) {
      const r = recent[i];
      if (r.tool === SHELL_DONE_TOOL && (!best || r.at > best.at)) best = r;
    }
  }
  return best;
}

// ------------------------------------------------------------------ time and speech bubble

/** Formatted wait duration: "45 s", "3 min", "1 h 05". */
export function formatShellAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h} h ${mm < 10 ? '0' : ''}${mm}`;
}

/**
 * Cache key that changes exactly when `formatShellAge` text changes (bubble only recreates string
 * when needed — seconds in first minute, then minutes).
 */
export function shellAgeKey(ms: number): number {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? s : 60 + Math.floor(s / 60);
}

/** Speech bubble text (⏳ is the bubble icon). */
export function shellBubbleText(label: string, ageMs: number): string {
  return `${label} · ${formatShellAge(ageMs)}`;
}

/**
 * Opacity (0..1) of wait bubble in 'important' mode, `ms` after entering state:
 * visible during initial SHELL_BUBBLE_ENTER_MS; then for SHELL_BUBBLE_SHOW_MS every
 * SHELL_BUBBLE_EVERY_MS (staggered by `offsetMs`, preventing synchronized flashing across characters).
 */
export function shellBubbleAlpha(ms: number, offsetMs = 0): number {
  if (ms < 0) return 0;
  if (ms < SHELL_BUBBLE_ENTER_MS) return windowAlpha(ms, SHELL_BUBBLE_ENTER_MS);
  const off = ((offsetMs % SHELL_BUBBLE_EVERY_MS) + SHELL_BUBBLE_EVERY_MS) % SHELL_BUBBLE_EVERY_MS;
  // first recurrence ~30 s after onset
  const t = ms - SHELL_BUBBLE_EVERY_MS - off;
  if (t < 0) return 0;
  const inCycle = t % SHELL_BUBBLE_EVERY_MS;
  return inCycle < SHELL_BUBBLE_SHOW_MS ? windowAlpha(inCycle, SHELL_BUBBLE_SHOW_MS) : 0;
}

function windowAlpha(t: number, len: number): number {
  return Math.max(0, Math.min(1, t / BUBBLE_FADE_IN_MS, (len - t) / BUBBLE_FADE_OUT_MS));
}

// ------------------------------------------------------------------ giros e bocejos

/** Pseudorandom number in [0, 1) deterministic by (seed, index, salt). */
export function unitHash(seed: number, k: number, salt: number): number {
  let h = (seed ^ Math.imul(k + 1, 0x9e3779b1) ^ Math.imul(salt, 0x85ebca77)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Phase (0..1) of periodic event at `ageMs`, or -1 if outside active window. Events of `durMs` begin at
 * `fromMs + firstMs` and repeat with intervals sampled (by seed) in [gapMin, gapMax],
 * only while `ageMs < toMs`. Allocation-free (tight loop: few iterations in worst case).
 */
export function periodicPhase(ageMs: number, fromMs: number, toMs: number, firstMs: number, gapMin: number, gapMax: number, durMs: number, seed: number, salt: number): number {
  if (ageMs < fromMs || ageMs >= toMs) return -1;
  let t = fromMs + firstMs;
  for (let k = 0; t <= ageMs && k < 10_000; k++) {
    if (ageMs < t + durMs) return (ageMs - t) / durMs;
    t += gapMin + unitHash(seed, k, salt) * (gapMax - gapMin);
  }
  return -1;
}

/** Chair spin phase (0..1), or -1. Spins occur every 15–25 s in 'restless' stage. */
export function spinPhase(ageMs: number, seed: number): number {
  return periodicPhase(ageMs, SHELL_RESTLESS_MS, SHELL_COBWEB_MS, SPIN_FIRST_MS, SPIN_GAP_MIN_MS, SPIN_GAP_MAX_MS, SPIN_MS, seed, 1);
}

/** Yawn phase (0..1), or -1. Occurs occasionally in 'cobweb' stage. */
export function yawnPhase(ageMs: number, seed: number): number {
  return periodicPhase(ageMs, SHELL_COBWEB_MS, SHELL_NAP_MS, YAWN_FIRST_MS, YAWN_GAP_MIN_MS, YAWN_GAP_MAX_MS, YAWN_MS, seed, 2);
}

/** Clockwise direction seen from above: north -> east -> south -> west. */
const CLOCKWISE: readonly Dir[] = ['up', 'right', 'down', 'left'];

/**
 * Direction during chair spin (phase 0..1): complete clockwise turn, quarter-turn at a time,
 * returning back to original `base` direction.
 */
export function spinDir(phase: number, base: Dir): Dir {
  if (phase < 0) return base;
  const i = CLOCKWISE.indexOf(base);
  const q = Math.min(3, Math.floor(phase * 4));
  return CLOCKWISE[(i + q + 1) % 4];
}
