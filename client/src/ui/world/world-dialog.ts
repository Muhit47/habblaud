// Habblaud World dialog: modal <dialog> (top layer, dimmed backdrop, focus trap, Esc dismiss) with dedicated
// top bar button (city icon, visible only when world server configured) and triggered by top bar chip
// ("in world" / "paused"), launch popups ("Create account", "Create character"), and "While you were away" notice.
// Body hosts WorldSettingsGroup (settings-world.ts): account, waitlist, character, "Your building",
// devices, account & data, blocked players, and sign out. Header features pixel building badge, title,
// account state chip, and close button; body scrolls. Theme note in Settings › Appearance links here
// (themeNote/onThemePicked).
//
// Dual modal handling (waitlist popup immediately following registration, or "View sent payload"):
// showModal() stacks in top layer, Esc closes only topmost modal, returning focus to this window on dismiss.
import { tr } from '../../../../shared/i18n';
import type { WorldSource, WorldThemeChoice } from '../../net/world';
import type { UiComponent, UiContext } from '../context';
import { h, iconButton, setHidden } from '../dom';
import { ICONS } from '../icons';
import { WorldSettingsGroup, worldGate } from './settings-world';
import { WORLD_BUILDING_ICON } from './world-popups';
import { worldSectionMode, type WorldScreen } from './world-model';

const TITLE_ID = 'ui-world-dialog-title';

/** Requirements Settings needs from World: Appearance theme note and dispatching chosen theme to building. */
export interface WorldThemeLink {
  readonly themeNote: HTMLElement;
  onThemePicked(theme: WorldThemeChoice): Promise<void>;
}

export class WorldDialog implements UiComponent, WorldThemeLink {
  readonly el: HTMLDialogElement;
  private readonly group: WorldSettingsGroup;
  private readonly body: HTMLElement;
  private readonly title: HTMLElement;
  /** Element focused prior to modal opening (top bar button, chip…): restored on close. */
  private opener: HTMLElement | null = null;

  constructor(
    private readonly ctx: UiContext,
    private readonly src: WorldSource,
    /** Top bar button: hidden without configured world server, toggles aria-expanded. */
    private readonly button: HTMLElement,
  ) {
    this.group = new WorldSettingsGroup(ctx, src);
    const badge = h('span', { class: 'ui-world-dialog__badge', attrs: { 'aria-hidden': 'true' } });
    badge.innerHTML = WORLD_BUILDING_ICON;
    this.title = h('h2', { class: 'ui-world-dialog__title', text: tr('Habblaud World'), tabIndex: -1, attrs: { id: TITLE_ID } });
    const close = iconButton(ICONS.close, tr('Fechar (Esc)'), () => this.close(), 'ui-icon-btn--sm');
    this.body = h('div', { class: 'ui-world-dialog__body' }, this.group.el);
    this.el = h(
      'dialog',
      // `aria-modal` only while open (when closed, <dialog> remains in DOM and must not report as active modal).
      { class: 'ui-world-dialog', attrs: { 'aria-labelledby': TITLE_ID } },
      h('div', { class: 'ui-world-dialog__head' }, badge, h('div', { class: 'ui-world-dialog__heading' }, this.title, this.group.chip), close),
      this.body,
    );
    // Backdrop clicks (outside modal content) dismiss dialog.
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    // Keyboard trapped inside dialog: office shortcuts do not trigger underneath. Esc dismisses (<dialog>
    // modal handles natively; polyfilled when showModal is unavailable) without propagating to shortcuts.
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Escape' || typeof this.el.showModal === 'function') return;
      e.preventDefault();
      this.close();
    });
    this.el.addEventListener('close', () => this.onClosed());
  }

  get themeNote(): HTMLElement {
    return this.group.themeNote;
  }

  onThemePicked(theme: WorldThemeChoice): Promise<void> {
    return this.group.onThemePicked(theme);
  }

  get isOpen(): boolean {
    return this.el.open;
  }

  /** Opens modal (if closed) and navigates to target `screen` (registration, character, building…). */
  show(screen?: WorldScreen, opener?: HTMLElement | null): void {
    this.group.show(screen);
    if (this.el.open) return;
    this.opener = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (typeof this.el.showModal === 'function') this.el.showModal();
    else this.el.setAttribute('open', '');
    this.el.setAttribute('aria-modal', 'true');
    this.button.setAttribute('aria-expanded', 'true');
    this.body.scrollTop = 0;
    // Initial focus on title (screen readers announce window); form views subsequently focus first field.
    this.title.focus({ preventScroll: true });
    this.ctx.invalidate();
  }

  toggle(opener?: HTMLElement | null): void {
    if (this.el.open) this.close();
    else this.show(undefined, opener);
  }

  close(): void {
    if (!this.el.open) return;
    this.el.removeAttribute('aria-modal');
    if (typeof this.el.close === 'function') this.el.close();
    else {
      this.el.removeAttribute('open');
      this.onClosed();
    }
  }

  private onClosed(): void {
    this.button.setAttribute('aria-expanded', 'false');
    if (this.opener?.isConnected) this.opener.focus({ preventScroll: true });
    this.opener = null;
    this.ctx.invalidate();
  }

  render(): void {
    // Without configured world server (or on remote mobile port), button remains hidden.
    const hidden = worldSectionMode(this.src.meta(), worldGate(this.ctx, this.src)) === 'hidden';
    setHidden(this.button, hidden);
    if (hidden && this.el.open) this.close();
    this.group.render(this.el.open);
  }
}
