// Personality traits: identical for office characters (client/src/world/social/persona.ts, which draws
// 2 or 3 per seed) and for Habblaud World player (who chooses 2 or 3). IDs and clashing pairs
// come from protocol; here are labels (tr) and validation of player choice. Pure: no Node or DOM.
//
// Labels are nouns ("Competition", "Vanity"): independent of anyone's gender.
import { tr } from '../i18n';
import { PLAYER_TRAITS, TRAIT_CLASHES, TRAIT_IDS, type TraitId } from './protocol';

export { TRAIT_CLASHES, TRAIT_IDS, type TraitId };

export interface Trait {
  id: TraitId;
  emoji: string;
  label: string;
  /** A sentence describing the effect in the office (tooltip hint in UI). */
  desc: string;
}

/** In TRAIT_IDS order (verified by test: personaFor draw depends on it). */
export const TRAITS: Readonly<Record<TraitId, Trait>> = {
  competicao: { id: 'competicao', emoji: '🏆', label: tr('Competição'), desc: tr('Adora competir: desafia os colegas no ping-pong, no videogame e no jokenpô.') },
  apostas: { id: 'apostas', emoji: '🎲', label: tr('Apostas'), desc: tr('Topa qualquer aposta e aposta alto no jokenpô.') },
  games: { id: 'games', emoji: '🎮', label: tr('Games'), desc: tr('Vive no videogame do lounge e nos fliperamas — e costuma ganhar.') },
  series: { id: 'series', emoji: '📺', label: tr('Séries e TV'), desc: tr('Não perde um programa na TV do lounge (de preferência com pipoca).') },
  fofoca: { id: 'fofoca', emoji: '🗣️', label: tr('Fofoca'), desc: tr('Puxa papo na copa e sabe de tudo o que acontece nas salas.') },
  vaidade: { id: 'vaidade', emoji: '💄', label: tr('Vaidade'), desc: tr('Passa no espelho do banheiro para se arrumar sempre que pode.') },
  cafeina: { id: 'cafeina', emoji: '☕', label: tr('Cafeína'), desc: tr('Movido a café: a cafeteira da copa é a segunda casa.') },
  piadas: { id: 'piadas', emoji: '😂', label: tr('Piadas'), desc: tr('Conta piada em toda conversa e faz a roda rir.') },
  esporte: { id: 'esporte', emoji: '🏓', label: tr('Esporte'), desc: tr('Joga ping-pong, se alonga e vibra com o futebol na TV.') },
  timidez: { id: 'timidez', emoji: '🙈', label: tr('Timidez'), desc: tr('Prefere ficar na sua: lê, olha a janela e entra menos nas rodas.') },
  economia: { id: 'economia', emoji: '💰', label: tr('Economia'), desc: tr('Pão-duro: aposta pouco e às vezes foge da aposta.') },
  sonecas: { id: 'sonecas', emoji: '😴', label: tr('Sonecas'), desc: tr('Qualquer sofá ou puff vira cama.') },
  calma: { id: 'calma', emoji: '🧘', label: tr('Calma'), desc: tr('Zen: alongamentos, janela e conversas tranquilas.') },
  leitura: { id: 'leitura', emoji: '📚', label: tr('Leitura'), desc: tr('Sempre com um livro da estante (ou o celular) na mão.') },
};

export function isTraitId(v: unknown): v is TraitId {
  return typeof v === 'string' && (TRAIT_IDS as readonly string[]).includes(v);
}

/** The two traits clash on the same person (TRAIT_CLASHES, bidirectionally). */
export function traitsClash(a: TraitId, b: TraitId): boolean {
  return TRAIT_CLASHES.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

/**
 * Traits chosen by player: 2 or 3 known IDs, unique, without any clashing pair. Returns list (in
 * received order) or null.
 */
export function parsePlayerTraits(raw: unknown): TraitId[] | null {
  if (!Array.isArray(raw) || raw.length < PLAYER_TRAITS.min || raw.length > PLAYER_TRAITS.max) return null;
  const out: TraitId[] = [];
  for (const t of raw) {
    if (!isTraitId(t) || out.includes(t) || out.some((o) => traitsClash(o, t))) return null;
    out.push(t);
  }
  return out;
}
