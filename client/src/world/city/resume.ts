// Returning to city on same page (Office → World): player returns EXACTLY where they were. World server
// retains last position per account (on `view.off` or disconnect) and delivers matching initial `pos`; scene saves,
// upon hiding, camera, zoom and local character position, deciding upon reopening based on incoming `pos`:
//   * same place: nothing changes (neither character nor camera; previous city state persists until new snapshot);
//   * different place: character and camera snap directly there without teleport animation, keeping same zoom;
//   * nothing stored (first visit, or dismissed before spawn): standard initial spawn.

/** City state when hidden: camera (world px), zoom, following flag, and character position (tiles). */
export interface CityResume {
  camX: number;
  camY: number;
  zoom: number;
  following: boolean;
  me: { x: number; y: number } | null;
}

/** Proximity threshold (tiles) where server `pos` counts as "same place": coords are rounded and last step may differ. */
export const RESUME_SAME_TILES = 0.6;

export type ResumePlacement = 'keep' | 'snap' | 'fresh';

/** Action for initial `pos` upon reopening scene (see header comments). */
export function resumePlacement(resume: CityResume | null, pos: { x: number; y: number } | null): ResumePlacement {
  if (!resume?.me || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return 'fresh';
  return Math.hypot(pos.x - resume.me.x, pos.y - resume.me.y) <= RESUME_SAME_TILES ? 'keep' : 'snap';
}
