// Character editor, pure part (DOM-free): when the drawer offers editing, how parts are grouped, labels,
// and what gets sent to the server in `parts`. The UI lives in character-editor.ts.
import { PART_KEYS, type AppearanceParts, type PartKey } from '../../../shared/appearance';
import { isDemoId } from '../../../shared/timeline';
import type { AgentInfo } from '../../../shared/types';
import type { Appearance } from '../art/api';
import { tr } from '../../../shared/i18n';

export interface EditGate {
  /** The agent is still in the office. */
  live: boolean;
  /** meta.terminal: Habblaud is only accessible from this computer (local bind). */
  terminal: boolean;
  /** Page opened from localhost/127.x (server rejects the rest). */
  local: boolean;
  replaying: boolean;
  mock: boolean;
}

/**
 * Does the "Edit character" pencil appear? Only for a real, live main agent that is not leaving
 * (offline: server would respond 404) and with local access (terminal lock).
 */
export function canEditCharacter(a: Pick<AgentInfo, 'id' | 'kind' | 'status'>, g: EditGate): boolean {
  return a.kind === 'main' && a.status !== 'offline' && g.live && g.terminal && g.local && !g.replaying && !g.mock && !isDemoId(a.id);
}

/** Parts that differ from appearance generated from seed (what goes into `parts`), in PART_KEYS order. */
export function changedParts(base: Appearance, edited: Appearance): AppearanceParts {
  const out: Record<string, string> = {};
  for (const k of PART_KEYS) {
    const v = edited[k];
    if (v !== undefined && v !== base[k]) out[k] = v;
  }
  return out as AppearanceParts;
}

export interface EditorRow {
  key: PartKey;
  label: string;
  kind: 'style' | 'color';
}

export const EDITOR_GROUPS: readonly { title: string; rows: readonly EditorRow[] }[] = [
  { title: tr('Pele'), rows: [{ key: 'skin', label: tr('Tom'), kind: 'color' }] },
  {
    title: tr('Cabelo'),
    rows: [
      { key: 'hairStyle', label: tr('Estilo'), kind: 'style' },
      { key: 'hair', label: tr('Cor'), kind: 'color' },
    ],
  },
  { title: tr('Barba'), rows: [{ key: 'facialHair', label: tr('Estilo'), kind: 'style' }] },
  { title: tr('Olhos'), rows: [{ key: 'eyes', label: tr('Cor'), kind: 'color' }] },
  {
    title: tr('Parte de cima'),
    rows: [
      { key: 'topStyle', label: tr('Estilo'), kind: 'style' },
      { key: 'top', label: tr('Cor'), kind: 'color' },
      { key: 'topAccent', label: tr('Detalhe'), kind: 'color' },
    ],
  },
  {
    title: tr('Parte de baixo'),
    rows: [
      { key: 'bottomStyle', label: tr('Estilo'), kind: 'style' },
      { key: 'bottom', label: tr('Cor'), kind: 'color' },
    ],
  },
  { title: tr('Sapatos'), rows: [{ key: 'shoes', label: tr('Cor'), kind: 'color' }] },
  {
    title: tr('Acessório'),
    rows: [
      { key: 'accessory', label: tr('Tipo'), kind: 'style' },
      { key: 'accessoryColor', label: tr('Cor'), kind: 'color' },
    ],
  },
];

const STYLE_LABELS: Partial<Record<PartKey, Readonly<Record<string, string>>>> = {
  hairStyle: {
    short: tr('Curto'), buzz: tr('Raspado'), spiky: tr('Espetado'), side_part: tr('Repartido'), curly: tr('Cacheado'), afro: tr('Black power'),
    bob: tr('Chanel'), long: tr('Longo'), ponytail: tr('Rabo de cavalo'), bun: tr('Coque'), pigtails: 'Maria-chiquinha', mohawk: tr('Moicano'),
    bald: tr('Careca'), wavy: tr('Ondulado'),
  },
  topStyle: {
    tshirt: tr('Camiseta'), hoodie: tr('Moletom'), shirt_tie: tr('Camisa e gravata'), sweater: tr('Suéter'), jacket: tr('Jaqueta'),
    blouse: tr('Blusa'), polo: 'Polo',
  },
  bottomStyle: { pants: tr('Calça'), shorts: tr('Bermuda'), skirt: tr('Saia') },
  accessory: {
    none: tr('Nenhum'), glasses: tr('Óculos'), sunglasses: tr('Óculos escuros'), headphones: tr('Fone'), cap: tr('Boné'), beanie: tr('Gorro'),
    earrings: tr('Brincos'), bow: tr('Laço'),
  },
  facialHair: { none: tr('Sem barba'), stubble: tr('Por fazer'), beard: tr('Barba'), mustache: tr('Bigode'), goatee: tr('Cavanhaque') },
};

/** Display label for a style category (hair, clothing, accessory...). */
export function styleLabel(key: PartKey, value: string): string {
  return STYLE_LABELS[key]?.[value] ?? value;
}

/** Is row visible for this appearance? (e.g. without accessory, accessory color is hidden) */
export function rowVisible(r: EditorRow, a: Pick<Appearance, 'accessory'>): boolean {
  return !(r.key === 'accessoryColor' && a.accessory === 'none');
}
