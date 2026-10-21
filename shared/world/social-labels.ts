// Labels for lightweight social features in Habblaud World (Phase 5): greetings, reception stamps, report reasons,
// and city goals. Protocol carries only ID; text (and icon) are produced here, in viewer's language, like intro.ts and traits.ts.
// Pure: no Node or DOM.
import { intlLocale, tr } from '../i18n';
import {
  CITY_GOAL_IDS,
  GREETING_IDS,
  REPORT_REASONS,
  STAMP_IDS,
  type CityGoalId,
  type GreetingId,
  type ReportReason,
  type StampId,
  type TokenBand,
} from './protocol';

export { CITY_GOAL_IDS, GREETING_IDS, REPORT_REASONS, STAMP_IDS };
export type { CityGoalId, GreetingId, ReportReason, StampId };

/** An ID with icon (emoji) and text in active language. */
export interface SocialLabel {
  icon: string;
  label: () => string;
}

/** 10 greetings, in wheel order (Record enforces all IDs present). */
export const GREETINGS: Readonly<Record<GreetingId, SocialLabel>> = {
  hello: { icon: '👋', label: () => tr('Olá!') },
  nice_building: { icon: '👍', label: () => tr('Prédio bonito!') },
  coffee: { icon: '☕', label: () => tr('Bora um café?') },
  congrats: { icon: '🎉', label: () => tr('Parabéns pela entrega!') },
  nice_to_meet: { icon: '🤝', label: () => tr('Prazer!') },
  bye: { icon: '✌️', label: () => tr('Até mais!') },
  thanks: { icon: '🙏', label: () => tr('Valeu!') },
  good_luck: { icon: '🍀', label: () => tr('Boa sorte!') },
  wave: { icon: '🙋', label: () => tr('Oi, oi!') },
  clap: { icon: '👏', label: () => tr('Mandou bem!') },
};

/** 8 reception stamps. */
export const STAMPS: Readonly<Record<StampId, SocialLabel>> = {
  visited: { icon: '👣', label: () => tr('Passei por aqui') },
  nice_building: { icon: '🏢', label: () => tr('Prédio lindo') },
  keep_going: { icon: '💪', label: () => tr('Continue assim') },
  coffee: { icon: '☕', label: () => tr('Fica o café') },
  wave: { icon: '👋', label: () => tr('Um aceno') },
  star: { icon: '⭐', label: () => tr('Nota 10') },
  heart: { icon: '💖', label: () => tr('Com carinho') },
  rocket: { icon: '🚀', label: () => tr('Decolando!') },
};

/** Fixed report reasons. */
export const REPORTS: Readonly<Record<ReportReason, SocialLabel>> = {
  offensive_name: { icon: '🤬', label: () => tr('Nome ofensivo') },
  impersonation: { icon: '🎭', label: () => tr('Fingindo ser outra pessoa') },
  harassment: { icon: '🚫', label: () => tr('Perseguição') },
  greeting_spam: { icon: '📢', label: () => tr('Spam de cumprimentos') },
  fake_building: { icon: '🏚️', label: () => tr('Prédio falso') },
  other: { icon: '❔', label: () => tr('Outro motivo') },
};

/** Agent hours for each city goal (server sends `target` as well; this is label only). */
export const CITY_GOAL_HOURS: Readonly<Record<CityGoalId, number>> = {
  agent_hours_10k: 10_000,
  agent_hours_50k: 50_000,
  agent_hours_100k: 100_000,
};

const ofList = <K extends string>(list: Readonly<Record<K, SocialLabel>>, id: string): SocialLabel | undefined =>
  (Object.prototype.hasOwnProperty.call(list, id) ? list[id as K] : undefined);

/** Greeting text (unknown ID from newer version falls back to ID itself, without throwing). */
export function greetingLabel(id: GreetingId | string): string {
  return ofList(GREETINGS, id)?.label() ?? String(id);
}

export function greetingIcon(id: GreetingId | string): string {
  return ofList(GREETINGS, id)?.icon ?? '💬';
}

export function stampLabel(id: StampId | string): string {
  return ofList(STAMPS, id)?.label() ?? String(id);
}

export function stampIcon(id: StampId | string): string {
  return ofList(STAMPS, id)?.icon ?? '🏷️';
}

export function reportLabel(id: ReportReason | string): string {
  return ofList(REPORTS, id)?.label() ?? String(id);
}

/** Compact number in active language ("10k", "1.2k", "50k"). */
export function compactNumber(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, n) : 0;
  try {
    return new Intl.NumberFormat(intlLocale(), { notation: 'compact', maximumFractionDigits: v < 10_000 && v >= 1_000 ? 1 : 0 }).format(v);
  } catch {
    return String(Math.round(v));
  }
}

/** "10k hours of agents working" (weekly goal). */
export function cityGoalLabel(id: CityGoalId | string, target?: number): string {
  const hours = target ?? (Object.prototype.hasOwnProperty.call(CITY_GOAL_HOURS, id) ? CITY_GOAL_HOURS[id as CityGoalId] : 0);
  return tr('{0} horas de agentes trabalhando', [compactNumber(hours)]);
}

/** Token band (TokenBand) as human-readable ceiling: "up to 100k", "up to 1M"... "over 100M". */
export function tokenBandText(band: TokenBand | number | undefined): string {
  switch (band) {
    case 1:
      return tr('até 100 mil tokens');
    case 2:
      return tr('até 1 milhão de tokens');
    case 3:
      return tr('até 10 milhões de tokens');
    case 4:
      return tr('até 100 milhões de tokens');
    case 5:
      return tr('mais de 100 milhões de tokens');
    default:
      return tr('quase nada de tokens');
  }
}
