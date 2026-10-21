// World button in top bar: switches between office and Habblaud World city (Office button or Esc).
// Only appears when scene is available: local server `meta.world.scene.available` (demo mode or
// approved account), accessed on host machine (never mobile port) and never during timelapse. Scene
// itself managed by app.ts (CitySceneHost); this component controls button, `is-city` class, and transitions.
import { tr } from '../../../../shared/i18n';
import type { WorldSource } from '../../net/world';
import type { Selection } from '../../world/api';
import type { UiComponent, UiContext } from '../context';
import { h, setAttr, setHidden, setText, setTitle } from '../dom';
import { ICONS } from '../icons';
import { worldGate } from './settings-world';
import { worldSectionMode, type WorldGate } from './world-model';

/** Interface contract for city scene (implemented in app.ts, loaded on demand). */
export interface CitySceneHost {
  readonly open: boolean;
  /** Displays city scene (lazy-loads on first invocation) and hides office. */
  show(): Promise<void>;
  hide(): void;
  zoomBy(factor: number): void;
  recenter(): void;
  /** Esc: closes open modal/card in city; false = nothing open to dismiss. */
  escape(): boolean;
  /** "View as others see it": enters own building (with city scene already open). */
  visitOwn?(): void;
}

/**
 * Is World scene available? Checks `meta.world.scene.available` (approved account, character created,
 * local terminal lock active, unbanned/unsuspended; in demo mode, FakeWorldApi) and host machine
 * access (mobile port omits city scene routes).
 */
export function citySceneAvailable(src: WorldSource, gate: WorldGate): boolean {
  const meta = src.meta();
  return meta?.scene?.available === true && worldSectionMode(meta, gate) === 'active';
}

export class SceneSwitch implements UiComponent {
  readonly button: HTMLButtonElement;
  private readonly icon: HTMLElement;
  private readonly label: HTMLElement;
  private busy = false;
  private autoOpen: boolean;

  constructor(
    private readonly ctx: UiContext,
    private readonly src: WorldSource,
    private readonly host: CitySceneHost,
    private readonly onChange: () => void,
  ) {
    this.icon = h('span', { class: 'ui-scene-btn__icon', attrs: { 'aria-hidden': 'true' } });
    this.label = h('span', { class: 'ui-scene-btn__label' });
    this.button = h('button', { class: 'ui-scene-btn', type: 'button', hidden: true, on: { click: () => void this.toggle() } }, this.icon, this.label);
    // ?scene=city: direct launch into city scene (demo mode screenshots)
    this.autoOpen = typeof location !== 'undefined' && new URLSearchParams(location.search).get('scene') === 'city';
  }

  get inCity(): boolean {
    return this.host.open;
  }

  private available(): boolean {
    return citySceneAvailable(this.src, worldGate(this.ctx, this.src)) && !this.ctx.store.replaying && !this.ctx.isTimelapseOpen();
  }

  async toggle(): Promise<void> {
    if (this.host.open) this.close();
    else await this.open();
  }

  async open(): Promise<void> {
    if (this.busy || this.host.open || !this.available()) return;
    this.busy = true;
    try {
      // close drawer and terminal: city scene has no active selected agent
      if (this.ctx.selection()) this.ctx.select(null);
      await this.host.show();
      this.ctx.announce(tr('Você está na cidade do Habblaud World. Esc volta ao escritório.'));
    } catch (err) {
      console.error('[ui] a cidade não abriu', err);
    } finally {
      this.busy = false;
      this.onChange();
    }
  }

  /** "View as others see it": launches city (if needed) and enters player's own building. */
  async visitOwn(): Promise<void> {
    if (!this.host.open) await this.open();
    if (this.host.open) this.host.visitOwn?.();
  }

  close(): void {
    if (!this.host.open) return;
    this.host.hide();
    this.ctx.announce(tr('De volta ao escritório.'));
    this.onChange();
  }

  /**
   * Selecting agent or room while in city (notice, Answer, delivery) returns to office:
   * drawer and terminal remain hidden in city. Called by `ctx.select` before insetting free area.
   */
  leaveFor(sel: Selection): void {
    if (sel) this.close();
  }

  render(): void {
    const ok = this.available();
    // scene became unavailable (account status change, timelapse): return to office
    if (!ok && this.host.open) this.close();
    setHidden(this.button, !ok && !this.host.open);
    const city = this.host.open;
    this.icon.innerHTML = city ? ICONS.office : ICONS.city;
    setText(this.label, city ? tr('Escritório') : tr('Mundo'));
    const title = city ? tr('Voltar ao escritório (Esc)') : tr('Mundo: andar pela cidade do Habblaud World');
    setTitle(this.button, title);
    setAttr(this.button, 'aria-label', title);
    setAttr(this.button, 'aria-pressed', String(city));
    this.button.classList.toggle('is-city', city);
    if (this.autoOpen && ok) {
      this.autoOpen = false;
      void this.open();
    }
  }
}
