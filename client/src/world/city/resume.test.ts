// Return to city: initial `pos` matching previous preserves state; different location snaps directly; without
// saved state, defaults to standard spawn.
import { describe, expect, it } from 'vitest';
import { RESUME_SAME_TILES, resumePlacement, type CityResume } from './resume';

const R: CityResume = { camX: 640, camY: 480, zoom: 2.5, following: true, me: { x: 21.4, y: 15.6 } };

describe('resumePlacement', () => {
  it('same position (within server rounding tolerance): keep', () => {
    expect(resumePlacement(R, { x: 21.4, y: 15.6 })).toBe('keep');
    expect(resumePlacement(R, { x: 21, y: 16 })).toBe('keep');
    expect(resumePlacement(R, { x: 21.4 + RESUME_SAME_TILES - 0.01, y: 15.6 })).toBe('keep');
  });

  it('different position: snap (direct, without animation)', () => {
    expect(resumePlacement(R, { x: 21.4 + RESUME_SAME_TILES + 0.01, y: 15.6 })).toBe('snap');
    expect(resumePlacement(R, { x: 3, y: 40 })).toBe('snap');
  });

  it('no saved state, no prior character, or missing pos: fresh', () => {
    expect(resumePlacement(null, { x: 1, y: 1 })).toBe('fresh');
    expect(resumePlacement({ ...R, me: null }, { x: 21.4, y: 15.6 })).toBe('fresh');
    expect(resumePlacement(R, null)).toBe('fresh');
    expect(resumePlacement(R, { x: Number.NaN, y: 1 })).toBe('fresh');
  });
});
