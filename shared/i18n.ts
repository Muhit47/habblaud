// Interface languages. Portuguese (pt-BR) remains the source language: each text is written in PT
// and passed through tr(), which returns the active language translation or, if missing, the original PT text.
// Thus nothing changes for users in Portuguese, and an incomplete translation never breaks the interface.
//
// Language selection (once, upon loading this module):
// - browser: saved preference (Settings > Language), otherwise browser languages;
// - server: HABBLAUD_LANG, otherwise system language (LC_ALL / LC_MESSAGES / LANG / Intl), excluding English (see
//   serverLocale).
// Activity texts are composed by the server, so they follow the server language.
import { DICTIONARIES } from './locales/all';

export type Locale = 'pt-BR' | 'en' | 'es' | 'fr';

/** In selector order; each language name is in its native language for users who do not understand current language. */
export const LOCALES: { id: Locale; name: string }[] = [
  { id: 'pt-BR', name: 'Português' },
  { id: 'en', name: 'English' },
  { id: 'es', name: 'Español' },
  { id: 'fr', name: 'Français' },
];

/** Saved preference key in browser. */
export const LOCALE_STORAGE_KEY = 'habblaud:locale';

/** Available dictionaries (PT has none: it is the source language). Starts empty in browser: see registerDictionary. */
const DICTS: Partial<Record<Locale, Readonly<Record<string, string>>>> = { ...DICTIONARIES };

/** Browser loads only the active language dictionary and registers it here before building the UI. */
export function registerDictionary(l: Locale, dict: Readonly<Record<string, string>>): void {
  DICTS[l] = dict;
}

/** "fr-FR", "fr_CA.UTF-8", "pt", "pt_BR"... -> supported locale; undefined if none. */
export function normalizeLocale(v: string | null | undefined): Locale | undefined {
  const s = (v ?? '').trim().toLowerCase().replace('_', '-');
  if (!s) return undefined;
  if (s === 'fr' || s.startsWith('fr-')) return 'fr';
  if (s === 'pt' || s.startsWith('pt-')) return 'pt-BR';
  if (s === 'en' || s.startsWith('en-')) return 'en';
  if (s === 'es' || s.startsWith('es-')) return 'es';
  return undefined;
}

/**
 * Server locale (activities, notices, logs). HABBLAUD_LANG applies to any language. From system (LC_ALL,
 * LC_MESSAGES, LANG and lastly Intl) French, Spanish, or Portuguese apply, but not English: many machines and
 * containers default to English (en_US, or Node en-US without LANG), even for users of another language, and
 * the office would change language automatically. For server in English: HABBLAUD_LANG=en.
 */
export function serverLocale(env: Record<string, string | undefined>, intl?: string): Locale {
  const own = normalizeLocale(env.HABBLAUD_LANG);
  if (own) return own;
  for (const v of [env.LC_ALL, env.LC_MESSAGES, env.LANG, intl]) {
    const n = normalizeLocale(v);
    if (n && n !== 'en') return n;
  }
  return 'pt-BR';
}

function detect(): Locale {
  const g = globalThis as {
    window?: unknown;
    localStorage?: { getItem(k: string): string | null };
    navigator?: { languages?: readonly string[]; language?: string };
    process?: { env?: Record<string, string | undefined> };
  };
  if (g.window !== undefined) {
    try {
      const saved = normalizeLocale(g.localStorage?.getItem(LOCALE_STORAGE_KEY));
      if (saved) return saved;
    } catch {
      // localStorage blocked (private mode, iframe): fall back to browser languages.
    }
    for (const l of g.navigator?.languages ?? [g.navigator?.language ?? '']) {
      const n = normalizeLocale(l);
      if (n) return n;
    }
    return 'en';
  }
  const env = g.process?.env ?? {};
  // Tests compare texts in PT: remain in PT even on machines set to another language.
  if (env.VITEST) return normalizeLocale(env.HABBLAUD_LANG_TEST) ?? 'pt-BR';
  let intl: string | undefined;
  try {
    intl = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    intl = undefined;
  }
  return serverLocale(env, intl);
}

let current: Locale = detect();

export function getLocale(): Locale {
  return current;
}

/** Switches active locale (tests; in browser, switching via UI reloads page). */
export function setLocale(l: Locale): void {
  current = l;
}

/**
 * Translates text written in PT. Numbered placeholders ({0}, {1}...) receive `args` in order; translation may
 * reorder them. Without translation for active locale, returns original text.
 */
export function tr(src: string, args?: readonly unknown[]): string {
  const dict = DICTS[current];
  const s = (dict && dict[src]) || src;
  if (!args || args.length === 0) return s;
  return s.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m));
}

/** Locale in Intl format (dates, numbers). */
export function intlLocale(): string {
  return current === 'fr' ? 'fr-FR' : current === 'en' ? 'en-US' : current === 'es' ? 'es' : 'pt-BR';
}
