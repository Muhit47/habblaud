// CONTRACT of the art module (procedural pixel art).
//
// - Implementation: client/src/art/index.ts (+ internal files in art/).
// - Consumers: client/src/world/** (office render) and client/src/ui/** (avatars).
// - Rule: modifications here must be ADDITIVE. Do not rename or delete types, kinds, or exported functions.
//
// General conventions
// - Coordinates in "world pixels"; 1 tile = TILE px. All assets are 1x pixel art, scaled by camera
//   with imageSmoothingEnabled = false.
// - Perspective: top-down 3/4, matching modern pixel art office tilesets. See ART DIRECTION below. We see top and FRONT (south face)
//   of objects. North walls display the face (2 tiles high); side and south walls appear
//   only as a thin "cap" to avoid occluding room interiors.
// - Light comes from top-left: brighter tops, darker front faces, soft contact shadow below.
// - Sprites are cached HTMLCanvasElements (generate once, reuse continuously).

// ART DIRECTION (modern top-down 3/4 pixel art office, bright and detailed)
// - Bright, clean office: light porcelain tile with subtle grout, warm hardwood in lounge, light walls,
//   bluish glass partitions, bookshelves with colorful binders, potted plants, paintings, room signage.
// - Desk clusters with 1–2 glowing blue-screen monitors, keyboard, mouse, mug, paperwork; graphite task chairs.
// - Breakroom with light counter and marble backsplash, stainless sink, coffee machine, fridge; water cooler with blue bottle.
// - Lounge with blue/slate-gray sofa and orange cushions, area rug, coffee table, bonsai, large printer.
// - Light palette (cool neutrals + warm wood + saturated accents on objects); 1px dark slate-gray outline
//   (never pure black); 3–4 shades per material; specular highlights; contact shadows; dense micro-details.

import type { AppearanceParts } from '../../../shared/appearance';

export const TILE = 16;

export type Dir = 'down' | 'up' | 'left' | 'right';

/**
 * Character poses. Parentheses indicate expected frame count.
 * "Seated" poses (sit/type/sleep) assume character rests on a seat: legs
 * are tucked/folded and body sits ~4px lower than standing.
 */
export type Pose =
  | 'stand' // standing still, subtle breathing (2)
  | 'walk' // walking (4)
  | 'run' // running, wider stride and leaned body (4)
  | 'sit' // seated still (2)
  | 'type' // seated typing — usually dir 'up', back to camera, alternating arms (4)
  | 'sleep' // seated dozing: head down (2)
  | 'drink' // standing bringing cup to mouth (2) — use with held 'coffee' or 'water'
  | 'use' // standing operating machine: arm extended forward (2)
  | 'raise_hand' // raised arm waving — requesting attention (2); works standing and seated (opts.seated)
  | 'talk' // standing talking, gesturing (2)
  | 'stretch' // standing stretching, arms up (2)
  | 'read' // standing or seated holding book/papers in front (2)
  | 'play' // ping-pong: paddle in hand, alternating arm (2)
  | 'wait' // seated waiting for completion (e.g. shell), leaning back (2). With held 'popcorn': bucket to mouth, eating popcorn; without item: crossed arms, tapping foot/fingers
  // --- social life (additive)
  | 'cheer' // cheering: both arms raised, clenched fists, open mouth, hop on frame 1 (2). Standing or seated (opts.seated)
  | 'laugh' // laughing: eyes closed in arc, open mouth, hand on belly, body shaking 1px (2). Standing or seated
  | 'game' // playing video games: controller (held 'controller') in both hands at chest level, thumbs moving, leaning toward screen (2). Standing or seated
  | 'rps' // rock-paper-scissors. held 'none': closed fist moving up (frame 0) and down (1) counting "rock-paper-scissors"; held 'rock'|'paper'|'scissors': arm extended showing gesture (2). Standing (seated also works)
  | 'groom' // facing mirror (usually dir 'up', back turned): hand near face/hair moving back and forth — lipstick, comb, grooming hair (2). Optional held 'lipstick'|'comb'. Standing
  | 'sulk'; // upset (lost match/bet): slouched shoulders, head down, half-closed eyes, dangling arms (2). Standing or seated

