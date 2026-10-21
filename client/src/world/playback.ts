// Timelapse in world: during replay simulation runs on dedicated clock, accelerated by moderate
// animation factor (traversing 1 h recording in 6 s would not fit realistic footstep cadences), while
// snapshots arrive on recording time, much faster. For thresholds comparing snapshot timestamps
// against "now" (nap after 10 min idle, shell wait stages, lengthy foreground command),
// ages are preserved: snapshot times are shifted to world clock when applied (rebaseSnapshot).
import type { OfficeSnapshot } from '../../../shared/types';

/**
 * World animation multiplier for playback speed: ~sqrt(speed), clamped between 1 and 16
 * (60× -> 6, 180× -> 10, 600× -> 16). Above this, characters would only teleport.
 */
export function animScale(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return 0;
  return Math.min(16, Math.max(1, Math.round(Math.sqrt(speed) * 0.75)));
}

/**
 * Shifts snapshot timestamps compared against "now" to world clock:
 * `statusSince` and shell starts. Activities remain unchanged (world only compares them relatively).
 */
export function rebaseSnapshot(snap: OfficeSnapshot, delta: number): OfficeSnapshot {
  if (!delta) return snap;
  return {
    ...snap,
    serverTime: snap.serverTime + delta,
    agents: snap.agents.map((a) => {
      const out = { ...a, statusSince: a.statusSince + delta };
      if (a.shells) out.shells = a.shells.map((j) => ({ ...j, startedAt: j.startedAt + delta }));
      return out;
    }),
  };
}
