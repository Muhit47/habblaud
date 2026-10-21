// Habblaud World release popups: native modal (<dialog> on top layer, dimmed backdrop,
// focus-trapped, Esc dismiss) layered over office and above Habblaud World dialog:
// - "What's new: Habblaud World" for unauthenticated users. "Not now" dismisses and re-prompts after
//   3 days up to 3 times total; "Don't show again" suppresses permanently; registration ceases prompts.
//   Postpones while Settings or Habblaud World dialog is active.
// - "You are on the waitlist" following registration (or on initial load while waitlisted), once per browser.
// - "Access granted!" when account is approved while page is open (or loaded approved without player),
//   once per browser; "Create character" directs to character creation screen in World modal.
// Governed by nextWorldPopup (world-model.ts, pure & tested); state persists to localStorage.
// Only displays when world server is configured and page is loaded on host machine (never on mobile,
// timelapse, or demo mode).
import { tr } from '../../../../shared/i18n';
import type { WorldSource } from '../../net/world';
import type { UiComponent, UiContext } from '../context';
import { h } from '../dom';
import { pixelIcon } from '../icons';
import { safeLocalStorage } from '../prefs';
import { extLink, WORLD_PRIVACY_URL } from './links';
import { worldGate } from './settings-world';
import {
  APPROVED_SEEN_KEY,
  EMPTY_POPUP_MEMORY,
  INVITE_SEEN_KEY,
  LAUNCH_KEY,
  nextWorldPopup,
  parsePopupMemory,
  serializePopupMemory,
  WAITLIST_SEEN_KEY,
  type WorldPopupKind,
  type WorldPopupMemory,
} from './world-model';

/** Pixel art building icon (world represents city of buildings): popup badge and World dialog header icon. */
export const WORLD_BUILDING_ICON = pixelIcon(
  [
    '....####....',
    '....#..#....',
    '.##########.',
    '.#.##.##.##.',
    '.##########.',
    '.#.##.##.##.',
    '.##########.',
    '.#.##.##.##.',
    '.##########.',
    '.####..####.',
    '.####..####.',
    '############',
  ],
  { '#': 'currentColor' },
  'ui-px-icon ui-world-popup__icon',
);

export interface WorldPopupHooks {
  /** Opens Habblaud World dialog focused on requested screen (registration or character). */
  openWorld(screen: 'register' | 'character'): void;
  /** Panel open guard: launch popup defers while Settings/World dialog is open. */
  panelOpen(): boolean;
}

const TITLE_ID = 'ui-world-popup-title';

export class WorldPopups implements UiComponent {
  readonly el: HTMLDialogElement;
  private memory: WorldPopupMemory;
  private open: WorldPopupKind | null = null;
  /** Element focused prior to popup opening (restored on close). */
  private opener: HTMLElement | null = null;

