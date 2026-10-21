// Visit Scene of Habblaud World (PLANO.md, sections 2.5 and 8.4): inside someone else's building, their office as
// they see it. Mounted by city scene (world/city/index.ts) when `building` arrives following `enter`, and
// unmounted when `pos` indicates player is back on the street; city stream remains open continuously (if closed, the
// local server sends `view.off` and world evacuates player from building).
//
// Dedicated world instance (createWorld with `visit: true`) on dedicated canvas, fed by dedicated OfficeStore that never
// connects (`pushReplay` only): this computer's local office, global snapshot, and UI remain unaware. By
// architectural design, active elements are not mounted here: no terminal, drawer, feed, alerts, permissions, messages, My Day,
// timelapse, character editor, or room renaming. Only top banner, read-only side panel (rooms and agents, with
// card showing name, role, tool, and status), Leave (button, Esc, or reception elevator), and atop panel, the
// lightweight interior social features (visit-social.ts, Phase 5): **Like** and **Leave a stamp** in the lobby, handled by
// stream messages (`message`). Reception wall plaque becomes stamp board (`stampBoard`): what this
// browser left today and, in user's own building, "While you were away" stamps.
// Visitor (user's character, wearing badge) walks with keyboard and click; no movement packets leave machine.
import { hash32 } from '../../../../shared/hash';
import { tr } from '../../../../shared/i18n';
import type { WorldSceneCommand, WorldSceneInside, WorldSceneMe } from '../../../../shared/world/api';
import type { BuildingPatchMessage, StampId } from '../../../../shared/world/protocol';
import { OfficeStore } from '../../net/store';
import { h, setHidden, setText } from '../../ui/dom';
import { modalOpen } from '../input';
import type { WorldOptions } from '../api';
import { intentFrom, moveKeyOf } from '../city/input';
import { createWorld } from '../index';
import { browserStorage, clearWorldWallets } from '../social/wallet';
import { mountVisitSocial, stampBoard, stampPinTitle } from '../visit-social';
import { VisitController } from './controller';
import { findAgent, visitBanner, visitLightOf, visitorsLabel, visitPanel } from './model';

/** If no response to `leave` after this duration, scene exits autonomously (local server restarts city). */
export const LEAVE_TIMEOUT_MS = 8_000;
const NARROW_QUERY = '(max-width: 760px)';

export interface VisitSceneOptions {
  uiRoot: HTMLElement;
  /** City canvas: visit canvas mounts directly after it. */
  after: HTMLElement;
  inside: WorldSceneInside;
  /** User in scene (name, look, and parts of world character). */
  me: WorldSceneMe;
  /** User's own building ("see how others see it"). */
  mine: boolean;
  /** Office options (names, speech bubbles, day and night); theme is host's theme. */
  options: () => WorldOptions;
  version: string;
  topInset: () => number;
  /** World scene stream commands (`leave`, `resync {building}`, and social: `like`, `unlike`, `stamp`). */
  send(cmds: WorldSceneCommand[]): void;
  /** Scene toast notification (matching city). */
  toast(text: string): void;
  /** In own building: "While you were away" stamps (reception board). */
  summaryStamps?(): ReadonlyArray<{ stampId: StampId; count: number }>;
  /** Unanswered `leave`: city view recovers autonomously. */
  stuck(): void;
}

export interface VisitScene {
  readonly id: string;
  readonly controller: VisitController;
  /** Entire interior again (repeated `building`, `resync`, snapshot from new stream). */
  replace(inside: Pick<WorldSceneInside, 'rev' | 'detail'>): void;
  patch(msg: BuildingPatchMessage): void;
  /** Stream message before city: true = handled like or stamp from here (suppressed in city). */
  message(msg: unknown): boolean;
  /** Leave now (button, Esc): sends `leave`. */
  leave(): void;
  /** Esc: closes open card; otherwise leaves. Always true (in visit, Esc is captured). */
  escape(): boolean;
  destroy(): void;
  /** Debug and screenshots: opens panel (mobile) and agent card. */
  openPanel(open?: boolean): void;
  selectAgent(id: string | null): void;
  readonly world: ReturnType<typeof createWorld>;
}

