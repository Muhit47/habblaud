// Mock floor names (shared/world/floor-names.ts, duplicated identically on world server) and translated labels.
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../i18n';
import { floorLabel, isFloorNameId } from './floor-labels';
import { FLOOR_NAME_IDS } from './floor-names';

afterEach(() => setLocale('pt-BR'));

describe('floor names', () => {
  it('60 ASCII IDs, unique, and draw sequence begins with ipe, jade, and aurora', () => {
    expect(FLOOR_NAME_IDS).toHaveLength(60);
    expect(new Set(FLOOR_NAME_IDS).size).toBe(60);
    for (const id of FLOOR_NAME_IDS) expect(id).toMatch(/^[a-z]+$/);
    expect([FLOOR_NAME_IDS[0], FLOOR_NAME_IDS[20], FLOOR_NAME_IDS[40]]).toEqual(['ipe', 'jade', 'aurora']);
  });

  it('each ID has dedicated label in all 4 languages', () => {
    expect(floorLabel('ipe')).toBe('Projeto Ipê');
    expect(floorLabel('lapislazuli')).toBe('Projeto Lápis-lazúli');
    const pt = FLOOR_NAME_IDS.map(floorLabel);
    expect(new Set(pt).size).toBe(60);
    for (const [locale, prefix] of [['en', 'Project '], ['es', 'Proyecto '], ['fr', 'Projet ']] as const) {
      setLocale(locale);
      const labels = FLOOR_NAME_IDS.map(floorLabel);
      expect(new Set(labels).size, locale).toBe(60);
      for (const l of labels) expect(l.startsWith(prefix), `${locale}: ${l}`).toBe(true);
    }
    setLocale('en');
    expect(floorLabel('ipe')).toBe('Project Ipê');
    expect(floorLabel('carvalho')).toBe('Project Oak');
  });

  it('unknown ID (from a newer server version) falls back to "Projeto"', () => {
    expect(isFloorNameId('ipe')).toBe(true);
    expect(isFloorNameId('novo')).toBe(false);
    expect(floorLabel('novo')).toBe('Projeto');
  });
});
