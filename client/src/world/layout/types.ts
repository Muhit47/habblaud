// Office layout types. Layout modules are PURE (DOM-free): they produce descriptions
// converted to pixels by renderer and used by simulation for navigation paths and points of interest.
import type { Dir, FloorKind, FurnitureKind, WallStyle } from '../../art/api';

export type AreaKind = 'reception' | 'restroom' | 'cafe' | 'lounge' | 'room' | 'corridor';

/** Rectangle in tiles (absolute world coordinates). */
export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Placed floor furniture. */
export interface FurniturePlacement {
  id: string;
  kind: FurnitureKind;
  variant?: string;
  /** Canto superior esquerdo do footprint, em tiles absolutos. */
  tx: number;
  ty: number;
  /** Rendering offset in px (e.g. chair centered on a 2-tile desk). Does not affect footprint. */
  dx?: number;
  dy?: number;
  /** Relative ordering in assembly animation (0..1). */
  order: number;
  /** For desks: seat index (screen tracks activity of character seated here). */
  seat?: string;
}

/** Wall-mounted item. `cx` = center in world px; `baseY` = base trim line in px. */
export interface WallItemPlacement {
  id: string;
  kind: FurnitureKind;
  variant?: string;
  cx: number;
  baseY: number;
  /** 'face' = face da parede norte; 'south' = sobre a mureta da parede sul. */
  on: 'face' | 'south';
  order: number;
}

export interface Doorway {
  x: number;
  w: number;
}

/** Wall segment in world pixels. */
export type WallSegment =
  | { kind: 'face'; x: number; y: number; w: number; style: WallStyle; doorways?: Doorway[] }
  | { kind: 'south'; x: number; y: number; w: number; style: WallStyle; doorways?: Doorway[] }
  | { kind: 'cap'; x: number; y: number; w: number; h: number; style: WallStyle };

export interface FloorPatch {
  kind: FloorKind;
  /** world px */
  x: number;
  y: number;
  w: number;
  h: number;
  seed: number;
  tint?: string;
  tint2?: string;
}

export interface RugPatch {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  seed: number;
}

export type SpotKind =
  | 'desk' // work station (desk + chair)
  | 'stool' // meeting table stool
  | 'nook' // lounge chair/ottoman inside project room (secondary workspace with laptop)
  | 'stand' // standing spot in room (desk-free work)
  | 'switch' // light switch
  | 'whiteboard'
  | 'coffee'
  | 'water'
  | 'snack'
  | 'fridge'
  | 'cafe_seat'
  | 'sofa'
  | 'armchair'
  | 'beanbag'
  | 'bench'
  | 'pingpong'
  | 'arcade'
  | 'shelf'
  | 'window'
  | 'stall'
  | 'sink'
  | 'elevator'
  | 'talk'
  | 'watch'; // spectator standing spot (watching match)

/**
 * Point of interest. Character walks to walkable approach tile (tx, ty),
 * then snaps to final position (x, y) in px, facing `dir`.
 */
export interface SpotDef {
  id: string;
  kind: SpotKind;
  areaId: string;
  tx: number;
  ty: number;
  x: number;
  y: number;
  dir: Dir;
  seated?: boolean;
  /** Associated furniture (chair, machine, booth...). */
  furnitureId?: string;
  /** Depth to use when occupied (seats: just after furniture). */
  sortY?: number;
  /** Spots em par (ping-pong, conversa) compartilham o grupo. */
  group?: string;
  /** Desk whose screen follows character seated here. */
  deskId?: string;
  /** Preference ordering (desks). */
  rank?: number;
  /** Island side: 'S' = back to camera (screen visible), 'N' = facing camera (desk_back). */
  side?: 'S' | 'N';
}

export interface AreaLayout {
  id: string;
  kind: AreaKind;
  /** Area rectangle in absolute tiles. */
  rect: TileRect;
  floors: FloorPatch[];
  rugs: RugPatch[];
  walls: WallSegment[];
  wallItems: WallItemPlacement[];
  furniture: FurniturePlacement[];
  spots: SpotDef[];
  /** Walkable tiles (absolute), beyond those blocked by furniture. */
  walkable: TileRect[];
  /** Explicitly blocked tiles (dividers drawn as floor, etc.). */
  blocked?: TileRect[];
  /** Doorway tiles (absolute coordinates). */
  door?: TileRect;
  /** For project rooms: corridor side. */
  side?: 'north' | 'south';
  /** Hex color tint subtly applied over floor to give each room visual identity. */
  floorTint?: string;
  /** Darkened rectangle (px) when lights are off. */
  shade?: { x: number; y: number; w: number; h: number };
  /** Room nameplate rectangle (px). */
  signId?: string;
}

/** External decorative element (tree, shrub, post...) rendered by world itself. */
export interface ExteriorProp {
  kind: 'tree' | 'pine' | 'bush' | 'flowers' | 'lamp' | 'bench' | 'rock' | 'hedge' | 'parasol' | 'totem' | 'paving';
  /** world px: bottom center anchor point (base). */
  x: number;
  y: number;
  seed: number;
  /** Associated slot (disappears when room occupies slot). */
  slot?: number;
  /** Inverse: appears only when room IS present in slot (e.g. hedge sealing garden path). */
  whenRoom?: number;
}
