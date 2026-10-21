// Unit tests for pure art module components (no DOM): appearance, templates, characters, furniture,
// floors, walls, icons, themes, and per-frame rendering (using mock context).
import { describe, expect, it } from 'vitest';
import { ACCESSORIES, BOTTOM_STYLES, FACIAL_HAIR, HAIR_STYLES, PART_KEYS, TOP_STYLES } from '../../../shared/appearance';
import { FURNITURE, TILE, type Accessory, type Appearance, type Dir, type FloorKind, type FurnitureKind, type HairStyle, type HeldItem, type Pose, type ScreenMode, type TopStyle, type WallPattern } from './api';
import { appearanceFromSeed, appearanceKey, editorConflict, editorOptions, fitToOptions } from './character/appearance';
import { HAIR, HEAD_BASE } from './character/hair';
import { CHAR_AX, CHAR_AY, CHAR_H, CHAR_W, POSE_DURATION, POSE_FRAMES, isSeated, renderCharacter } from './character/render';
import { PixelBuf } from './core/pixbuf';
import type { BufSprite } from './core/sprite';
import { drawBoard, drawClock, drawScreen, drawWindowView } from './dynamic';
import { normalizeFurniture, renderFurniture } from './furniture/index';
import { ICON_NAMES, iconTemplates, renderIcon } from './icons';
import { CHUNK_PX, floorChunk } from './surfaces/floor';
import { southWallTile, wallFaceTile } from './surfaces/walls';
import { THEME_COUNT, roomTheme } from './theme';

const DIRS: Dir[] = ['down', 'left', 'up', 'right'];

/** FNV-1a byte hash (to compare rendered images without Node/Buffer dependency). */
function digest(data: Uint8ClampedArray): string {
  let h = 0x811c9dc5;
  let g = 0x01000193;
  for (let i = 0; i < data.length; i++) {
    h = Math.imul(h ^ data[i], 0x01000193);
    g = Math.imul(g ^ data[i], 0x5bd1e995) + i;
  }
  return `${h >>> 0}:${g >>> 0}`;
}
/** Count of opaque buffer pixels matching exact color `hex` (#rrggbb). */
function countColor(buf: PixelBuf, hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = n >> 16;
  const g = (n >> 8) & 255;
  const b = n & 255;
  let c = 0;
  for (let i = 0; i < buf.data.length; i += 4) if (buf.data[i + 3] > 200 && buf.data[i] === r && buf.data[i + 1] === g && buf.data[i + 2] === b) c++;
  return c;
}

/** Draws sprites (anchored at coordinate) into large buffer in order — matching world composition. */
function compose(...layers: [BufSprite, number, number][]): PixelBuf {
  const out = new PixelBuf(96, 96);
  for (const [s, x, y] of layers) out.draw(s.buf, x - s.ax, y - s.ay);
  return out;
}
const POSES = Object.keys(POSE_FRAMES) as Pose[];
const HELD: HeldItem[] = [
  'none', 'coffee', 'water', 'papers', 'laptop', 'book', 'box', 'paddle', 'popcorn',
  'controller', 'rock', 'paper', 'scissors', 'phone', 'lipstick', 'comb',
];
const SCREEN_MODES: ScreenMode[] = ['off', 'standby', 'idle', 'code', 'terminal', 'browser', 'search', 'chat', 'docs', 'tasks', 'alert', 'progress', 'show', 'game'];

describe('appearanceFromSeed', () => {
  it('is deterministic', () => {
    for (const seed of [0, 1, 42, 123456, 0xffffffff]) {
      expect(appearanceFromSeed(seed)).toEqual(appearanceFromSeed(seed));
      expect(appearanceFromSeed(seed, { look: 'f', sub: true })).toEqual(appearanceFromSeed(seed, { look: 'f', sub: true }));
    }
  });

  it('gera grande variedade em 40 sementes', () => {
    const list = Array.from({ length: 40 }, (_, i) => appearanceFromSeed(i + 1));
    const distinct = (f: (a: (typeof list)[number]) => string) => new Set(list.map(f)).size;
    expect(new Set(list.map(appearanceKey)).size).toBe(40);
    expect(distinct((a) => a.hairStyle)).toBeGreaterThanOrEqual(10);
    expect(distinct((a) => a.topStyle)).toBeGreaterThanOrEqual(6);
    expect(distinct((a) => a.skin)).toBeGreaterThanOrEqual(6);
    expect(distinct((a) => a.hair)).toBeGreaterThanOrEqual(6);
    expect(distinct((a) => a.accessory)).toBeGreaterThanOrEqual(5);
  });

  it('cobre todos os estilos de cabelo e roupa ao longo de muitas sementes', () => {
    const hair = new Set<string>();
    const tops = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const a = appearanceFromSeed(i);
      hair.add(a.hairStyle);
      tops.add(a.topStyle);
    }
    expect(hair.size).toBe(14);
    expect(tops.size).toBe(7);
  });

  it('respects look (no facial hair for f) and badge for subagents', () => {
    for (let i = 0; i < 300; i++) {
      const f = appearanceFromSeed(i, { look: 'f' });
      expect(f.look).toBe('f');
      expect(f.facialHair ?? 'none').toBe('none');
      expect(appearanceFromSeed(i, { look: 'm' }).look).toBe('m');
      expect(appearanceFromSeed(i, { sub: true }).lanyard).toMatch(/^#/);
      expect(appearanceFromSeed(i).lanyard).toBeNull();
    }
  });
});

describe('head and hair templates', () => {
  const allowedHair = new Set('.ohHdDzka');
  const allowedHead = new Set('.sSLeEbmr');
  it('have equal-length rows and known characters only', () => {
    for (const tpl of Object.values(HEAD_BASE)) {
      for (const row of tpl.rows) {
        expect(row.length).toBe(14);
        for (const ch of row) expect(allowedHead.has(ch)).toBe(true);
      }
    }
    for (const [style, views] of Object.entries(HAIR)) {
      for (const [view, layers] of Object.entries(views)) {
        for (const tpl of [layers.front, layers.back]) {
          if (!tpl) continue;
          const w = tpl.rows[0].length;
          for (const row of tpl.rows) {
            expect(row.length, `${style}/${view}`).toBe(w);
            for (const ch of row) expect(allowedHair.has(ch), `${style}/${view} '${ch}'`).toBe(true);
          }
        }
      }
    }
  });
});

