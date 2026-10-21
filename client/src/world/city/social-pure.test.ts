// Light social in city (Phase 5), pure models: greetings wheel and bubbles, client-side rate limits, door
// for liking or knocking, flying heart, facade tokens, shift-end confetti, city goal, and "Go to" code.
import { describe, expect, it } from 'vitest';
import { lotDoor } from '../../../../shared/world/city';
import type { CityGoal, WorldBuildingPublic } from '../../../../shared/world/protocol';
import { cityHallView, goalsReached, goalView, ornamentFor, reachedGoalView } from './fireworks';
import { BalloonBook, BALLOON_MS, pickGreetTarget, RateGate, suggestedReply, WHEEL, wheelIndexOfKey, wheelKey, wheelLayout } from './greetings';
import { doorActions, doorTarget, heartAt, HEART_MS, KnockBook, KNOCK_EVERY_MS, LIKE_DISTANCE } from './likes';
import { FADE, normalizeBuildingCode, TeleportFade } from './teleport';
import { meterBars, meterRect, shiftEnded, signGlowLevel } from './tokens-facade';

function building(id: string, lot: { x: number; y: number }, extra: Partial<WorldBuildingPublic> = {}): WorldBuildingPublic {
  return { id, lot: { district: 'centro', ...lot }, owner: { id, name: `Dono ${id}` }, state: 'online', theme: 'none', floors: 3, rev: 1, likes: 5, sinceMonth: '2026-10', ...extra };
}

describe('greetings wheel', () => {
  it('10 circular items, first at top, shortcut keys 1–9 and 0', () => {
    const l = wheelLayout(WHEEL.length, 100);
    expect(l).toHaveLength(10);
    expect(l[0]).toMatchObject({ x: 0, y: -100 });
    expect(l[5]).toMatchObject({ x: 0, y: 100 });
    expect(WHEEL.map((_, i) => wheelKey(i)).join('')).toBe('1234567890');
    expect(wheelIndexOfKey('1')).toBe(0);
    expect(wheelIndexOfKey('0')).toBe(9);
    expect(wheelIndexOfKey('a')).toBe(-1);
  });

  it('target selection: replier first, then selected, then closest (within 12 tiles)', () => {
    const me = { x: 0, y: 0 };
    const ps = [{ id: 'perto', x: 2, y: 0 }, { id: 'meio', x: 6, y: 0 }, { id: 'longe', x: 30, y: 0 }];
    expect(pickGreetTarget(me, ps)).toBe('perto');
    expect(pickGreetTarget(me, ps, { selected: 'meio' })).toBe('meio');
    expect(pickGreetTarget(me, ps, { selected: 'meio', replyTo: 'longe' })).toBe('longe');
    expect(pickGreetTarget(me, ps, { selected: 'sumiu' })).toBe('perto');
    expect(pickGreetTarget(me, [{ id: 'longe', x: 30, y: 0 }])).toBeNull();
  });

  it('bubble lasts 5 s from arrival; new one from same player restarts timer', () => {
    const b = new BalloonBook();
    b.add('p1', 'hello', 1_000);
    expect(b.get('p1', 1_000 + BALLOON_MS / 2)).toMatchObject({ id: 'hello', t: 0.5 });
    b.add('p1', 'thanks', 4_000);
    expect(b.get('p1', 1_000 + BALLOON_MS + 10)?.id).toBe('thanks');
    expect(b.get('p1', 4_000 + BALLOON_MS)).toBeNull();
    expect(b.size).toBe(0);
  });

  it('client rate limit: one every 3 s and 20 per minute', () => {
    const g = new RateGate(20, 3_000);
    expect(g.take(0)).toBe(true);
    expect(g.take(2_999)).toBe(false);
    expect(g.wait(2_000)).toBe(1_000);
    let t = 0;
    let ok = 1;
    for (let i = 0; i < 40; i++) {
      t += 3_000;
      if (t < 60_000 && g.take(t)) ok++;
    }
    expect(ok).toBe(20);
    expect(g.take(59_999)).toBe(false);
    expect(g.take(60_000)).toBe(true);
  });

  it('suggested reply: always a valid greeting from the list', () => {
    for (const id of WHEEL) expect(WHEEL).toContain(suggestedReply(id));
    expect(suggestedReply('hello')).toBe('nice_to_meet');
    expect(suggestedReply('congrats')).toBe('thanks');
  });
});

