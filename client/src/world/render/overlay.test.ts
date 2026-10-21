// Pure world text overlay rules (speech bubbles and camera framing).
import { describe, expect, it } from 'vitest';
import { overviewFrame } from '../camera';
import { rationBubbles, waitBubbleText } from './overlay';

describe('speech bubbles', () => {
  it('waiting: motive only, without redundant prefix', () => {
    expect(waitBubbleText('aprovar uma permissão')).toBe('Aprovar uma permissão');
    expect(waitBubbleText('Precisa de você: escolher uma opção')).toBe('Escolher uma opção');
    expect(waitBubbleText(undefined)).toBe('Responder no terminal');
    expect(waitBubbleText('   ')).toBe('Responder no terminal');
  });

  it('overview: at most 1 text bubble per area and 4 on screen (most recent first)', () => {
    const items = [
      { room: 'a', prio: 50, changedAt: 10 },
      { room: 'a', prio: 50, changedAt: 30 },
      { room: 'a', prio: 50, changedAt: 20 },
      { room: 'b', prio: 30, changedAt: 99 },
      { room: 'c', prio: 50, changedAt: 1 },
      { room: 'd', prio: 50, changedAt: 2 },
      { room: 'e', prio: 50, changedAt: 3 },
    ];
    const keep = rationBubbles(items, 1, 4);
    expect(keep.size).toBe(4);
    expect(keep.has(1)).toBe(true); // most recent in area "a"
    expect(keep.has(0) || keep.has(2)).toBe(false);
    expect(keep.has(3)).toBe(false); // lower priority yields to other areas
  });
});

describe('overview framing', () => {
  const building = { x: 0, y: 0, w: 4 * 16 * 16, h: 29 * 16 };

  it('frames building in unobstructed area (outside panels), with headroom for plaques above', () => {
    const free = overviewFrame(building, 1440, 900, { top: 0, right: 0, bottom: 0, left: 0 });
    const ui = overviewFrame(building, 1440, 900, { top: 64, right: 0, bottom: 200, left: 320 });
    expect(ui.zoom).toBeLessThan(free.zoom);
    // framing height (plaques + building + curb) fits between top and bottom bars
    const h = (building.h + 3.5 * 16) * ui.zoom;
    expect(h).toBeLessThanOrEqual(900 - 64 - 200 - 30);
    // starts above north wall (plaques) and terminates below south facade
    expect(ui.cy).toBeGreaterThan(building.h / 2);
    expect(ui.dy).toBeGreaterThan(0);
  });
});