export type HeldItem = 'none' | 'coffee' | 'water' | 'papers' | 'laptop' | 'book' | 'box' | 'paddle' | 'popcorn'
  // --- social life (additive)
  | 'controller' // video game controller (pose 'game'; standing/walking, in one hand)
  | 'rock' // pose 'rps': closed fist (rock)
  | 'paper' // pose 'rps': open hand, palm down (paper)
  | 'scissors' // pose 'rps': index and middle fingers in V (scissors)
  | 'phone' // smartphone (with 'read' or 'sit': looking at screen, thumb scrolling; glowing blue screen)
  | 'lipstick' // lipstick (pose 'groom')
  | 'comb'; // comb (pose 'groom')

export type HairStyle =
  | 'short' | 'buzz' | 'spiky' | 'side_part' | 'curly' | 'afro' | 'bob' | 'long' | 'ponytail' | 'bun' | 'pigtails'
  | 'mohawk' | 'bald' | 'wavy';

export type TopStyle = 'tshirt' | 'hoodie' | 'shirt_tie' | 'sweater' | 'jacket' | 'blouse' | 'polo';

export type Accessory = 'none' | 'glasses' | 'sunglasses' | 'headphones' | 'cap' | 'beanie' | 'earrings' | 'bow';

export interface Appearance {
  skin: string;
  hair: string;
  hairStyle: HairStyle;
  eyes: string;
  top: string;
  topAccent: string;
  topStyle: TopStyle;
  bottom: string;
  shoes: string;
  accessory: Accessory;
  accessoryColor: string;
  /** Lanyard/badge around neck (used to distinguish subagents). null = no lanyard. */
  lanyard: string | null;
  look: 'f' | 'm';
  /** (Optional, additive) Facial hair — only randomized for look 'm'. Absent = clean shaven. */
  facialHair?: 'none' | 'stubble' | 'beard' | 'mustache' | 'goatee';
  /** (Optional, additive) Lower body clothing. Absent = pants. */
  bottomStyle?: 'pants' | 'shorts' | 'skirt';
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Dynamic regions within a sprite (in sprite px, relative to top-left corner). */
export type SpriteRectName = 'screen' | 'board' | 'glass' | 'face' | 'tv' | 'sign' | 'art' | 'glow'
  /**
   * (Additive) 2nd monitor/laptop on `desk`, when present. Sprite includes static dimmed
   * content (spreadsheet/editor/dashboard); world MAY draw over it (e.g. drawScreen 'off'
   * when room lights turn off, or other mode when owner works). Safe to ignore.
   */
  | 'screen2';

export interface Sprite {
  canvas: HTMLCanvasElement;
  /** Anchor point within sprite (px). See conventions in FurnitureDef / characterSprite. */
  ax: number;
  ay: number;
  rects?: Partial<Record<SpriteRectName, Rect>>;
}

/** `front` is drawn ON TOP of whoever is seated/inside (e.g. chair backrest, cubicle door). */
export interface FurnitureSprites {
  base: Sprite;
  front?: Sprite;
}

export interface CharacterFrameRequest {
  appearance: Appearance;
  dir: Dir;
  pose: Pose;
  frame: number;
  held?: HeldItem;
  /** For poses that can be standing or seated (raise_hand, read, talk). */
  seated?: boolean;
  /** Seasonal costume accessory; absent preserves original appearance. */
  costume?: 'santa' | 'witch' | 'pumpkin' | 'vampire';
}

export type FurnitureKind =
  // --- office (project rooms)
  | 'desk' // 2x1. Desk with monitor facing SOUTH (screen visible to camera), keyboard and mug. rects.screen = screen area.
  | 'desk_back' // 2x1. Desk seen from the opposite side: back of monitor visible; person sits NORTH of it, facing down (face visible). For face-to-face desk pods. Same variants as desk.
  | 'office_chair_front' // 1x1 seat facing DOWN (backrest to north, rendered BEFORE character; no front). Counterpart of desk_back.
  | 'office_chair' // 1x1 seat. Backrest to south (character sits facing up, back turned). front = backrest.
  | 'bookshelf' // 2x1 against north wall. Colorful books.
  | 'filing_cabinet' // 1x1 filing cabinet with drawers.
  | 'printer' // 1x1 printer on low credenza.
  | 'trash_bin' // 1x1 small wastebasket (can be smaller than tile).
  | 'plant_small' // 1x1 small potted plant. variants: 'fern' | 'succulent' | 'flower'
  | 'plant_tall' // 1x1 tall plant (up to ~2 tiles tall). variants: 'palm' | 'ficus' | 'monstera' | 'bonsai'
  | 'glass_partition' // 1x1 glass divider segment on white base (half-wall + bluish reflective glass). variants: 'h' (runs east-west) | 'v' (runs north-south) | 'end' (post/column)
  | 'binder_shelf' // 1x1 tall narrow shelf with colorful binders (blue/orange/green) and storage boxes.
  | 'meeting_table' // 3x2 conference table / work table for subagents.
  | 'stool' // 1x1 simple seat (stool). Character can sit facing any direction.
  | 'floor_lamp' // 1x1 floor lamp. rects.glow = light center.
  | 'water_cooler' // 1x1 water cooler with blue bottle. Usage: character stands SOUTH, facing up.
  // --- mounted on north wall (mount: 'wall')
  | 'whiteboard' // 3 tiles wide. Kanban board. rects.board = area where renderer draws sticky notes.
  | 'window' // 2 tiles. Window; rects.glass = glass (renderer draws sky before frame).
  | 'clock' // 1 tile. Clock; rects.face = clock face (hands drawn by renderer).
  | 'poster' // 1 tile. variants: 'code' | 'coffee' | 'rocket' | 'cat' | 'bug' | 'ship_it'
  | 'painting' // 2 tiles. Framed painting; rects.art = painting area (can receive AI-generated artwork).
  | 'tv' // 2 tiles. Wall-mounted TV; rects.tv = screen.
  | 'light_switch' // 1 tile (small sprite). variants: 'on' | 'off'
  | 'elevator' // 2 tiles. Elevator door; state 0..4 = closed .. fully open. Includes indicator light/arrow above.
  | 'door_frame' // 2 tiles. Door frame rendered over opening on north wall face.
  | 'sign' // 3 tiles. Room name sign; rects.sign = text area (renderer renders room name).
  | 'mirror' // 1 tile. Mirror (above bathroom sinks). (Additive) rects.glass = reflective area (world can render reflection of person in front).
  | 'shelf_wall' // 2 tiles. Wall shelf with items.
  // --- breakroom / cafe
  | 'counter' // 1x1 counter section (against north wall). variants: 'plain' | 'drawers'
  | 'counter_sink' // 1x1 counter with sink.
  | 'coffee_machine' // 1x1 counter with coffee maker on top. Usage: character stands SOUTH, facing up. state 0 = idle, 1 = brewing.
  | 'microwave' // 1x1 counter with microwave.
  | 'fridge' // 1x1 tall refrigerator.
  | 'vending_machine' // 1x1 tall illuminated snack vending machine.
  | 'cafe_table' // 1x1 small round table.
  | 'cafe_chair' // 1x1 chair. variant = direction seated occupant faces: 'up' | 'down' | 'left' | 'right'. front when 'up'.
  // --- lounge
  | 'sofa' // 3x1 seat. variant 'down' (facing camera) | 'up' (back turned, front = backrest).
  | 'armchair' // 1x1 armchair. variants like cafe_chair.
  | 'coffee_table' // 2x1 coffee table.
  | 'pingpong_table' // 3x2 ping-pong table (vertical net in center; players on west/east ends).
  | 'beanbag' // 1x1 beanbag (seat). color variants: 'red' | 'blue' | 'yellow' | 'green'
  | 'arcade' // 1x1 arcade cabinet (usage as machine: character stands south facing up). (Additive) rects.screen = screen (world can render drawScreen 'game' on top during a game).
  // --- bathroom
  | 'toilet_stall' // 2x2 cubicle with toilet. Character enters through door (SOUTH side) and vanishes. front = partition/door. state 0 = vacant (ajar door), 1 = occupied (closed door, red indicator).
  | 'sink' // 1x1 sink with cabinet (against north wall; place 'mirror' on wall above).
  // --- reception
  | 'reception_desk' // 3x1 reception desk.
  | 'bench'; // 2x1 waiting bench (seat, facing down).

export interface FurnitureDef {
  mount: 'floor' | 'wall';
  /**
   * Floor: footprint tiles on ground (w x h).
   * Wall: width in tiles on wall face (h ignored).
   */
  footprint: { w: number; h: number };
  /** Floor: whether tiles block passage. Seats do not block (character "steps into" them). */
  blocks: boolean;
  /** Is a seat (character can sit on it). */
  seat?: boolean;
  variants?: readonly string[];
  /** Count of visual states (e.g. elevator 5, toilet_stall 2). */
  states?: number;
}

/**
 * Furniture catalog. Anchor point (ax, ay) of furniture sprites:
 * - mount 'floor': (ax, ay) corresponds to BOTTOM CENTER of footprint in world coords,
 *   i.e. (x0 + w*TILE/2, y0 + h*TILE) where (x0, y0) is top-left corner of footprint.
 *   Sprite can extend upwards (height) and slightly sideways.
 * - mount 'wall': (ax, ay) corresponds to BOTTOM CENTER of wall section, i.e.,
 *   at baseboard line (base of wall face). Sprite offsets its own height naturally.
 * Depth sorting: by world anchor y (larger y = rendered later).
 */
export const FURNITURE: Readonly<Record<FurnitureKind, FurnitureDef>> = {
  desk: { mount: 'floor', footprint: { w: 2, h: 1 }, blocks: true, variants: ['wood', 'white', 'dark'] },
  desk_back: { mount: 'floor', footprint: { w: 2, h: 1 }, blocks: true, variants: ['wood', 'white', 'dark'] },
  office_chair_front: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: false, seat: true, variants: ['black', 'blue', 'red', 'green', 'gray'] },
  office_chair: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: false, seat: true, variants: ['black', 'blue', 'red', 'green', 'gray'] },
  bookshelf: { mount: 'floor', footprint: { w: 2, h: 1 }, blocks: true },
  filing_cabinet: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  printer: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  trash_bin: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  plant_small: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true, variants: ['fern', 'succulent', 'flower'] },
  plant_tall: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true, variants: ['palm', 'ficus', 'monstera', 'bonsai'] },
  glass_partition: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true, variants: ['h', 'v', 'end'] },
  binder_shelf: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  meeting_table: { mount: 'floor', footprint: { w: 3, h: 2 }, blocks: true },
  stool: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: false, seat: true },
  floor_lamp: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  water_cooler: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  whiteboard: { mount: 'wall', footprint: { w: 3, h: 0 }, blocks: false },
  window: { mount: 'wall', footprint: { w: 2, h: 0 }, blocks: false },
  clock: { mount: 'wall', footprint: { w: 1, h: 0 }, blocks: false },
  poster: { mount: 'wall', footprint: { w: 1, h: 0 }, blocks: false, variants: ['code', 'coffee', 'rocket', 'cat', 'bug', 'ship_it'] },
  painting: { mount: 'wall', footprint: { w: 2, h: 0 }, blocks: false },
  tv: { mount: 'wall', footprint: { w: 2, h: 0 }, blocks: false },
  light_switch: { mount: 'wall', footprint: { w: 1, h: 0 }, blocks: false, variants: ['on', 'off'] },
  elevator: { mount: 'wall', footprint: { w: 2, h: 0 }, blocks: false, states: 5 },
  door_frame: { mount: 'wall', footprint: { w: 2, h: 0 }, blocks: false },
  sign: { mount: 'wall', footprint: { w: 3, h: 0 }, blocks: false },
  mirror: { mount: 'wall', footprint: { w: 1, h: 0 }, blocks: false },
  shelf_wall: { mount: 'wall', footprint: { w: 2, h: 0 }, blocks: false },
  counter: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true, variants: ['plain', 'drawers'] },
  counter_sink: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  coffee_machine: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true, states: 2 },
  microwave: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  fridge: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  vending_machine: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  cafe_table: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  cafe_chair: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: false, seat: true, variants: ['up', 'down', 'left', 'right'] },
  sofa: { mount: 'floor', footprint: { w: 3, h: 1 }, blocks: false, seat: true, variants: ['down', 'up'] },
  armchair: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: false, seat: true, variants: ['up', 'down', 'left', 'right'] },
  coffee_table: { mount: 'floor', footprint: { w: 2, h: 1 }, blocks: true },
  pingpong_table: { mount: 'floor', footprint: { w: 3, h: 2 }, blocks: true },
  beanbag: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: false, seat: true, variants: ['red', 'blue', 'yellow', 'green'] },
  arcade: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  toilet_stall: { mount: 'floor', footprint: { w: 2, h: 2 }, blocks: true, states: 2 },
  sink: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  reception_desk: { mount: 'floor', footprint: { w: 3, h: 1 }, blocks: true },
  bench: { mount: 'floor', footprint: { w: 2, h: 1 }, blocks: false, seat: true },
};