describe('personagens', () => {
  const a = appearanceFromSeed(7, { sub: true });
  it('renders all poses × directions × frames × items', () => {
    for (const pose of POSES) {
      for (const dir of DIRS) {
        for (let frame = 0; frame < POSE_FRAMES[pose]; frame++) {
          for (const held of HELD) {
            const s = renderCharacter({ appearance: a, dir, pose, frame, held });
            expect(s.buf.w).toBe(CHAR_W);
            expect(s.buf.h).toBe(CHAR_H);
            expect(s.ax).toBe(CHAR_AX);
            expect(s.ay).toBe(CHAR_AY);
            expect(s.buf.countOpaque()).toBeGreaterThan(150);
          }
        }
      }
    }
  });

  it('standing, feet align with anchor point', () => {
    for (const dir of DIRS) {
      const s = renderCharacter({ appearance: a, dir, pose: 'stand', frame: 0 });
      let feet = 0;
      for (let x = CHAR_AX - 4; x < CHAR_AX + 4; x++) if (s.buf.alpha(x, CHAR_AY - 1) > 200) feet++;
      expect(feet, dir).toBeGreaterThan(2);
    }
  });

  it('right direction mirrors left', () => {
    const l = renderCharacter({ appearance: a, dir: 'left', pose: 'walk', frame: 1 });
    const r = renderCharacter({ appearance: a, dir: 'right', pose: 'walk', frame: 1 });
    expect(r.buf.flipped().data).toEqual(l.buf.data);
  });

  it('style variations yield distinct sprites', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const s = renderCharacter({ appearance: appearanceFromSeed(i), dir: 'down', pose: 'stand', frame: 0 });
      keys.add(digest(s.buf.data));
    }
    expect(keys.size).toBe(40);
  });
});

