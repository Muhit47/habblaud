// Deterministic appearance generation from seed (pure, no DOM). Generator and palettes originally lived here and
// moved to shared/world/appearance-flat.ts (same generator serves office and Habblaud World); this module
// re-exports and holds editor-specific character state.
import { ACCESSORIES, BOTTOM_STYLES, FACIAL_HAIR, HAIR_STYLES, TOP_STYLES, type PartKey } from '../../../../shared/appearance';
import {
  ACC_COLORS,
  BOTTOMS,
  EYES,
  HAIR_FUN,
  HAIR_NATURAL,
  JACKET_COLORS,
  LIGHT_ACCENTS,
  SHIRT_COLORS,
  SHOES,
  SKINS,
  TIE_COLORS,
  TOP_COLORS,
  type SeedAppearance,
} from '../../../../shared/world/appearance-flat';
import type { Appearance, TopStyle } from '../api';
import { tr } from '../../../../shared/i18n';

export { appearanceFromSeed, SKINS } from '../../../../shared/world/appearance-flat';
export type { BottomStyle, FacialHair } from '../../../../shared/world/appearance-flat';

// The schemas of shared/world/appearance-flat.ts and art (art/api.ts) must remain aligned.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _sameAppearance: Same<SeedAppearance, Appearance> = true;
void _sameAppearance;

/** Stable cache key of an appearance (for sprite caching). */
export function appearanceKey(a: Appearance): string {
  return [
    a.skin, a.hair, a.hairStyle, a.eyes, a.top, a.topAccent, a.topStyle, a.bottom, a.shoes, a.accessory,
    a.accessoryColor, a.lanyard ?? '-', a.look, a.facialHair ?? '-', a.bottomStyle ?? '-',
  ].join('|');
}

// ------------------------------------------------------------------ character editor

const uniq = (list: readonly string[]): readonly string[] => [...new Set(list)];
const colorsOf = (pairs: readonly (readonly [string, number])[]): string[] => pairs.map(([c]) => c);
const ACCENTS = uniq([...LIGHT_ACCENTS, ...TOP_COLORS]);

/** Upper body and accent colors for each style: matches appearance pool. */
function topPalettes(style: TopStyle): { top: readonly string[]; topAccent: readonly string[] } {
  switch (style) {
    case 'shirt_tie':
      return { top: SHIRT_COLORS, topAccent: TIE_COLORS };
    case 'jacket':
      return { top: JACKET_COLORS, topAccent: ACCENTS };
    default:
      return { top: TOP_COLORS, topAccent: ACCENTS };
  }
}

export type EditorOptions = Readonly<Record<PartKey, readonly string[]>>;

/** Piece options in character editor based on current appearance (clothing palette depends on style). */
export function editorOptions(a: Appearance): EditorOptions {
  const top = topPalettes(a.topStyle);
  return {
    skin: SKINS,
    hair: [...colorsOf(HAIR_NATURAL), ...HAIR_FUN],
    hairStyle: HAIR_STYLES,
    eyes: uniq(EYES),
    top: top.top,
    topAccent: top.topAccent,
    topStyle: TOP_STYLES,
    bottom: colorsOf(BOTTOMS),
    bottomStyle: BOTTOM_STYLES,
    shoes: colorsOf(SHOES),
    accessory: ACCESSORIES,
    accessoryColor: ACC_COLORS[a.accessory],
    facialHair: FACIAL_HAIR,
  };
}

const TALL_HAIR: readonly string[] = ['afro', 'bun', 'mohawk', 'pigtails'];
const SHORT_HAIR: readonly string[] = ['bald', 'buzz'];

/** Combination avoided by generator (editor disables option): returns reason, or undefined if permitted. */
export function editorConflict(a: Appearance, key: PartKey, value: string): string | undefined {
  if (key === 'accessory') {
    if ((value === 'cap' || value === 'beanie') && TALL_HAIR.includes(a.hairStyle)) return tr('Não combina com este cabelo');
    if (value === 'bow' && SHORT_HAIR.includes(a.hairStyle)) return tr('Não combina com este cabelo');
  }
  if (key === 'hairStyle') {
    if ((a.accessory === 'cap' || a.accessory === 'beanie') && TALL_HAIR.includes(value)) return tr('Não combina com o boné ou o gorro');
    if (a.accessory === 'bow' && SHORT_HAIR.includes(value)) return tr('Não combina com o laço');
  }
  return undefined;
}

/** After changing style: colors absent from new palette fall back to its first color. */
export function fitToOptions(a: Appearance): Appearance {
  const o = editorOptions(a);
  const fit = (v: string, list: readonly string[]): string => (list.includes(v) ? v : list[0]);
  return { ...a, top: fit(a.top, o.top), topAccent: fit(a.topAccent, o.topAccent), accessoryColor: fit(a.accessoryColor, o.accessoryColor) };
}