export type FloorKind =
  | 'carpet' // project rooms (uses tint/tint2 from room theme)
  | 'wood' // lounge
  | 'tile_check' // breakroom (checkerboard)
  | 'tile_white' // bathroom
  | 'concrete' // hallway (polished concrete)
  | 'marble' // reception
  | 'grass' // outdoor area
  | 'sidewalk' // outdoor sidewalk
  | 'street'; // outdoor street (stripes drawn by renderer if desired)

export type WallPattern = 'plain' | 'stripes' | 'tiles' | 'wood_panel' | 'brick' | 'glass' | 'marble';

export interface WallStyle {
  /** Base wall face color. */
  base: string;
  /** Trim/accent stripe color (baseboard/accent stripe). */
  trim?: string;
  pattern?: WallPattern;
  /** Exterior building wall (sober tone, brick/concrete texture). */
  exterior?: boolean;
}

export interface Doorway {
  /** Start of doorway in world px (absolute) and width in px. */
  x: number;
  w: number;
}

export type ScreenMode =
  | 'off' // monitor powered off (matte navy blue with diagonal reflection; never pitch black)
  | 'standby' // (additive) powered on without active user: blue background with gently pulsing logo — e.g. vacant desk with room lit
  | 'idle' // gentle screensaver
  | 'code' // editor with scrolling colored code lines
  | 'terminal' // dark terminal with emerging green text
  | 'browser' // web page (address bar + layout blocks)
  | 'search' // search results / magnifying glass
  | 'chat' // chat conversation (alternating speech bubbles)
  | 'docs' // text document
  | 'tasks' // checklist of checkboxes
  | 'alert' // screen flashing amber (needs attention)
  | 'progress' // dark terminal with progress bar / spinner running (waiting for command completion)
  // --- social life (additive; intended for lounge TV and arcade, but valid on any screen)
  | 'show' // animated TV broadcast; FIXED mapping by `seed`: seed % 3 === 0 soccer (pitch, players, ball; ball scores periodically and screen flashes "GOAL"), 1 soap opera (two close-up faces, hearts), 2 animated cartoon (vibrant colors)
  | 'game'; // video game (two players); FIXED mapping by `seed`: seed % 2 === 0 split-screen racing (two karts on track), 1 fighting game (two fighters and health bars)

