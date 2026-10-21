// State of a project room in world: lifecycle (construction/dismantling) and lighting.
import type { RoomInfo } from '../../../../shared/types';
import type { RoomTheme } from '../../art/api';
import { BUILD_MS, DISMANTLE_MS } from '../constants';
import type { AreaLayout } from '../layout/types';
import { lightLevel } from './behavior';

/**
 * - building: construction animation;
 * - ready: sala pronta;
 * - dismantling: dismantling animation;
 * - gone: dismantled (pending removal).
 */
export type RoomPhase = 'building' | 'ready' | 'dismantling' | 'gone';

export class RoomState {
  info: RoomInfo;
  /** Seed used to generate theme and layout (fixed since creation, even if info.seed changes). */
  readonly seed: number;
  /** Client-assigned building slot (without gaps; see Sim.compact). May differ from info.slot. */
  slot: number;
  theme: RoomTheme;
  layout: AreaLayout;
  phase: RoomPhase;
  phaseAt: number;
  listed = true;
  unlistedAt = 0;
  lightOn: boolean;
  lightAt = -1e9;
  /** Character in charge of light switch (turn on upon entry / turn off on exit). */
  switchClaim: string | null = null;
  /** Timestamp when all teardown criteria became satisfied (0 = not met). */
  readyToDismantleAt = 0;
  /** Present accounts (for plaque indicators), synchronized from world. */
  accounts: string[] = [];
  /** Itens do quadro kanban. */
  board: { status: 'pending' | 'in_progress' | 'completed' }[] = [];
  /** Increments when static cached properties change (name, theme). */
  version = 0;
  /**
   * Former address of relocated room: lingers in place only until occupants exit, lights turn off,
   * and room is dismantled. No occupants belong to it and it does not appear in snapshot.
   */
  ghost = false;

  constructor(info: RoomInfo, theme: RoomTheme, layout: AreaLayout, phase: RoomPhase, now: number, lit: boolean, slot: number) {
    this.info = info;
    this.seed = info.seed;
    this.slot = slot;
    this.theme = theme;
    this.layout = layout;
    this.phase = phase;
    this.phaseAt = now;
    this.lightOn = lit;
    if (lit) this.lightAt = now - 10_000;
  }

  get id(): string {
    return this.info.id;
  }

  /** Phase animation progress (0..1). */
  progress(now: number): number {
    if (this.phase === 'building') return Math.min(1, (now - this.phaseAt) / BUILD_MS);
    if (this.phase === 'dismantling') return Math.min(1, (now - this.phaseAt) / DISMANTLE_MS);
    if (this.phase === 'ready') return 1;
    return 0;
  }

  /** Occupies grid (walkable) and is rendered. */
  get present(): boolean {
    return this.phase === 'building' || this.phase === 'ready' || this.phase === 'dismantling';
  }

  setPhase(phase: RoomPhase, now: number): void {
    this.phase = phase;
    this.phaseAt = now;
  }

  /** Reverts in-progress dismantling back to construction, resuming from equivalent visual progress. */
  rebuild(now: number): void {
    if (this.phase === 'dismantling') {
      const p = this.progress(now);
      this.phase = 'building';
      this.phaseAt = now - (1 - p) * BUILD_MS;
    } else if (this.phase === 'gone') {
      this.setPhase('building', now);
    }
  }

  setLight(on: boolean, now: number): void {
    if (this.lightOn === on) return;
    this.lightOn = on;
    this.lightAt = now;
  }

  light(now: number): number {
    return lightLevel(this.lightOn, now - this.lightAt);
  }
}
