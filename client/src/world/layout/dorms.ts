// Dormitórios e áreas de descanso para os agentes.
import type { WallStyle } from '../../art/api';
import { COL_W, DOOR_W, DOOR_X, NORTH_Y, ROOM_H, SOUTH_Y } from '../constants';
import { AreaBuilder } from './builder';
import type { AreaLayout } from './types';

export const DORM_ANTIGRAVITY_ID = 'core:dorm_antigravity';
export const DORM_KILO_ID = 'core:dorm_kilo';

export const DORM_WALLS = {
  base: '#e8e1d5', // Warm, relaxing tone
  trim: '#a89c8c',
  pattern: 'wood_panel',
} satisfies WallStyle;

function createDorm(id: string, name: string, y: number, isNorth: boolean): AreaLayout {
  const b = new AreaBuilder(id, 'lounge', { x: 2 * COL_W, y, w: COL_W, h: ROOM_H });
  const wall = DORM_WALLS;

  b.floor('wood', 0, 0, 16, 12, 601);
  b.rug(2, 2, 12, 7.5, '#4a3b69', 602); // Cozy purple lounge rug

  // Entry mat at the doorway
  b.rug(DOOR_X - 0.25, isNorth ? 9.5 : 2, DOOR_W + 0.5, 1.25, '#c59a6f', 603);

  // Walls & Doorways exactly aligned with project rooms
  const door = { lx: DOOR_X, w: DOOR_W };
  if (isNorth) {
    b.face(0.5, 15, wall);
    b.south(0.5, 15, 11, wall, [door]);
    b.area.door = { x: 2 * COL_W + DOOR_X, y: y + 11, w: DOOR_W, h: 1 };
  } else {
    b.face(0.5, 15, wall, [door]);
    b.south(0.5, 15, 11, { ...wall, exterior: true });
    // Wall door frame for north wall entrance (like Kilo Office and Restroom)
    b.wall('door_frame', DOOR_X + DOOR_W / 2, undefined, { order: 0.05 });
    b.area.door = { x: 2 * COL_W + DOOR_X, y, w: DOOR_W, h: 2 };
  }
  b.cap(0, 0, 0.5, 12, wall);
  b.cap(15.5, 0, 0.5, 12, wall);

  // Sleeping / resting spots: 2 sofas (3 seats each) + 4 armchairs/beanbags = 10 spots per dorm
  for (const lx of [2, 10]) {
    const f = b.furn('sofa', lx, 3, undefined, { order: 0.5 });
    for (let k = 0; k < 3; k++) {
      b.seat('sofa', 'sofa', lx + k, 3, 'down', undefined, { noFurniture: true, furnitureId: f, sortY: b.py(3) + 10 });
    }
  }
  const secondRow = [{ kind: 'armchair', lx: 2 }, { kind: 'beanbag', lx: 5 }, { kind: 'beanbag', lx: 9 }, { kind: 'armchair', lx: 12 }] as const;
  for (const { kind, lx } of secondRow) {
    const f = b.furn(kind, lx, 6, undefined, { order: 0.6 });
    b.seat(kind, kind, lx, 6, 'down', undefined, { noFurniture: true, furnitureId: f, sortY: b.py(6) + 10 });
  }

  // Decor - place painting away from doorway (cx = 12) so it doesn't clash with the door
  b.furn('floor_lamp', 1, 10, undefined, { order: 0.2 });
  b.furn('plant_tall', 14, 10, 'monstera', { order: 0.21 });
  b.wall('painting', isNorth ? 8 : 12, undefined, { order: 0.6 });

  // Walkability: room interior + doorway connection
  b.walk(1, 2, 14, 9);
  b.walk(DOOR_X, isNorth ? 11 : 0, DOOR_W, isNorth ? 1 : 2);

  return b.build();
}

export function layoutDormAntigravity(): AreaLayout {
  return createDorm(DORM_ANTIGRAVITY_ID, 'Antigravity Dorm', NORTH_Y, true);
}

export function layoutDormKilo(): AreaLayout {
  return createDorm(DORM_KILO_ID, 'Kilo Dorm', SOUTH_Y, false);
}