export interface RoomTheme {
  carpet: string;
  carpet2: string;
  wall: WallStyle;
  accent: string;
  deskVariant: string;
  chairVariant: string;
}

/** Small pixel art icons (~8–12px) for overhead character status. */
export type IconName = 'alert' | 'question' | 'zzz' | 'check' | 'heart' | 'coffee' | 'music' | 'idea' | 'sweat' | 'star' | 'lightning' | 'chat' | 'box' | 'wave'
  | 'hourglass' // hourglass (waiting for shell)
  | 'hourglass_flip' // flipping hourglass (alternate with 'hourglass' to animate)
  | 'cobweb' // spiderweb (~12px) on chair corner for prolonged wait
  | 'storm' // rain cloud with lightning (something failed)
  // --- social life (additive)
  | 'coin' // gold coin with sparkle (~8px) — earned money
  | 'sparkle' // 4-pointed star sparkle (~9px) — groomed in mirror
  | 'trophy' // golden trophy (~10px) — won match/bet
  | 'hand_rock' // rock gesture (fist) (~10px) — rock-paper-scissors revelation
  | 'hand_paper' // paper gesture (open hand) (~10px)
  | 'hand_scissors'; // scissors gesture (V) (~10px)

/** Contract exported by art/index.ts (world and UI rely on this). */
export interface ArtModule {
  appearanceFromSeed(seed: number, opts?: { look?: 'f' | 'm'; sub?: boolean; parts?: AppearanceParts }): Appearance;
  /** Anchor: (ax, ay) = feet center (ground contact). Character spans ~14–18px width and ~24–28px height. */
  characterSprite(req: CharacterFrameRequest): Sprite;
  poseFrameCount(pose: Pose): number;
  /** Duration of each pose frame in ms. */
  poseFrameDuration(pose: Pose): number;
  /**
   * `opts.seed` (optional, additive) varies details of repeated items (items on desk, books on
   * shelf, binders...). Without seed, uses variation 0. Sprites remain cached by (kind, variant, state, seed % N).
   */
  furnitureSprites(kind: FurnitureKind, variant?: string, state?: number, opts?: { seed?: number }): FurnitureSprites;
  /** Renders a floor area (world px, multiples of TILE). `seed` varies per-tile details. */
  drawFloor(ctx: CanvasRenderingContext2D, kind: FloorKind, x: number, y: number, w: number, h: number, opts: { seed: number; tint?: string; tint2?: string }): void;
  /** Decorative area rug over floor. */
  drawRug(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, seed: number): void;
  /** North wall face: 2*TILE height from y, with dark top coping and baseboard at bottom. */
  drawWallFace(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, style: WallStyle, opts?: { doorways?: Doorway[] }): void;
  /** Wall top coping (side and faceless spans), arbitrary rectangle. */
  drawWallTop(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, style: WallStyle): void;
  /** South wall: 1 tile high (cap + low partition), with optional doorways. */
  drawSouthWall(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, style: WallStyle, opts?: { doorways?: Doorway[] }): void;
  /** Animated screen content (monitor/TV). `r` in world px. `t` in ms. */
  drawScreen(ctx: CanvasRenderingContext2D, r: Rect, mode: ScreenMode, t: number, seed: number): void;
  /** Sticky notes on kanban board (columns: to do / doing / done). */
  drawBoard(ctx: CanvasRenderingContext2D, r: Rect, items: readonly { status: 'pending' | 'in_progress' | 'completed' }[], t: number): void;
  /** Sky + horizon visible through window based on fractional local hour (0–24). */
  drawWindowView(ctx: CanvasRenderingContext2D, r: Rect, hour: number, t: number, seed: number): void;
  drawClock(ctx: CanvasRenderingContext2D, r: Rect, date: Date): void;
  roomTheme(seed: number): RoomTheme;
  iconSprite(name: IconName): Sprite;
  /**
   * (Optional, additive) TV soccer play for drawScreen('show') with seed % 3 === 0, at timestamp `t`:
   * from `progress >= goalAt` screen flashes "GOAL" (ball in right goal if `right`). World
   * uses this for crowds to celebrate synchronously with TV.
   */
  footballLance?(t: number, seed: number): { lance: number; progress: number; right: boolean; period: number; goalAt: number };
  /** Avatar (head + shoulders) scaled for UI. `parts`: customized pieces (see AgentInfo.parts). */
  avatarCanvas(seed: number, opts?: { look?: 'f' | 'm'; sub?: boolean; scale?: number; parts?: AppearanceParts }): HTMLCanvasElement;
}