  constructor(
    private readonly ctx: UiContext,
    private readonly src: WorldSource,
    private readonly hooks: WorldPopupHooks,
  ) {
    this.memory = this.load();
    // `aria-modal` only while active: when dismissed, <dialog> remains in DOM and must not trap focus
    // (city keyboard and office shortcuts pause when an active modal is reported).
    this.el = h('dialog', { class: 'ui-world-popup', attrs: { 'aria-labelledby': TITLE_ID } });
    // Backdrop click dismisses modal (equivalent to "Not now" / "Later").
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.addEventListener('close', () => this.onClosed());
    // Esc dismisses (<dialog> modal handles natively; polyfilled when unsupported) without triggering shortcuts.
    this.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (typeof this.el.showModal !== 'function') {
        e.preventDefault();
        this.close();
      }
    });
  }

  render(): void {
    const meta = this.src.meta();
    if (this.open) {
      // Account registered via another route (World dialog, another tab): launch prompt is obsolete.
      if (this.open === 'launch' && meta?.state !== 'logged_out') this.close();
      return;
    }
    const gate = { ...worldGate(this.ctx, this.src), replaying: this.ctx.store.replaying };
    const d = nextWorldPopup(meta, gate, this.memory, Date.now());
    // With Settings or World dialog open, launch prompt defers to next check without incrementing counter.
    if (d.show === 'launch' && this.hooks.panelOpen()) return;
    if (d.memory) this.remember(d.memory);
    if (d.show) this.show(d.show);
  }

  // ---------------------------------------------------------------- content

  private show(kind: WorldPopupKind): void {
    this.open = kind;
    const badge = h('span', { class: 'ui-world-popup__badge', attrs: { 'aria-hidden': 'true' } });
    badge.innerHTML = WORLD_BUILDING_ICON;
    const { title, body, actions, primary } = this.content(kind);
    this.el.className = `ui-world-popup is-${kind}`;
    this.el.replaceChildren(
      h('div', { class: 'ui-world-popup__head' }, badge, h('h2', { class: 'ui-world-popup__title', text: title, attrs: { id: TITLE_ID } })),
      h('div', { class: 'ui-world-popup__body' }, ...body),
      h('div', { class: 'ui-world-popup__actions' }, ...actions),
    );
    this.opener = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof this.el.showModal === 'function') {
      if (!this.el.open) this.el.showModal();
    } else {
      this.el.setAttribute('open', '');
    }
    this.el.setAttribute('aria-modal', 'true');
    primary.focus({ preventScroll: true });
  }

  private content(kind: WorldPopupKind): { title: string; body: HTMLElement[]; actions: HTMLElement[]; primary: HTMLButtonElement } {
    const hint = (text: string) => h('p', { class: 'ui-set__hint ui-world-popup__hint', text });
    const para = (text: string) => h('p', { class: 'ui-world-popup__text', text });
    if (kind === 'waitlist') {
      const ok = h('button', { class: 'ui-btn ui-btn--primary ui-world-popup__cta', type: 'button', text: tr('Entendi'), attrs: { autofocus: true }, on: { click: () => this.close() } });
      return {
        title: tr('Você está na lista de espera'),
        body: [
          para(tr('O acesso é liberado aos poucos, em lotes. Avisamos por e-mail quando chegar a sua vez.')),
          hint(tr('Enquanto isso, o Habblaud continua normal e nada do escritório é enviado.')),
        ],
        actions: [ok],
        primary: ok,
      };
    }
    if (kind === 'approved') {
      const create = h('button', { class: 'ui-btn ui-btn--primary ui-world-popup__cta', type: 'button', text: tr('Criar personagem'), attrs: { autofocus: true }, on: { click: () => this.go('character') } });
      return {
        title: tr('Acesso liberado!'),
        body: [para(tr('Chegou a sua vez: crie o seu personagem e entre na cidade.'))],
        actions: [create, h('button', { class: 'ui-btn', type: 'button', text: tr('Depois'), on: { click: () => this.close() } })],
        primary: create,
      };
    }
    const create = h('button', { class: 'ui-btn ui-btn--primary ui-world-popup__cta', type: 'button', text: tr('Criar conta'), attrs: { autofocus: true }, on: { click: () => this.go('register') } });
    return {
      title: tr('Novidade: Habblaud World'),
      body: [
        h('p', { class: 'ui-world-popup__lead', text: tr('Seu escritório agora pode virar um prédio numa cidade online, aceso enquanto os seus agentes trabalham.') }),
        h(
          'ul',
          { class: 'ui-world-popup__perks' },
          h('li', { text: tr('Seu escritório vira um prédio numa cidade em pixel art, aceso enquanto os seus agentes trabalham.') }),
          h('li', { text: tr('Crie um personagem, ande pela cidade e visite os prédios de outras pessoas.') }),
          h('li', { text: tr('Cumprimente quem passa e deixe likes nos prédios, sem chat e sem spam.') }),
        ),
        h(
          'p',
          { class: 'ui-world-popup__privacy' },
          tr('Nada do seu trabalho sai do computador: só o tema, quantos andares e se cada personagem está ocupado ou à toa.'),
          ' ',
          extLink(tr('Ver a lista'), WORLD_PRIVACY_URL),
        ),
        hint(tr('Nada é enviado enquanto você não criar a conta. O acesso é liberado aos poucos, por lista de espera.')),
      ],
      actions: [
        create,
        h('button', { class: 'ui-btn', type: 'button', text: tr('Agora não'), on: { click: () => this.close() } }),
        h('button', { class: 'ui-link-btn', type: 'button', text: tr('Não mostrar de novo'), on: { click: () => this.never() } }),
      ],
      primary: create,
    };
  }

  // ---------------------------------------------------------------- actions

  private go(screen: 'register' | 'character'): void {
    this.close();
    this.hooks.openWorld(screen);
  }

  private never(): void {
    this.remember({ ...this.memory, launch: 'never' });
    this.close();
  }

  private close(): void {
    if (this.el.open) {
      if (typeof this.el.close === 'function') this.el.close();
      else this.el.removeAttribute('open');
    }
    this.el.removeAttribute('aria-modal');
    if (this.open) this.onClosed();
  }

  private onClosed(): void {
    if (!this.open) return;
    this.open = null;
    if (this.opener?.isConnected) this.opener.focus({ preventScroll: true });
    this.opener = null;
    this.ctx.invalidate();
  }

  // ---------------------------------------------------------------- persistence

  private load(): WorldPopupMemory {
    try {
      const s = safeLocalStorage();
      if (!s) return { ...EMPTY_POPUP_MEMORY };
      return parsePopupMemory({ launch: s.getItem(LAUNCH_KEY), legacy: s.getItem(INVITE_SEEN_KEY), waitlist: s.getItem(WAITLIST_SEEN_KEY), approved: s.getItem(APPROVED_SEEN_KEY) });
    } catch {
      return { ...EMPTY_POPUP_MEMORY };
    }
  }

  private remember(m: WorldPopupMemory): void {
    this.memory = m;
    try {
      const s = safeLocalStorage();
      if (!s) return;
      const v = serializePopupMemory(m);
      for (const [key, value] of [
        [LAUNCH_KEY, v.launch],
        [WAITLIST_SEEN_KEY, v.waitlist],
        [APPROVED_SEEN_KEY, v.approved],
      ] as const) {
        if (value === null) s.removeItem(key);
        else s.setItem(key, value);
      }
    } catch {
      // Without local storage: state persists only in memory for current page.
    }
  }
}
