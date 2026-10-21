import { afterEach, describe, expect, it } from 'vitest';
import { getLocale, intlLocale, normalizeLocale, serverLocale, setLocale, tr } from './i18n';
import { EN } from './locales/en';
import { ES } from './locales/es';
import { FR } from './locales/fr';

const placeholders = (s: string) => new Set(s.match(/\{\w+\}/g) ?? []);

describe('i18n', () => {
  afterEach(() => setLocale('pt-BR'));

  it('tests run in PT regardless of machine language', () => {
    expect(getLocale()).toBe('pt-BR');
  });

  it('recognizes browser and system locale formats', () => {
    expect(normalizeLocale('fr')).toBe('fr');
    expect(normalizeLocale('fr-CA')).toBe('fr');
    expect(normalizeLocale('fr_FR.UTF-8')).toBe('fr');
    expect(normalizeLocale('pt')).toBe('pt-BR');
    expect(normalizeLocale('pt_PT')).toBe('pt-BR');
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('es_AR.UTF-8')).toBe('es');
    expect(normalizeLocale('de-DE')).toBeUndefined();
    expect(normalizeLocale('')).toBeUndefined();
    expect(normalizeLocale(null)).toBeUndefined();
  });

  it('in PT returns the text itself, with placeholders filled', () => {
    expect(tr('Lendo {0}', ['app.ts'])).toBe('Lendo app.ts');
    expect(tr('Texto que ninguém traduziu')).toBe('Texto que ninguém traduziu');
  });

  it('in French translates and can reorder placeholders', () => {
    setLocale('fr');
    expect(tr('Lendo {0}', ['app.ts'])).toBe('Lit app.ts');
    expect(tr('Texto que ninguém traduziu')).toBe('Texto que ninguém traduziu');
    expect(intlLocale()).toBe('fr-FR');
  });

  it('placeholders without arguments remain as is (named ones are filled by caller)', () => {
    expect(tr('Ganhei de {a} a {b}! 🏆')).toBe('Ganhei de {a} a {b}! 🏆');
    expect(tr('{0} e {1}', ['um'])).toBe('um e {1}');
  });

  it('server: HABBLAUD_LANG applies to any language; from system, English does not count', () => {
    expect(serverLocale({ HABBLAUD_LANG: 'en' }, 'pt-BR')).toBe('en');
    expect(serverLocale({ HABBLAUD_LANG: 'es-MX', LANG: 'fr_FR.UTF-8' })).toBe('es');
    // Mac with LANG in English and container without LANG (Intl en-US): office remains in Portuguese.
    expect(serverLocale({ LANG: 'en_US.UTF-8' }, 'en-US')).toBe('pt-BR');
    expect(serverLocale({}, 'en-US')).toBe('pt-BR');
    expect(serverLocale({ LANG: 'en_US.UTF-8' }, 'pt-BR')).toBe('pt-BR');
    expect(serverLocale({ LANG: 'fr_FR.UTF-8' })).toBe('fr');
    expect(serverLocale({ LC_ALL: 'es_ES.UTF-8', LANG: 'en_US.UTF-8' })).toBe('es');
    expect(serverLocale({}, 'es-AR')).toBe('es');
  });

  it('inglês e espanhol traduzem e usam o formato de data do idioma', () => {
    setLocale('en');
    expect(intlLocale()).toBe('en-US');
    setLocale('es');
    expect(intlLocale()).toBe('es');
  });

  it('no translation is empty or loses/invents placeholders', () => {
    for (const [lang, dict] of Object.entries({ en: EN, es: ES, fr: FR })) {
      for (const [pt, t] of Object.entries(dict)) {
        expect(t.trim(), `${lang}: ${pt}`).not.toBe('');
        const original = placeholders(pt);
        for (const p of placeholders(t)) expect(original.has(p), `${lang}: ${pt} -> ${t}`).toBe(true);
        if (lang !== 'fr') for (const p of original) expect(placeholders(t).has(p), `${lang}: ${pt} -> ${t}`).toBe(true);
      }
    }
  });
});