describe("pose 'wait' (esperando o shell) e o balde de pipoca", () => {
  /** Listras vermelhas do balde (iluminada e base). */
  const red = (b: PixelBuf) => countColor(b, '#d8413f') + countColor(b, '#ef6457');
  const KERNEL = '#fff9e6';
  const cast = [
    appearanceFromSeed(77, { look: 'm' }),
    appearanceFromSeed(2024, { look: 'f', sub: true }),
    appearanceFromSeed(5150, { look: 'f' }),
    { ...appearanceFromSeed(31), topStyle: 'hoodie' as const, hairStyle: 'long' as const },
  ];
  /** Seated character feet anchor 3 px above seat base (matching world). */
  const FOOT = 3;
  const X = 48;
  const Y = 56;
  const wait = (a: (typeof cast)[number], dir: Dir, frame: number, held: HeldItem) =>
    renderCharacter({ appearance: a, dir, pose: 'wait', frame, held, seated: true });

  it('is seated, with 2 frames and designated duration', () => {
    expect(POSE_FRAMES.wait).toBe(2);
    expect(POSE_DURATION.wait).toBeGreaterThanOrEqual(300);
    expect(POSE_DURATION.wait).toBeLessThanOrEqual(800);
    expect(isSeated('wait')).toBe(true);
    expect(isSeated('wait', false)).toBe(true);
  });

  it('animates (2 frames differ) and is deterministic across all directions, with/without popcorn', () => {
    for (const a of cast) {
      for (const dir of DIRS) {
        for (const held of ['popcorn', 'none'] as const) {
          const f0 = digest(wait(a, dir, 0, held).buf.data);
          const f1 = digest(wait(a, dir, 1, held).buf.data);
          expect(f0, `${dir}/${held}`).not.toBe(f1);
          expect(digest(wait(a, dir, 0, held).buf.data)).toBe(f0);
        }
      }
    }
  });

  it('reclines 1 px back: up in front view, down in rear view, back in profile', () => {
    const a = { ...cast[0], hairStyle: 'buzz' as const, accessory: 'none' as const };
    const top = (dir: Dir, pose: Pose) => renderCharacter({ appearance: a, dir, pose, frame: 0, seated: true }).buf.bounds()?.y ?? -1;
    expect(top('down', 'wait')).toBe(top('down', 'sit') - 1);
    expect(top('up', 'wait')).toBe(top('up', 'sit') + 1);
    // Profile facing left: head (upper rows) shifts 1 px right.
    const headX = (pose: Pose) => renderCharacter({ appearance: a, dir: 'left', pose, frame: 0, seated: true }).buf.crop(0, 0, CHAR_W, 20).bounds()?.x ?? -1;
    expect(headX('wait')).toBe(headX('sit') + 1);
  });

  it('popcorn legible at desk: in front view above desk_back, in rear view clear of backrest', () => {
    for (const a of cast) {
      for (const frame of [0, 1]) {
        // Front view: office_chair_front, character, and 1 tile south desk_back on top (all variations).
        for (let seed = 0; seed < 4; seed++) {
          const scene = compose(
            [renderFurniture('office_chair_front', 'blue').base, X, Y],
            [wait(a, 'down', frame, 'popcorn'), X, Y - FOOT],
            [renderFurniture('desk_back', 'white', 0, seed).base, X, Y + TILE],
          );
          expect(red(scene), `frente seed ${seed} q${frame}`).toBeGreaterThanOrEqual(6);
        }
        // Facing away: office_chair with backrest (front) drawn on top.
        const chair = renderFurniture('office_chair', 'blue');
        const back = compose([chair.base, X, Y], [wait(a, 'up', frame, 'popcorn'), X, Y - FOOT], [chair.front as BufSprite, X, Y]);
        expect(red(back), `costas q${frame}`).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it('popcorn also works on sofa, armchair, and stool', () => {
    const a = cast[0];
    const sofa = renderFurniture('sofa', 'down');
    expect(red(compose([sofa.base, X, Y], [wait(a, 'down', 0, 'popcorn'), X, Y - FOOT]))).toBeGreaterThanOrEqual(8);
    for (const dir of ['left', 'right'] as const) {
      const arm = renderFurniture('armchair', dir);
      expect(red(compose([arm.base, X, Y], [wait(a, dir, 1, 'popcorn'), X, Y - FOOT])), dir).toBeGreaterThanOrEqual(8);
    }
    expect(red(compose([renderFurniture('stool').base, X, Y], [wait(a, 'down', 1, 'popcorn'), X, Y - FOOT]))).toBeGreaterThanOrEqual(8);
  });

  it('eating: on frame 1 hand brings popcorn to mouth (front and profile)', () => {
    for (const a of cast) {
      for (const dir of ['down', 'left'] as const) {
        // Bucket popcorn rim starts at row 20; above it only hand popcorn exists.
        const above = (frame: number) => countColor(wait(a, dir, frame, 'popcorn').buf.crop(0, 0, CHAR_W, 20), KERNEL);
        expect(above(1), dir).toBeGreaterThan(0);
        expect(above(0), dir).toBe(0);
      }
    }
  });

  it('bucket appears in hand standing and walking across all 4 directions', () => {
    for (const pose of ['stand', 'walk'] as const) {
      for (const dir of DIRS) {
        for (let frame = 0; frame < POSE_FRAMES[pose]; frame++) {
          const s = renderCharacter({ appearance: cast[1], dir, pose, frame, held: 'popcorn' });
          expect(red(s.buf), `${pose}/${dir}/${frame}`).toBeGreaterThanOrEqual(4);
          expect(countColor(s.buf, KERNEL), `${pose}/${dir}/${frame}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('without item: crossed arms above desk_back tabletop, with finger-tapping hand', () => {
    for (const a of cast) {
      const skin = (frame: number) => countColor(wait(a, 'down', frame, 'none').buf.crop(5, 20, 3, 6), a.skin);
      // Hand on left arm appears in both frames and alternates height (tapping fingers).
      expect(skin(0)).toBeGreaterThan(0);
      expect(skin(1)).toBeGreaterThan(0);
      const rowsWithSkin = (frame: number) => {
        const b = wait(a, 'down', frame, 'none').buf;
        return [20, 21, 22, 23, 24].filter((y) => countColor(b.crop(5, y, 2, 1), a.skin) > 0).join(',');
      };
      expect(rowsWithSkin(0)).not.toBe(rowsWithSkin(1));
      // Visible with desk_back in front: arms (sleeve or skin) above occlusion cutoff.
      const plain = compose([wait(a, 'down', 0, 'none'), X, Y - FOOT], [renderFurniture('desk_back', 'white', 0, 0).base, X, Y + TILE]);
      const sit = compose([renderCharacter({ appearance: a, dir: 'down', pose: 'sit', frame: 0, seated: true }), X, Y - FOOT], [renderFurniture('desk_back', 'white', 0, 0).base, X, Y + TILE]);
      expect(digest(plain.data)).not.toBe(digest(sit.data));
    }
  });
});

describe('vida social: poses, itens e gestos', () => {
  /** Fixed appearance (fair skin, no accessory): predictable colors for pixel counting. */
  const A: Appearance = {
    skin: '#f6cfb0',
    hair: '#5f3c28',
    hairStyle: 'short',
    eyes: '#2b2236',
    top: '#4a86d8',
    topAccent: '#f4f4f0',
    topStyle: 'tshirt',
    bottom: '#3f5f8c',
    shoes: '#2b2b33',
    accessory: 'none',
    accessoryColor: '#2b2b33',
    lanyard: null,
    look: 'm',
    facialHair: 'none',
    bottomStyle: 'pants',
  };
  const SOCIAL: Pose[] = ['cheer', 'laugh', 'game', 'rps', 'groom', 'sulk'];
  const draw = (pose: Pose, dir: Dir, frame: number, held: HeldItem = 'none', seated = false) =>
    renderCharacter({ appearance: A, dir, pose, frame, held, seated }).buf;
  /** Opaque pixels within bounds [x0, x1) × [y0, y1). */
  const opaqueIn = (b: PixelBuf, x0: number, x1: number, y0: number, y1: number) => {
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (b.alpha(x, y) > 200) n++;
    return n;
  };
  /** Pixels matching skin tones (highlight, base, and shadow ramp). */
  const skinIn = (b: PixelBuf, x0: number, x1: number, y0: number, y1: number) => {
    const n = parseInt(A.skin.slice(1), 16);
    const [sr, sg, sb] = [n >> 16, (n >> 8) & 255, n & 255];
    let c = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * b.w + x) * 4;
        if (b.data[i + 3] < 200) continue;
        if (Math.abs(b.data[i] - sr) + Math.abs(b.data[i + 1] - sg) + Math.abs(b.data[i + 2] - sb) < 70) c++;
      }
    }
    return c;
  };

  it('2 frames each with distinct durations; groom is standing only, others sit when requested', () => {
    for (const pose of SOCIAL) {
      expect(POSE_FRAMES[pose], pose).toBe(2);
      expect(POSE_DURATION[pose], pose).toBeGreaterThan(100);
      expect(isSeated(pose, false), pose).toBe(false);
      expect(isSeated(pose, true), pose).toBe(pose !== 'groom');
    }
  });

  it('animate (2 frames differ) across all directions standing and seated, and are deterministic', () => {
    const cases: [Pose, HeldItem][] = [['cheer', 'none'], ['laugh', 'none'], ['game', 'controller'], ['rps', 'none'], ['rps', 'paper'], ['groom', 'lipstick'], ['groom', 'comb'], ['sulk', 'none']];
    for (const [pose, held] of cases) {
      for (const dir of DIRS) {
        for (const seated of pose === 'groom' ? [false] : [false, true]) {
          const f0 = digest(draw(pose, dir, 0, held, seated).data);
          expect(digest(draw(pose, dir, 1, held, seated).data), `${pose}/${held}/${dir}/${seated}`).not.toBe(f0);
          expect(digest(draw(pose, dir, 0, held, seated).data)).toBe(f0);
        }
      }
    }
  });

  it("'cheer': fists raised overhead on both sides and, standing, frame 1 jump (feet lift)", () => {
    for (const dir of ['down', 'up'] as const) {
      const b = draw('cheer', dir, 0);
      expect(skinIn(b, 0, 5, 0, 12), dir).toBeGreaterThan(0);
      expect(skinIn(b, 19, CHAR_W, 0, 12), dir).toBeGreaterThan(0);
    }
    for (const dir of DIRS) {
      expect(opaqueIn(draw('cheer', dir, 0), CHAR_AX - 6, CHAR_AX + 6, CHAR_AY - 1, CHAR_AY), dir).toBeGreaterThan(2);
      expect(opaqueIn(draw('cheer', dir, 1), CHAR_AX - 6, CHAR_AX + 6, CHAR_AY - 1, CHAR_AY), dir).toBe(0);
    }
    // In profile, both arms raise (rear arm visible above/behind head).
    expect(skinIn(draw('cheer', 'left', 0), 0, 6, 0, 12)).toBeGreaterThan(0);
    expect(skinIn(draw('cheer', 'left', 0), 17, CHAR_W, 0, 12)).toBeGreaterThan(0);
  });

  it("'laugh': olhos de riso (sem pupila) e boca larga no quadro 0", () => {
    const pupil = '#1d1826';
    const open = '#7a2e35';
    expect(countColor(draw('stand', 'down', 0), pupil)).toBeGreaterThanOrEqual(2);
    for (const f of [0, 1]) expect(countColor(draw('laugh', 'down', f), pupil), `f${f}`).toBe(0);
    expect(countColor(draw('laugh', 'down', 0), open)).toBeGreaterThanOrEqual(4);
    expect(countColor(draw('laugh', 'left', 0), open)).toBeGreaterThanOrEqual(2);
  });

  it("'game': controller visible in front and profile; hidden by torso in rear view", () => {
    const red = '#e8545a';
    expect(countColor(draw('game', 'down', 0, 'controller'), red)).toBeGreaterThan(0);
    expect(countColor(draw('game', 'left', 0, 'controller'), red)).toBeGreaterThan(0);
    expect(countColor(draw('game', 'up', 0, 'controller'), red)).toBe(0);
    // Seated as well (on sofa before TV).
    expect(countColor(draw('game', 'down', 1, 'controller', true), red)).toBeGreaterThan(0);
  });

  it("'rps': rock, paper, and scissors differ across all directions; paper is largest hand", () => {
    for (const dir of DIRS) {
      const d = (['rock', 'paper', 'scissors'] as const).map((g) => digest(draw('rps', dir, 0, g).data));
      expect(new Set(d).size, dir).toBe(3);
      expect(d).not.toContain(digest(draw('rps', dir, 0).data));
    }
    expect(skinIn(draw('rps', 'left', 0, 'paper'), 0, 8, 12, 26)).toBeGreaterThan(skinIn(draw('rps', 'left', 0, 'rock'), 0, 8, 12, 26));
    // In rear view arm extends sideways: gesture appears to right of body.
    for (const g of ['rock', 'paper', 'scissors'] as const) expect(skinIn(draw('rps', 'up', 0, g), 20, CHAR_W, 10, 24), g).toBeGreaterThan(0);
    // Na contagem (sem gesto) o punho sobe acima do ombro no quadro 0 e desce no 1.
    expect(skinIn(draw('rps', 'down', 0), 17, CHAR_W, 8, 15)).toBeGreaterThan(skinIn(draw('rps', 'down', 1), 17, CHAR_W, 8, 15));
  });

  it("'groom': in rear view elbow lifts outward and hand rests beside head; lipstick and comb render", () => {
    expect(opaqueIn(draw('stand', 'up', 0), 20, CHAR_W, 8, 17)).toBe(0);
    expect(opaqueIn(draw('groom', 'up', 0), 20, CHAR_W, 8, 17)).toBeGreaterThan(0);
    expect(countColor(draw('groom', 'down', 0, 'lipstick'), '#d8365a')).toBeGreaterThan(0);
    expect(countColor(draw('groom', 'left', 0, 'lipstick'), '#d8365a')).toBeGreaterThan(0);
    expect(countColor(draw('groom', 'up', 0, 'comb'), '#3d4252')).toBeGreaterThan(0);
  });

  it("'sulk': head hangs lower than standing idle", () => {
    for (const dir of DIRS) {
      const top = (b: PixelBuf) => b.bounds()!.y;
      expect(top(draw('sulk', dir, 0)), dir).toBeGreaterThan(top(draw('stand', dir, 0)));
    }
  });

  it('smartphone with illuminated screen: reading standing and seated', () => {
    for (const [pose, seated] of [['read', false], ['read', true], ['sit', true]] as const) {
      expect(countColor(draw(pose, 'down', 0, 'phone', seated), '#6fbdf0'), `${pose}/${seated}`).toBeGreaterThan(0);
    }
  });
});

describe('furniture', () => {
  const kinds = Object.keys(FURNITURE) as FurnitureKind[];
  it('all kinds/variants/states render with coherent anchor and regions', () => {
    for (const kind of kinds) {
      const def = FURNITURE[kind];
      for (const v of def.variants ?? [undefined]) {
        for (let st = 0; st < (def.states ?? 1); st++) {
          const f = renderFurniture(kind, v, st);
          for (const s of [f.base, f.front]) {
            if (!s) continue;
            expect(s.buf.countOpaque(), `${kind}/${v}/${st}`).toBeGreaterThan(8);
            // Horizontal anchor within sprite; regions within buffer.
            expect(s.ax).toBeGreaterThanOrEqual(0);
            expect(s.ax).toBeLessThanOrEqual(s.buf.w);
            for (const r of Object.values(s.rects ?? {})) {
              if (!r) continue;
              expect(r.x).toBeGreaterThanOrEqual(0);
              expect(r.y).toBeGreaterThanOrEqual(0);
              expect(r.x + r.w).toBeLessThanOrEqual(s.buf.w);
              expect(r.y + r.h).toBeLessThanOrEqual(s.buf.h);
            }
          }
          if (def.mount === 'floor') {
            // Sprite does not extend below shadow baseline nor hover above footprint.
            for (const s of [f.base, f.front]) {
              if (!s) continue;
              expect(s.buf.h - s.ay, `${kind}/${v}`).toBeLessThanOrEqual(5);
              expect(s.ay - s.buf.h, `${kind}/${v}`).toBeLessThan(def.footprint.h * TILE);
            }
          } else {
            // Wall items sit above baseboard, within face (2 tiles).
            expect(f.base.ay).toBeGreaterThan(0);
            expect(f.base.ay - f.base.buf.h).toBeLessThanOrEqual(2 * TILE);
          }
        }
      }
    }
  });

  it('fills dynamic regions required by contract', () => {
    expect(renderFurniture('desk', 'wood').base.rects?.screen).toBeDefined();
    expect(renderFurniture('whiteboard').base.rects?.board).toBeDefined();
    expect(renderFurniture('window').base.rects?.glass).toBeDefined();
    expect(renderFurniture('clock').base.rects?.face).toBeDefined();
    expect(renderFurniture('tv').base.rects?.tv).toBeDefined();
    expect(renderFurniture('sign').base.rects?.sign).toBeDefined();
    expect(renderFurniture('painting').base.rects?.art).toBeDefined();
    expect(renderFurniture('floor_lamp').base.rects?.glow).toBeDefined();
    expect(renderFurniture('arcade').base.rects?.screen).toBeDefined();
    expect(renderFurniture('mirror').base.rects?.glass).toBeDefined();
    const scr = renderFurniture('desk', 'white').base.rects?.screen;
    expect(scr?.w).toBe(14);
    expect(scr?.h).toBe(9);
  });

  it('seats with backrest to south provide `front` sprite', () => {
    expect(renderFurniture('office_chair').front).toBeDefined();
    expect(renderFurniture('cafe_chair', 'up').front).toBeDefined();
    expect(renderFurniture('sofa', 'up').front).toBeDefined();
    expect(renderFurniture('toilet_stall', undefined, 1).front).toBeDefined();
    expect(renderFurniture('office_chair_front').front).toBeUndefined();
  });

  it('normalizes variants, states, and seeds', () => {
    expect(normalizeFurniture('desk', 'xyz').variant).toBe('wood');
    expect(normalizeFurniture('elevator', undefined, 99).state).toBe(4);
    expect(normalizeFurniture('elevator', undefined, -3).state).toBe(0);
    expect(normalizeFurniture('desk', 'wood', 0, 13).vseed).toBe(1);
    expect(normalizeFurniture('stool', undefined, 0, 13).vseed).toBe(0);
  });
});

describe('legibility of desks, sofa, and eyes', () => {
  /** Luminance (0–1) of buffer pixel (x, y), in furniture footprint coords. */
  function lumAt(s: { buf: { w: number; data: Uint8ClampedArray }; ax: number; ay: number }, fw: number, fh: number, fx: number, fy: number): number {
    const x = s.ax - (fw * TILE) / 2 + fx;
    const y = s.ay - fh * TILE + fy;
    const i = (y * s.buf.w + x) * 4;
    return (0.2126 * s.buf.data[i] + 0.7152 * s.buf.data[i + 1] + 0.0722 * s.buf.data[i + 2]) / 255;
  }

  it('monitor rear (desk_back) is light/medium plastic, never dark like screen', () => {
    for (const v of ['white', 'wood', 'dark']) {
      for (let seed = 0; seed < 4; seed++) {
        const f = renderFurniture('desk_back', v, 0, seed);
        // Monitor enclosure center (x 8..23 or 2..16 in variant 1; y -7..2).
        const cx = seed % 4 === 1 ? 6 : 13;
        const l = lumAt(f.base, 2, 1, cx, -4);
        expect(l, `${v}/${seed}`).toBeGreaterThan(v === 'dark' ? 0.45 : 0.7);
      }
    }
  });

  it('secondary display (monitor/laptop) comes enabled with content and is exposed in rects.screen2', () => {
    for (const seed of [1, 2, 4]) {
      const f = renderFurniture('desk', 'wood', 0, seed);
      const r = f.base.rects?.screen2;
      expect(r, `seed ${seed}`).toBeDefined();
      if (!r) continue;
      let sum = 0;
      const colors = new Set<number>();
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          const i = (y * f.base.buf.w + x) * 4;
          const d = f.base.buf.data;
          sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
          colors.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
        }
      }
      expect(sum / (r.w * r.h), `seed ${seed}`).toBeGreaterThan(0.13);
      expect(colors.size, `seed ${seed}`).toBeGreaterThan(2);
    }
    expect(renderFurniture('desk', 'wood', 0, 0).base.rects?.screen2).toBeUndefined();
  });

  it('keyboard and papers remain legible on white desk', () => {
    // Variant 0: keyboard at x 11..20, y -1..1 on white top.
    const f = renderFurniture('desk', 'white', 0, 0);
    const top = lumAt(f.base, 2, 1, 4, -3);
    const kb = lumAt(f.base, 2, 1, 15, 1);
    expect(top - kb).toBeGreaterThan(0.12);
  });

  it("sofa 'up' (rear view): continuous backrest, without front seat seams", () => {
    const f = renderFurniture('sofa', 'up');
    const front = f.front;
    expect(front).toBeDefined();
    if (!front) return;
    // Midline of back panel: solid color edge-to-edge (excluding borders).
    const row = new Set<number>();
    for (let fx = 2; fx <= 45; fx++) row.add(Math.round(lumAt(front, 3, 1, fx, 8) * 1000));
    expect(row.size).toBe(1);
    // Armrests protrude above backrest (reads as rear view).
    expect(lumAt(f.base, 3, 1, 2, -4)).toBeGreaterThan(0);
    expect(f.base.buf.alpha(f.base.ax - 24 + 2, f.base.ay - 16 - 4)).toBeGreaterThan(200);
  });

  it('eyes maintain contrast with skin across all tones (specular in dark skin)', () => {
    const base = appearanceFromSeed(11);
    for (const skin of ['#ffe2cc', '#d69f78', '#9a6444', '#7a4a31', '#5a3623']) {
      const a = { ...base, skin, hairStyle: 'buzz' as const, accessory: 'none' as const, eyes: '#4a2f22' };
      const s = renderCharacter({ appearance: a, dir: 'down', pose: 'stand', frame: 0 });
      const d = s.buf.data;
      const lum = (x: number, y: number) => {
        const i = (y * s.buf.w + x) * 4;
        return (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      };
      // Left eye: column 4 of head grid (x = 9), rows 10–11 (y = 13–14); adjacent skin (x = 8).
      const skinL = lum(8, 13);
      const contrast = Math.max(Math.abs(lum(9, 13) - skinL), Math.abs(lum(9, 14) - skinL));
      expect(contrast, skin).toBeGreaterThan(0.25);
    }
  });
});

describe('floors and walls', () => {
  const floors: FloorKind[] = ['carpet', 'wood', 'tile_check', 'tile_white', 'concrete', 'marble', 'grass', 'sidewalk', 'street'];
  it('floor tiles are opaque and deterministic', () => {
    for (const k of floors) {
      const a = floorChunk(k, 2, -1, { seed: 3, tint: '#c9d1dc', tint2: '#bdc6d3' });
      expect(a.countOpaque(), k).toBe(CHUNK_PX * CHUNK_PX);
      expect(floorChunk(k, 2, -1, { seed: 3, tint: '#c9d1dc', tint2: '#bdc6d3' }).data).toEqual(a.data);
    }
  }, 20_000);

  it('hardwood flows continuously across adjacent tiles (seamless borders)', () => {
    const left = floorChunk('wood', 0, 0, { seed: 1 });
    const right = floorChunk('wood', 1, 0, { seed: 1 });
    let differ = 0;
    for (let y = 0; y < CHUNK_PX; y++) {
      const i = (y * CHUNK_PX + CHUNK_PX - 1) * 4;
      const j = (y * CHUNK_PX) * 4;
      if (left.data[i] !== right.data[j]) differ++;
    }
    // Only genuine plank seams (few rows) may differ.
    expect(differ).toBeLessThan(CHUNK_PX / 3);
  });

  it('walls render all patterns', () => {
    const patterns: WallPattern[] = ['plain', 'stripes', 'tiles', 'wood_panel', 'brick', 'glass', 'marble'];
    for (const p of patterns) {
      const face = wallFaceTile({ base: '#eef1f4', trim: '#9fb0c4', pattern: p }, 1, 0);
      expect(face.w).toBe(TILE);
      expect(face.h).toBe(2 * TILE);
      expect(face.countOpaque()).toBeGreaterThan(TILE * 10);
      expect(southWallTile({ base: '#eef1f4', pattern: p, exterior: true }, 2).countOpaque()).toBe(TILE * TILE);
    }
  });
});

describe('icons and themes', () => {
  it('all 24 icons exist with outlines', () => {
    expect(ICON_NAMES.length).toBe(24);
    for (const n of ['hourglass', 'hourglass_flip', 'cobweb', 'storm', 'coin', 'sparkle', 'trophy', 'hand_rock', 'hand_paper', 'hand_scissors'] as const) {
      expect(ICON_NAMES).toContain(n);
    }
    for (const n of ICON_NAMES) {
      const s = renderIcon(n);
      expect(s.buf.w, n).toBeGreaterThanOrEqual(8);
      // Corner web is 12 px + outline; the rest fit in 13.
      expect(s.buf.w, n).toBeLessThanOrEqual(n === 'cobweb' ? 14 : 13);
      expect(s.buf.h, n).toBeLessThanOrEqual(14);
      expect(s.buf.countOpaque(), n).toBeGreaterThan(20);
      // Anchor at bottom-center.
      expect(s.ay).toBe(s.buf.h);
      expect(Math.abs(s.ax - s.buf.w / 2)).toBeLessThanOrEqual(1);
      // Templates contain only palette characters and uniform row widths.
      const def = iconTemplates()[n];
      for (const row of def.rows) {
        expect(row.length, n).toBe(def.rows[0].length);
        for (const ch of row) if (ch !== '.') expect(def.pal[ch], `${n} '${ch}'`).toBeDefined();
      }
    }
  });

  it('icons are deterministic', () => {
    for (const n of ICON_NAMES) expect(digest(renderIcon(n).buf.data), n).toBe(digest(renderIcon(n).buf.data));
  });

  it('hourglass: upright and tilted (alternating for spinning effect), identical sand and wood', () => {
    const up = renderIcon('hourglass');
    const flip = renderIcon('hourglass_flip');
    // Upright is taller than wide; tilted is wider than tall.
    expect(up.buf.h).toBeGreaterThan(up.buf.w);
    expect(flip.buf.w).toBeGreaterThan(flip.buf.h);
    const sand = '#f5c451';
    expect(countColor(up.buf, sand)).toBeGreaterThan(4);
    expect(countColor(flip.buf, sand)).toBeGreaterThan(4);
    // Sand at top (upper bulb) in upright version.
    const top = countColor(up.buf.crop(0, 0, up.buf.w, Math.floor(up.buf.h / 2)), sand);
    expect(top).toBeGreaterThan(countColor(up.buf, sand) / 2);
  });

  it('spiderweb: translucent outline (clean inner cells) and dark spider', () => {
    const s = renderIcon('cobweb');
    const d = s.buf.data;
    let soft = 0;
    let faint = 0;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] > 0 && d[i] < 200) soft++;
      if (d[i] > 0 && d[i] < 60) faint++;
    }
    expect(soft).toBeGreaterThan(20);
    expect(faint).toBeGreaterThan(5);
    expect(countColor(s.buf, '#3a3346')).toBeGreaterThan(2);
    expect(countColor(s.buf, '#ffffff')).toBeGreaterThan(30);
  });

  it('storm: dark cloud, blue droplets, and yellow lightning bolt', () => {
    const s = renderIcon('storm');
    expect(countColor(s.buf, '#ffd84d')).toBeGreaterThan(6);
    expect(countColor(s.buf, '#9fd2f6')).toBeGreaterThan(2);
    expect(countColor(s.buf, '#6b7489')).toBeGreaterThan(6);
  });

  it('adjacent themes are distinct and deterministic', () => {
    for (let i = 0; i < 30; i++) {
      expect(roomTheme(i)).toEqual(roomTheme(i));
      expect(roomTheme(i).carpet).not.toBe(roomTheme(i + 1).carpet);
      expect(roomTheme(i).accent).not.toBe(roomTheme(i + 1).accent);
    }
    expect(roomTheme(THEME_COUNT)).toEqual(roomTheme(0));
    expect(roomTheme(-1)).toEqual(roomTheme(THEME_COUNT - 1));
  });
});

describe('per-frame dynamic renders', () => {
  /** Mock context recording fillRect calls (only permitted calls). */
  function fakeCtx() {
    const rects: [number, number, number, number][] = [];
    const ctx = {
      fillStyle: '',
      fillRect(x: number, y: number, w: number, h: number) {
        rects.push([x, y, w, h]);
      },
    } as unknown as CanvasRenderingContext2D;
    return { ctx, rects };
  }
  const inside = (rects: [number, number, number, number][], r: { x: number; y: number; w: number; h: number }) =>
    rects.every(([x, y, w, h]) => x >= r.x && y >= r.y && x + w <= r.x + r.w && y + h <= r.y + r.h && w > 0 && h > 0);

  it('drawScreen stays within rectangle across all modes and dimensions', () => {
    const modes = SCREEN_MODES;
    for (const r of [{ x: 10, y: 20, w: 14, h: 9 }, { x: 3, y: 4, w: 28, h: 15 }, { x: 0, y: 0, w: 10, h: 7 }]) {
      for (const m of modes) {
        for (const t of [0, 777, 12345, 99999]) {
          const { ctx, rects } = fakeCtx();
          drawScreen(ctx, r, m, t, 5);
          expect(rects.length, m).toBeGreaterThan(0);
          expect(rects.length, m).toBeLessThan(200);
          expect(inside(rects, r), `${m} ${r.w}x${r.h} t=${t}`).toBe(true);
        }
      }
    }
  });

  it('drawScreen execution cost is independent of t (world supplies Date.now())', () => {
    // Regression: terminal mode traversed every line since t = 0 (~10^9 iterations per
    // monitor with t ≈ 1.8e12), freezing the entire app. Now each call is O(screen size).
    const modes = SCREEN_MODES;
    const r = { x: 10, y: 20, w: 14, h: 9 };
    const big = 1.8e12;
    const t0 = performance.now();
    for (const m of modes) {
      for (let k = 0; k < 40; k++) {
        const { ctx, rects } = fakeCtx();
        drawScreen(ctx, r, m, big + k * 997, k);
        expect(rects.length, m).toBeGreaterThan(0);
        expect(rects.length, m).toBeLessThan(200);
        expect(inside(rects, r), `${m} t=${big + k * 997}`).toBe(true);
      }
    }
    // 440 invocations: with the bug this took minutes; expected well below 1s even on slow CI.
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("screen 'off' is matte navy blue (not near-black) and 'standby' is blue with logo", () => {
    const fills: string[] = [];
    const ctx = {
      fillStyle: '',
      fillRect() {
        fills.push(String((ctx as { fillStyle: string }).fillStyle));
      },
    };
    const lum = (hex: string) => {
      const n = parseInt(hex.slice(1, 7), 16);
      return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
    };
    drawScreen(ctx as unknown as CanvasRenderingContext2D, { x: 0, y: 0, w: 14, h: 9 }, 'off', 0, 1);
    expect(lum(fills[0])).toBeGreaterThan(0.15);
    expect(new Set(fills).size).toBeGreaterThan(2); // fundo + reflexos
    fills.length = 0;
    drawScreen(ctx as unknown as CanvasRenderingContext2D, { x: 0, y: 0, w: 14, h: 9 }, 'standby', 0, 1);
    expect(Math.max(...fills.map(lum))).toBeGreaterThan(0.6); // logo claro
  });

  it('terminal: current line advances over time typing progressively', () => {
    const r = { x: 0, y: 0, w: 14, h: 9 };
    const snap = (t: number) => {
      const { ctx, rects } = fakeCtx();
      drawScreen(ctx, r, 'terminal', t, 3);
      return JSON.stringify(rects);
    };
    // Deterministic and animated (frame changes across seconds), even with huge t.
    for (const base of [0, 1.8e12]) {
      expect(snap(base + 5000)).toBe(snap(base + 5000));
      const frames = new Set([0, 1300, 2600, 3900, 5200, 6500].map((d) => snap(base + d)));
      expect(frames.size).toBeGreaterThan(3);
    }
  });

  it("screen 'progress': bar fills over time, spinner rotates, and loops (deterministic)", () => {
    const r = { x: 0, y: 0, w: 14, h: 9 };
    /** Largura da parte cheia da barra (cores do enchimento) num instante. */
    const snap = (t: number, seed = 2) => {
      const fills: { c: string; x: number; y: number; w: number; h: number }[] = [];
      const ctx = {
        fillStyle: '',
        fillRect(x: number, y: number, w: number, h: number) {
          fills.push({ c: String((ctx as { fillStyle: string }).fillStyle), x, y, w, h });
        },
      };
      drawScreen(ctx as unknown as CanvasRenderingContext2D, r, 'progress', t, seed);
      return fills;
    };
    const filled = (t: number) => Math.max(0, ...snap(t).filter((f) => f.c === '#3ccf63' || f.c === '#b9ffca').map((f) => f.w));
    for (const base of [0, 1.8e12]) {
      expect(JSON.stringify(snap(base + 1234))).toBe(JSON.stringify(snap(base + 1234)));
      // Throughout a cycle (~3.4–4.6 s) the bar grows and then returns to zero.
      const widths = Array.from({ length: 48 }, (_, k) => filled(base + k * 100));
      expect(Math.max(...widths)).toBeGreaterThanOrEqual(r.w - 4);
      expect(Math.min(...widths)).toBeLessThanOrEqual(1);
      let grows = 0;
      for (let k = 1; k < widths.length; k++) if (widths[k] > widths[k - 1]) grows++;
      expect(grows).toBeGreaterThan(4);
    }
    // Spinner: highlighted head advances between adjacent frames.
    const head = (t: number) => JSON.stringify(snap(t).filter((f) => f.c === '#9ff3ff'));
    expect(head(0)).not.toBe(head(110));
    // Dark like a terminal (background is 1st fill covering full screen).
    const bg = snap(0)[0];
    expect(bg).toMatchObject({ x: 0, y: 0, w: 14, h: 9 });
  });

  it("'show' and 'game': fixed program by seed (soccer/drama/cartoon; racing/fighting)", () => {
    const r = { x: 3, y: 4, w: 28, h: 15 };
    const colors = (m: ScreenMode, seed: number, t = 1234) => {
      const fills: string[] = [];
      const ctx = {
        fillStyle: '',
        fillRect() {
          fills.push(String((ctx as { fillStyle: string }).fillStyle));
        },
      } as unknown as CanvasRenderingContext2D;
      drawScreen(ctx, r, m, t, seed);
      return fills;
    };
    for (const k of [0, 3, 6]) {
      expect(colors('show', k), `futebol ${k}`).toContain('#3f9a4a');
      expect(colors('show', k + 1), `novela ${k + 1}`).not.toContain('#3f9a4a');
      expect(colors('show', k + 1), `novela ${k + 1}`).not.toContain('#7fd3ff');
      expect(colors('show', k + 2), `desenho ${k + 2}`).toContain('#7fd3ff');
    }
    for (const k of [0, 2, 4]) {
      expect(colors('game', k), `corrida ${k}`).toContain('#6a7280');
      expect(colors('game', k + 1), `luta ${k + 1}`).toContain('#3b2a6b');
    }
    // "GOAL" (dark band + letters) appears at end of each play; "KO", at end of round.
    const banner = 'rgba(12,16,28,0.78)';
    const some = (m: ScreenMode, seed: number, span: number) => {
      for (let t = 0; t < span; t += 50) if (colors(m, seed, t).includes(banner)) return true;
      return false;
    };
    expect(some('show', 0, 7000)).toBe(true);
    expect(some('game', 1, 9000)).toBe(true);
    expect(some('show', 1, 7000)).toBe(false);
  });

  it('drawWindowView, drawBoard, and drawClock stay within bounds', () => {
    const r = { x: 4, y: 6, w: 24, h: 15 };
    for (const hour of [0, 3, 5.8, 7, 12, 17.5, 18.4, 19.6, 22, 23.99]) {
      for (const t of [0, 5000, 60000]) {
        const { ctx, rects } = fakeCtx();
        drawWindowView(ctx, r, hour, t, 9);
        expect(inside(rects, r), `hora ${hour}`).toBe(true);
      }
    }
    const board = { x: 2, y: 2, w: 40, h: 15 };
    const { ctx, rects } = fakeCtx();
    drawBoard(ctx, board, Array.from({ length: 30 }, (_, i) => ({ status: (['pending', 'in_progress', 'completed'] as const)[i % 3] })), 1000);
    expect(inside(rects, board)).toBe(true);
    const face = { x: 3, y: 3, w: 10, h: 10 };
    const c = fakeCtx();
    for (let h = 0; h < 24; h++) drawClock(c.ctx, face, new Date(2026, 0, 1, h, h * 2, h));
    expect(inside(c.rects, face)).toBe(true);
  });
});

// Divergence between shared/appearance (server contract) and art unions: fails on typecheck.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const STYLE_LISTS_MATCH: [
  Same<(typeof HAIR_STYLES)[number], HairStyle>,
  Same<(typeof TOP_STYLES)[number], TopStyle>,
  Same<(typeof ACCESSORIES)[number], Accessory>,
  Same<(typeof FACIAL_HAIR)[number], NonNullable<Appearance['facialHair']>>,
  Same<(typeof BOTTOM_STYLES)[number], NonNullable<Appearance['bottomStyle']>>,
] = [true, true, true, true, true];

describe('character editor (art)', () => {
  it('style lists from shared/appearance match art unions', () => {
    expect(STYLE_LISTS_MATCH.every(Boolean)).toBe(true);
  });

  it('parts overrides only specified pieces, keeping generator defaults for remainder', () => {
    const base = appearanceFromSeed(5, { look: 'f' });
    expect(appearanceFromSeed(5, { look: 'f', parts: { hairStyle: 'mohawk', skin: '#5a3623' } })).toEqual({ ...base, hairStyle: 'mohawk', skin: '#5a3623' });
    expect(appearanceFromSeed(5, { look: 'f', parts: {} })).toEqual(base);
    // Explicit undefined does not erase generated piece.
    expect(appearanceFromSeed(5, { look: 'f', parts: { hairStyle: undefined, skin: undefined } })).toEqual(base);
  });

  it('every generated appearance uses values provided by editor (palettes and styles)', () => {
    for (let i = 0; i < 300; i++) {
      for (const look of ['f', 'm'] as const) {
        const a = appearanceFromSeed(i, { look });
        const o = editorOptions(a);
        for (const k of PART_KEYS) expect(o[k], `${k} da seed ${i} (${look})`).toContain(a[k]);
      }
    }
  });

  it('top and accessory color palettes depend on style', () => {
    const a = appearanceFromSeed(1);
    const shirt = editorOptions({ ...a, topStyle: 'shirt_tie' });
    expect(shirt.top).toContain('#f4f4f0');
    expect(shirt.top).not.toContain('#e2604f');
    expect(shirt.topAccent).toContain('#c0392b');
    expect(editorOptions({ ...a, topStyle: 'jacket' }).top).toContain('#2f3b55');
    expect(editorOptions({ ...a, accessory: 'sunglasses' }).accessoryColor).toEqual(['#22232b']);
    expect(editorOptions(a).eyes.length).toBe(new Set(editorOptions(a).eyes).size);
  });

  it('combinations avoided by generator are disabled bidirectionally', () => {
    const a = appearanceFromSeed(1);
    expect(editorConflict({ ...a, hairStyle: 'afro' }, 'accessory', 'cap')).toMatch(/cabelo/);
    expect(editorConflict({ ...a, hairStyle: 'afro' }, 'accessory', 'glasses')).toBeUndefined();
    expect(editorConflict({ ...a, hairStyle: 'buzz' }, 'accessory', 'bow')).toMatch(/cabelo/);
    expect(editorConflict({ ...a, accessory: 'beanie' }, 'hairStyle', 'mohawk')).toMatch(/gorro/);
    expect(editorConflict({ ...a, accessory: 'bow' }, 'hairStyle', 'bald')).toMatch(/laço/);
    expect(editorConflict({ ...a, accessory: 'none' }, 'hairStyle', 'bald')).toBeUndefined();
  });

  it('fitToOptions: after style change, invalid color falls back to palette first', () => {
    const a = { ...appearanceFromSeed(1), topStyle: 'shirt_tie' as const, top: '#e2604f', topAccent: '#e2604f' };
    expect(fitToOptions(a)).toMatchObject({ top: '#f4f4f0', topAccent: '#c0392b' });
    const ok = { ...appearanceFromSeed(1), topStyle: 'tshirt' as const, top: '#e2604f' };
    expect(fitToOptions(ok).top).toBe('#e2604f');
    expect(fitToOptions({ ...ok, accessory: 'sunglasses', accessoryColor: '#e2604f' }).accessoryColor).toBe('#22232b');
  });
});
