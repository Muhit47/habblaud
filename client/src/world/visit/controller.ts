// Core of Visit scene, DOM-free (testable): interior of building downloaded from world becomes `Sim` office
// (shared/world/office-from-world.ts) and each `building.patch` is applied immediately, checking building `rev`
// (gap: ↑ `resync {building}`, at most once every 5 s). Only commands issued from here are `leave` and
// `resync {building}`, via World scene stream (POST /api/world/cmd): no `move` (interior position is not sent to
// world server) and no `view` (viewer would interpret as "returned to city").
import type { WorldSceneCommand, WorldSceneInside } from '../../../../shared/world/api';
import { applyBuildingPatch, checkBuildingRev, officeFromBuilding } from '../../../../shared/world/office-from-world';
import type { BuildingPatchMessage, WorldBuildingDetail } from '../../../../shared/world/protocol';
import type { OfficeSnapshot } from '../../../../shared/types';
import type { VisitLight } from '../sim/sim';
import { visitLightOf } from './model';

/** Minimum delay between two `resync {building}` calls. */
export const VISIT_RESYNC_GAP_MS = 5_000;

export interface VisitControllerDeps {
  /** Publishes visit office (`store.pushReplay` for visit world). */
  push(snap: OfficeSnapshot): void;
  /** Sends commands via World scene stream (only `leave` and `resync {building}` issued from here). */
  send(cmds: WorldSceneCommand[]): void;
  now(): number;
  /** Habblaud version (sent in `meta.version` of visit office). */
  version: string;
  /** O interior mudou (faixa, painel, luzes, tema). */
  changed?(): void;
}

export class VisitController {
  readonly id: string;
  rev: number;
  /** Interior as currently represented (with patches applied). */
  detail: WorldBuildingDetail;
  snapshot: OfficeSnapshot;
  /** `leave` already sent: awaiting `pos` (return to street). */
  leaving = false;
  private resyncAt = -Infinity;

  constructor(
    inside: WorldSceneInside,
    private readonly deps: VisitControllerDeps,
  ) {
    this.id = inside.id;
    this.rev = inside.rev;
    this.detail = structuredClone(inside.detail);
    this.snapshot = officeFromBuilding(this.detail, deps.now(), { version: deps.version });
    deps.push(this.snapshot);
  }

  /** Current building lights. */
  get light(): VisitLight {
    return visitLightOf(this.detail.building);
  }

  /**
   * Full interior received again (`building` from `resync`, repeated `enter`, or new stream snapshot):
   * replaces everything, including `rev`, but as patch (agents retaining same status don't move).
   */
  replace(inside: Pick<WorldSceneInside, 'rev' | 'detail'>): void {
    const d = structuredClone(inside.detail);
    const r = applyBuildingPatch(this.snapshot, { rev: inside.rev, floors: d.floors, building: d.building }, this.deps.now());
    this.rev = inside.rev;
    this.detail = d;
    this.resyncAt = -Infinity;
    this.publish(r.snapshot);
  }

  /** A `building.patch`: applies sequential, ignores duplicate/stale, requests resync on gap. */
  patch(msg: Pick<BuildingPatchMessage, 'rev' | 'floors' | 'visitors' | 'building'>): 'apply' | 'stale' | 'resync' {
    const what = checkBuildingRev(this.rev, msg.rev);
    if (what === 'stale') return what;
    if (what === 'resync') {
      const now = this.deps.now();
      if (now - this.resyncAt >= VISIT_RESYNC_GAP_MS) {
        this.resyncAt = now;
        this.deps.send([{ t: 'resync', building: this.id }]);
      }
      return what;
    }
    // current `building` decides whether agents appear when patch only includes floors
    const r = applyBuildingPatch(this.snapshot, msg, this.deps.now(), this.detail.building);
    this.rev = msg.rev;
    if (msg.floors) this.detail.floors = structuredClone(msg.floors);
    if (msg.building) this.detail.building = structuredClone(msg.building);
    if (typeof msg.visitors === 'number') this.detail.visitors = msg.visitors;
    this.publish(r.snapshot);
    return what;
  }

  /** Leave building: `leave` (once); return to street is `pos` responded by server. */
  leave(): boolean {
    if (this.leaving) return false;
    this.leaving = true;
    this.deps.send([{ t: 'leave' }]);
    this.deps.changed?.();
    return true;
  }

  private publish(snap: OfficeSnapshot): void {
    if (snap !== this.snapshot) {
      this.snapshot = snap;
      this.deps.push(snap);
    }
    this.deps.changed?.();
  }
}