export function createVisitScene(o: VisitSceneOptions): VisitScene {
  const canvas = document.createElement('canvas');
  canvas.id = 'visit';
  o.after.after(canvas);
  // Store scoped only to this visit that never connects: local computer office is unaffected.
  const store = new OfficeStore({ search: '' });
  const world = createWorld(canvas, store, { visit: true });
  const narrowMq = typeof matchMedia === 'function' ? matchMedia(NARROW_QUERY) : null;
  const narrow = () => !!narrowMq?.matches;
  let panelOpen = !narrow();
  let destroyed = false;
  let leaveTimer: ReturnType<typeof setTimeout> | null = null;
  let raf = 0;
  let theme = '';

  // lights before first snapshot: away buildings enter already darkened
  world.visit.setLight(visitLightOf(o.inside.detail.building));
  const controller = new VisitController(o.inside, {
    push: (snap) => store.pushReplay(snap),
    send: (cmds) => o.send(cmds),
    now: () => Date.now(),
    version: o.version,
    changed: () => render(),
  });
  world.visit.setVisitor({ name: o.me.name, look: o.me.look, parts: o.me.parts });

  // ------------------------------------------------------------------ DOM

  const title = h('strong', { class: 'ui-visit-bar__title' });
  const details = h('span', { class: 'ui-visit-bar__details' });
  const mode = h('span', { class: 'ui-visit-bar__mode', hidden: true });
  const visitors = h('span', { class: 'ui-visit-bar__visitors' });
  const panelBtn = h('button', { class: 'ui-btn ui-visit-bar__panel', type: 'button', attrs: { 'aria-expanded': 'false', 'aria-controls': 'ui-visit-panel' }, on: { click: () => setPanel(!panelOpen) } });
  const leaveBtn = h('button', { class: 'ui-btn ui-btn--primary ui-visit-bar__leave', type: 'button', text: tr('Sair do prédio'), title: tr('Sair do prédio (Esc)'), on: { click: () => leave() } });
  const bar = h(
    'header',
    { class: 'ui-visit-bar', attrs: { 'aria-label': tr('Visita') } },
    h('div', { class: 'ui-visit-bar__text' }, h('div', { class: 'ui-visit-bar__line' }, title, mode), h('div', { class: 'ui-visit-bar__line' }, details, visitors)),
    h('div', { class: 'ui-visit-bar__actions' }, panelBtn, leaveBtn),
  );

  const cardName = h('strong', { class: 'ui-visit-card__name' });
  const cardMeta = h('span', { class: 'ui-visit-card__meta' });
  const cardStatus = h('span', { class: 'ui-visit-card__status' });
  const cardRoom = h('span', { class: 'ui-visit-card__room' });
  const card = h(
    'section',
    { class: 'ui-visit-card', hidden: true, attrs: { 'aria-live': 'polite', 'aria-label': tr('Agente') } },
    h(
      'div',
      { class: 'ui-visit-card__head' },
      cardName,
      h('button', { class: 'ui-visit-card__close', type: 'button', text: '×', title: tr('Fechar'), attrs: { 'aria-label': tr('Fechar') }, on: { click: () => world.select(null) } }),
    ),
    cardMeta,
    h('div', { class: 'ui-visit-card__row' }, cardStatus, cardRoom),
  );
  const emptyNote = h('p', { class: 'ui-visit-panel__empty', hidden: true });
  const roomsEl = h('ul', { class: 'ui-visit-panel__rooms' });
  // Like and Leave a stamp (visit-social.ts) at top of panel; hidden in own building
  const socialBox = h('div', { class: 'ui-visit-panel__social' });
  const panel = h(
    'aside',
    { class: 'ui-visit-panel', attrs: { id: 'ui-visit-panel', 'aria-label': tr('Salas do prédio') } },
    socialBox,
    h('h3', { class: 'ui-visit-panel__title', text: tr('Salas') }),
    card,
    emptyNote,
    roomsEl,
    h('p', { class: 'ui-visit-panel__hint', text: tr('Só o nome, o papel, a ferramenta e o status de cada agente: o resto do escritório não sai do computador do dono.') }),
  );
  // near elevator: "Exit via elevator (E)", which is also a button (for mobile without keyboard)
  const exitHint = h('button', { class: 'ui-visit-exit', type: 'button', hidden: true, on: { click: () => exitByElevator() } }, h('kbd', { text: 'E' }), tr('Sair pelo elevador'));
  const help = h(
    'div',
    { class: 'ui-visit-help', attrs: { 'aria-hidden': 'true' } },
    h('span', {}, h('kbd', { text: 'WASD' }), ' ', tr('andar')),
    h('span', {}, h('kbd', { text: 'Shift' }), ' ', tr('correr')),
    h('span', {}, h('kbd', { text: tr('clique') }), ' ', tr('ir até lá')),
    h('span', {}, h('kbd', { text: 'E' }), ' ', tr('elevador')),
    h('span', {}, h('kbd', { text: 'Esc' }), ' ', tr('sair')),
  );
  const leaving = h('div', { class: 'ui-visit-leaving', hidden: true, role: 'status', text: tr('Saindo do prédio…') });
  // lobby stamp board overlaid on reception wall plaque (tracks camera each frame)
  const boardPins = h('div', { class: 'ui-visit-board__pins' });
  const board = h('div', { class: 'ui-visit-board', hidden: true, role: 'img' }, boardPins);
  const layer = h('div', { class: 'ui-visit' }, board, bar, panel, exitHint, help, leaving);
  o.uiRoot.append(layer);
  // alerts from local machine office continue alongside panel
  o.uiRoot.classList.add('is-visit');

  const social = mountVisitSocial(socialBox, {
    building: () => (destroyed ? null : controller.detail.building),
    mine: () => o.mine,
    send: (cmds) => o.send(cmds),
    toast: (text) => o.toast(text),
  });

  let boardSig = '';
  /** Board stamps: user's stamp today (visitor) or summary stamps (in own building). */
  function renderBoard(): void {
    const mine = social.stampedToday();
    const entries = o.mine ? (o.summaryStamps?.() ?? []).map((e) => ({ stampId: e.stampId, count: e.count })) : mine ? [{ stampId: mine, mine: true }] : [];
    const sig = JSON.stringify(entries);
    if (sig === boardSig) return;
    boardSig = sig;
    const pins = stampBoard(entries, hash32(controller.id));
    boardPins.replaceChildren(
      ...pins.map((p) =>
        h('span', {
          class: `ui-visit-board__pin${p.mine ? ' is-mine' : ''}`,
          text: p.icon,
          title: stampPinTitle(p),
          attrs: { style: `left:${(p.x * 100).toFixed(1)}%;top:${(p.y * 100).toFixed(1)}%;--rot:${p.rot}deg` },
        }),
      ),
    );
    const label = pins.length ? `${tr('Carimbos da portaria')}: ${pins.map(stampPinTitle).join(', ')}` : tr('Carimbos da portaria: nenhum ainda');
    board.setAttribute('aria-label', label);
    board.title = label;
    board.classList.toggle('is-empty', !pins.length);
  }

  let roomsSig = '';
  function render(): void {
    if (destroyed) return;
    const d = controller.detail;
    const ban = visitBanner(d, o.mine);
    setText(title, ban.title);
    setText(details, ban.details.join(' · '));
    setHidden(mode, !ban.mode);
    setText(mode, ban.mode === 'away' ? `🌙 ${tr('apagado')}` : ban.mode === 'discreet' ? `🙈 ${tr('discreto')}` : '');
    mode.className = `ui-visit-bar__mode${ban.mode ? ` is-${ban.mode}` : ''}`;
    setText(visitors, d.visitors > 0 ? `👀 ${visitorsLabel(d.visitors)}` : '');
    setHidden(leaving, !controller.leaving);
    leaveBtn.disabled = controller.leaving;
    // host lighting and theme (local theme selection does not apply here)
    world.visit.setLight(controller.light);
    const t = d.building.theme;
    if (t !== theme) {
      theme = t;
      world.setOptions({ ...o.options(), theme: t === 'halloween' || t === 'christmas' ? t : 'none' });
    }
    const p = visitPanel(d);
    setHidden(emptyNote, !p.empty);
    setText(emptyNote, p.empty ?? '');
    const sig = JSON.stringify(p.rooms);
    if (sig !== roomsSig) {
      roomsSig = sig;
      roomsEl.replaceChildren(
        ...p.rooms.map((r) =>
          h(
            'li',
            { class: 'ui-visit-room' },
            h('div', { class: 'ui-visit-room__head' }, h('span', { class: 'ui-visit-room__name', text: r.name }), h('span', { class: 'ui-visit-room__count', text: String(r.agents.length) })),
            r.agents.length
              ? h(
                  'ul',
                  { class: 'ui-visit-room__agents' },
                  ...r.agents.map((a) =>
                    h(
                      'li',
                      {},
                      h(
                        'button',
                        { class: `ui-visit-agent is-${a.status}`, type: 'button', attrs: { 'data-agent': a.id }, on: { click: () => selectAgent(a.id) } },
                        h('span', { class: 'ui-visit-agent__dot', attrs: { 'aria-hidden': 'true' } }),
                        h('span', { class: 'ui-visit-agent__name', text: a.name }),
                        h('span', { class: 'ui-visit-agent__meta', text: `${a.role} · ${a.tool}` }),
                        h('span', { class: 'ui-visit-agent__status', text: a.statusText }),
                      ),
                    ),
                  ),
                )
              : null,
          ),
        ),
      );
    }
    renderCard();
    setText(panelBtn, `${tr('Salas')} (${d.floors.length})`);
    renderBoard();
    panelBtn.setAttribute('aria-expanded', String(panelOpen));
    layer.classList.toggle('has-panel', panelOpen);
    insets();
  }

  function renderCard(): void {
    const sel = world.getSelection();
    const a = sel?.type === 'agent' ? findAgent(controller.detail, sel.id) : null;
    setHidden(card, !a);
    if (!a) return;
    setText(cardName, a.name);
    setText(cardMeta, `${a.role} · ${a.tool}`);
    setText(cardStatus, a.statusText);
    cardStatus.className = `ui-visit-card__status is-${a.status}`;
    setText(cardRoom, a.room);
    for (const b of roomsEl.querySelectorAll<HTMLElement>('.ui-visit-agent')) b.classList.toggle('is-selected', b.dataset.agent === a.id);
  }

  function selectAgent(id: string | null): void {
    if (!id) return world.select(null);
    world.select({ type: 'agent', id }, { focus: true });
  }

  function setPanel(open: boolean): void {
    panelOpen = open;
    render();
  }

  /** Free world area: below banner and beside (or above, on mobile) panel. */
  function insets(): void {
    layer.style.setProperty('--ui-visit-top', `${Math.round(o.topInset() + 8)}px`);
    const top = bar.getBoundingClientRect().bottom || o.topInset() + 56;
    const pr = panel.getBoundingClientRect();
    world.setViewInsets?.({
      top: top + 4,
      right: panelOpen && !narrow() ? Math.max(0, window.innerWidth - pr.left) : 0,
      bottom: panelOpen && narrow() ? Math.max(0, window.innerHeight - pr.top) : 0,
      left: 0,
    });
  }

  const offSelect = world.onSelect(() => renderCard());

  // ------------------------------------------------------------------ teclado e elevador

  const keys = new Set<string>();
  let shift = false;
  const pushIntent = () => world.visit.setIntent(controller.leaving ? { dx: 0, dy: 0, run: false } : intentFrom(keys, shift));
  const isTyping = (t: EventTarget | null) => {
    const el = t as HTMLElement | null;
    return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? ''));
  };
  const onKey = (e: KeyboardEvent, down: boolean) => {
    if (e.key === 'Shift') shift = down;
    else if (typeof e.getModifierState === 'function') shift = e.getModifierState('Shift');
    const k = moveKeyOf(e);
    if (!down) {
      if (k) keys.delete(k);
      pushIntent();
      return;
    }
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target) || modalOpen(e.target as HTMLElement | null)) return;
    if (k) {
      e.preventDefault();
      keys.add(k);
      pushIntent();
      return;
    }
    if (e.key === 'e' || e.key === 'E' || (e.key === 'Enter' && !(e.target as HTMLElement | null)?.closest?.('button, a'))) {
      e.preventDefault();
      exitByElevator();
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      world.zoomBy(1.25);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      world.zoomBy(1 / 1.25);
    } else if (e.key === '0') {
      e.preventDefault();
      world.overview();
    }
  };
  const onDown = (e: KeyboardEvent) => onKey(e, true);
  const onUp = (e: KeyboardEvent) => onKey(e, false);
  const clearKeys = () => {
    keys.clear();
    shift = false;
    pushIntent();
  };
  addEventListener('keydown', onDown);
  addEventListener('keyup', onUp);
  addEventListener('blur', clearKeys);
  const onResize = () => insets();
  addEventListener('resize', onResize);
  narrowMq?.addEventListener('change', onResize);

  /** In elevator: visitor enters and disappears; `leave` dispatches when door closes. */
  function exitByElevator(): void {
    if (controller.leaving) return;
    if (!world.visit.atExit()) return;
    if (world.visit.exit(() => leave())) {
      keys.clear();
      pushIntent();
    }
  }

  function leave(): void {
    if (!controller.leave()) return;
    keys.clear();
    pushIntent();
    leaveTimer = setTimeout(() => {
      leaveTimer = null;
      if (!destroyed) o.stuck();
    }, LEAVE_TIMEOUT_MS);
  }

  // tooltip "Exit via elevator (E)" follows visitor
  const tick = () => {
    raf = requestAnimationFrame(tick);
    const show = !controller.leaving && world.visit.atExit();
    const at = show ? world.visit.visitorScreen() : null;
    setHidden(exitHint, !at);
    // stamp board: only rendered when reception is onscreen and large enough to read
    const r = world.visit.boardScreen();
    const fits = !!r && r.h >= 18;
    setHidden(board, !fits);
    if (r && fits) {
      board.style.transform = `translate(${Math.round(r.x)}px, ${Math.round(r.y)}px)`;
      board.style.width = `${Math.round(r.w)}px`;
      board.style.height = `${Math.round(r.h)}px`;
      board.style.setProperty('--pin', `${Math.max(8, Math.round(r.h * 0.3))}px`);
    }
    if (at) {
      // above head, keeping within screen bounds
      const w = exitHint.offsetWidth || 150;
      const x = Math.max(8, Math.min(window.innerWidth - w - 8, at.x - w / 2));
      exitHint.style.transform = `translate(${Math.round(x)}px, ${Math.round(at.y - 34)}px)`;
    }
  };
  raf = requestAnimationFrame(tick);
  render();
  requestAnimationFrame(() => insets());

  return {
    id: controller.id,
    controller,
    world,
    replace(inside) {
      controller.replace(inside);
      social.sync();
    },
    patch(msg) {
      controller.patch(msg);
      // optimistic like is only rebuilt when building (likes, likedByMe) arrives in patch
      if (msg.building) social.sync();
    },
    message(msg) {
      if (destroyed) return false;
      const handled = social.message(msg);
      renderBoard();
      return handled;
    },
    leave,
    escape() {
      if (world.getSelection()) {
        world.select(null);
        return true;
      }
      if (narrow() && panelOpen) {
        setPanel(false);
        return true;
      }
      leave();
      return true;
    },
    openPanel(open = true) {
      setPanel(open);
    },
    selectAgent,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (leaveTimer) clearTimeout(leaveTimer);
      cancelAnimationFrame(raf);
      offSelect();
      social.destroy();
      removeEventListener('keydown', onDown);
      removeEventListener('keyup', onUp);
      removeEventListener('blur', clearKeys);
      removeEventListener('resize', onResize);
      narrowMq?.removeEventListener('change', onResize);
      world.destroy();
      canvas.remove();
      layer.remove();
      o.uiRoot.classList.remove('is-visit');
      // after world: no visit wallet writes occur after cleanup
      clearWorldWallets(browserStorage());
    },
  };
}