describe('like and knock on door', () => {
  const near = building('b1', { x: 4, y: 1 }, { knocks: true });
  const mine = building('eu', { x: 3, y: 1 });
  const at = (lot: { x: number; y: number }) => (lot.x === 4 && lot.y === 1 ? near : lot.x === 3 && lot.y === 1 ? mine : undefined);
  const door = lotDoor(near.lot).front;

  it('closest door within requested range, never own building door', () => {
    expect(doorTarget({ x: door.x + 3, y: door.y }, at, 'eu', LIKE_DISTANCE)?.building.id).toBe('b1');
    expect(doorTarget({ x: door.x + 5, y: door.y }, at, 'eu', LIKE_DISTANCE)).toBeNull();
    const myDoor = lotDoor(mine.lot).front;
    expect(doorTarget(myDoor, at, 'eu', LIKE_DISTANCE)).toBeNull();
  });

  it('like within 4 steps; knock within 2 and only if accepted; own building does neither', () => {
    expect(doorActions(near, { x: door.x + 3.9, y: door.y }, 'eu')).toEqual({ canLike: true, canKnock: false, liked: false, mine: false });
    expect(doorActions(near, { x: door.x + 1, y: door.y }, 'eu')).toMatchObject({ canLike: true, canKnock: true });
    expect(doorActions({ ...near, knocks: undefined }, door, 'eu').canKnock).toBe(false);
    expect(doorActions(mine, lotDoor(mine.lot).front, 'eu')).toMatchObject({ canLike: false, canKnock: false, mine: true });
    expect(doorActions(near, null, 'eu').canLike).toBe(false);
  });

  it('knock: once per minute per building', () => {
    const k = new KnockBook();
    expect(k.take('b1', 0)).toBe(true);
    expect(k.take('b1', KNOCK_EVERY_MS - 1)).toBe(false);
    expect(k.take('b2', 10)).toBe(true);
    expect(k.take('b1', KNOCK_EVERY_MS)).toBe(true);
  });

  it('heart rises in arc to nameplate and vanishes on arrival; unliked, falls broken', () => {
    const f = { from: { x: 0, y: 100 }, to: { x: 100, y: 0 }, start: 0 };
    const mid = heartAt(f, HEART_MS / 2)!;
    expect(mid.x).toBeGreaterThan(50);
    expect(mid.y).toBeLessThan(50);
    expect(heartAt(f, HEART_MS)).toBeNull();
    const broken = heartAt({ ...f, broken: true }, HEART_MS / 2)!;
    expect(broken.y).toBeGreaterThan(0);
    expect(broken.alpha).toBeLessThan(1);
  });
});

describe('facade tokens and shift end', () => {
  it('signboard: off without band, then dim, normal, neon, and neon with sparks (4 and 5)', () => {
    expect([undefined, 0, 1, 2, 3, 4, 5].map((b) => signGlowLevel(b as never))).toEqual([0, 0, 1, 2, 3, 4, 4]);
    expect([undefined, 0, 3, 5].map((b) => meterBars(b as never))).toEqual([0, 0, 3, 5]);
  });

  it('meter sits in shop window, beside door (front) or awning (back), inside sprite', () => {
    const front = meterRect({ side: 'front', height: 100 });
    expect(front.y + front.h).toBeLessThanOrEqual(100);
    expect(front.x + front.w).toBeLessThanOrEqual(192 / 2 - 16);
    expect(meterRect({ side: 'back', height: 100 }).y).toBe(0);
  });

  it('shift end: fewer working and more idle in same patch', () => {
    const prev = { total: 4, working: 3, waiting: 0, idle: 1 };
    expect(shiftEnded(prev, { total: 4, working: 1, waiting: 0, idle: 3 })).toBe(true);
    expect(shiftEnded(prev, { total: 4, working: 4, waiting: 0, idle: 0 })).toBe(false);
    expect(shiftEnded(prev, { total: 4, working: 2, waiting: 1, idle: 1 })).toBe(false);
    expect(shiftEnded(undefined, { working: 0, idle: 4 })).toBe(false);
    expect(shiftEnded(prev, undefined)).toBe(false);
  });
});

