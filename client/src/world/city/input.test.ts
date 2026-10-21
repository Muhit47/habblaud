// City keyboard: arrow keys and WASD (uppercase with Shift and by key code), diagonals and sprinting.
import { describe, expect, it } from 'vitest';
import { intentFrom, moveKeyOf } from './input';

describe('walk keys', () => {
  it('sums directions and sprints with Shift', () => {
    expect(intentFrom(new Set(['w']), false)).toEqual({ dx: 0, dy: -1, run: false });
    expect(intentFrom(new Set(['ArrowRight', 's']), true)).toEqual({ dx: 1, dy: 1, run: true });
    expect(intentFrom(new Set(['a', 'd']), false)).toEqual({ dx: 0, dy: 0, run: false });
    expect(intentFrom(new Set(['x']), false)).toEqual({ dx: 0, dy: 0, run: false });
  });

  it('WASD with Shift (uppercase) and across different layouts (by key code)', () => {
    expect(moveKeyOf({ key: 'W' })).toBe('w');
    expect(moveKeyOf({ key: 'ArrowLeft' })).toBe('ArrowLeft');
    expect(moveKeyOf({ key: 'z', code: 'KeyW' })).toBe('w');
    expect(moveKeyOf({ key: 'e', code: 'KeyE' })).toBeNull();
  });
});
