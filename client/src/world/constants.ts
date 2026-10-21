// Dimensions and world cadences. Everything in tiles (TILE px) unless noted otherwise.
import { TILE } from '../art/api';

export { TILE };

/** Width of a building column (one north room + one south room). */
export const COL_W = 16;
/** Width in tiles of office hallway (between north and south project rooms). */
export const ROOM_H = 12;
/** Height of the hallway traversing the building east to west. */
export const CORRIDOR_H = 5;
/** Core columns (reception/restrooms, breakroom/lounge, and dorms). */
export const CORE_COLS = 3;

export const NORTH_Y = 0;
export const CORRIDOR_Y = ROOM_H;
export const SOUTH_Y = ROOM_H + CORRIDOR_H;
export const BUILDING_H = ROOM_H * 2 + CORRIDOR_H;

/** Height in tiles of project room interior. */
export const DOOR_X = 7;
export const DOOR_W = 2;

/** Exterior margin surrounding the building (tiles). */
export const EXT_WEST = 20;
export const EXT_EAST = 20;
export const EXT_NORTH = 16;
export const EXT_SOUTH = 24;

/** Width in tiles of project room interior. */
export const WALK_SPEED = 3.2 * TILE;
export const RUN_SPEED = 6 * TILE;

/** Feet offset within the tile where character is standing. */
export const FOOT_DX = TILE / 2;
export const FOOT_DY = 11;

/** Z-index layer ordering. */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 6;

/** Duration of room animations (ms). */
export const BUILD_MS = 2600;
export const DISMANTLE_MS = 2200;
export const DISMANTLE_DELAY_MS = 1500;
/** A vacant slot before the last room waits this long before the farthest room relocates there. */
export const COMPACT_DELAY_MS = 1200;
  /** Floating visual effects (popcorn, coin, celebration confetti). */
export const MISSING_DEBOUNCE_MS = 3000;