describe('city goal', () => {
  const goal = (label: CityGoal['label'], target: number, progress: number): CityGoal => ({ id: `2026-10-12:${label}`, label, target, progress, until: 0 });

  it('thermometer: percentage, label, and how many weekly goals achieved', () => {
    const v = goalView({ lit: 40, goal: goal('agent_hours_10k', 10_000, 8_000) })!;
    expect(v).toMatchObject({ pct: 0.8, pctText: '80%', reached: 0 });
    expect(v.label).toMatch(/horas de agentes trabalhando/);
    expect(goalView({ lit: 40, goal: goal('agent_hours_50k', 50_000, 12_000) })?.reached).toBe(1);
    expect(goalsReached(goal('agent_hours_100k', 100_000, 100_000))).toBe(3);
    expect(goalView({ lit: 3 })).toBeNull();
    expect(goalView(null)).toBeNull();
  });

  it('during fireworks, thermometer displays achieved goal at 100%', () => {
    expect(reachedGoalView('2026-10-12:agent_hours_10k')).toMatchObject({ pct: 1, pctText: '100%', reached: 1, progressText: 'Meta batida!' });
    expect(reachedGoalView('2026-10-12:agent_hours_50k')?.reached).toBe(2);
    expect(reachedGoalView('qualquer')).toBeNull();
  });

  it('town hall: lit buildings and token band (or 10 buildings advisory)', () => {
    expect(cityHallView({ lit: 1 })).toMatchObject({ lit: '1 prédio aceso agora', tokens: 'A soma aparece com 10 prédios ou mais.' });
    expect(cityHallView({ lit: 42, tokensBand: 5 })?.tokens).toBe('A cidade consumiu ≈ mais de 100 milhões de tokens esta semana');
  });

  it('seasonal ornament: pumpkins in October, Christmas in Nov-Dec, party otherwise', () => {
    expect(ornamentFor(new Date(2026, 9, 15))).toBe('halloween');
    expect(ornamentFor(new Date(2026, 11, 1))).toBe('christmas');
    expect(ornamentFor(new Date(2026, 5, 1))).toBe('party');
  });
});

describe('Go to HB-XXXX', () => {
  it('entered code normalizes to canonical format; invalid alphabet yields null', () => {
    expect(normalizeBuildingCode('hb-4f2k')).toBe('HB-4F2K');
    expect(normalizeBuildingCode(' HB 4F2K ')).toBe('HB-4F2K');
    expect(normalizeBuildingCode('4f2k')).toBe('HB-4F2K');
    expect(normalizeBuildingCode('hb4f2k')).toBe('HB-4F2K');
    for (const bad of ['', 'HB-0O1I', 'HB-4F2', 'HB-4F2KK', 'HB-LULU']) expect(normalizeBuildingCode(bad), bad).toBeNull();
  });

  it('fade: darkens, awaits pos, brightens; times out at 5 s without response', () => {
    const f = new TeleportFade();
    f.start(0);
    expect(f.tick(FADE.out / 2)).toMatchObject({ phase: 'out', dark: 0.5 });
    expect(f.tick(FADE.out + 10).phase).toBe('wait');
    f.arrived();
    expect(f.tick(FADE.out + 20)).toMatchObject({ phase: 'in', dark: 1, timedOut: false });
    expect(f.tick(FADE.out + 20 + FADE.in).phase).toBe('idle');
    expect(f.busy).toBe(false);
    const g = new TeleportFade();
    g.start(0);
    g.tick(FADE.out);
    expect(g.tick(FADE.out + FADE.wait)).toMatchObject({ phase: 'in', timedOut: true });
  });
});
