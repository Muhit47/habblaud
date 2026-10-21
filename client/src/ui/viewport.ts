// Unobscured office viewport area: screen space uncovered by UI panels.
// Measures top bar, sidebar, drawer, and feed, notifying world engine (setViewInsets) so overview
// framing and camera focus (agent, room, follow) frame only visible viewport. Exposes CSS variables
// (--free-top/right/bottom/left) to anchor empty states and notifications.
//
// Interaction details:
// - drawer opened via canvas click delays viewport re-framing until double-click window expires
//   (preventing camera shifts between 1st and 2nd clicks from spoiling double-clicks); during guard,
//   drawer allows pointer events to pass through to canvas;
// - selections opened "with focus" (sidebar, feed, notice, Center, double-click) maintain focus lock
//   across free-area adjustments until user initiates camera pan/zoom.
import type { Selection, ViewInsets, WorldApi } from '../world/api';

/** Inset margin between panel edge and framed viewport content (CSS px). */
export const INSET_GAP = 8;
/** Double-click guard delay: drawer opened on first click delays viewport re-framing. */
export const DBLCLICK_GUARD_MS = 380;
/** Minimum free area: on tiny viewports panel margins compress to preserve viewport usability. */
export const MIN_FREE = 120;
/** World camera transition duration (+ margin) before verifying agent visibility. */
const CAMERA_SETTLE_MS = 480;
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_PX = 24;
const DRAG_PX = 6;
/** Default and minimum width for toast notifications (CSS px). */
const TOAST_W = 344;
const TOAST_MIN_W = 280;
const CAMERA_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'a', 'A', 'd', 'D', 'w', 'W', 's', 'S', '+', '=', '-', '_', '0', 'o', 'O']);

/** Final panel layout geometry (excluding active open/close transitions), relative to viewport (CSS px). */
export interface PanelGeometry {
  vw: number;
  vh: number;
  /** Bottom edge of top bar. */
  topBottom: number;
  /** Right edge of open sidebar. */
  sideRight: number;
  /** Left and top edges of open drawer. */
  drawerLeft: number;
  drawerTop: number;
  /** Drawer rendered as bottom sheet (mobile) rather than right column. */
  drawerSheet: boolean;
  /** Height of open and collapsed feed, and its offset from bottom edge. */
  feedOpenH: number;
  feedClosedH: number;
  feedMargin: number;
}

export interface PanelFlags {
  sidebar: boolean;
  feed: boolean;
  drawer: boolean;
  /** Narrow screen: sidebar renders as modal overlay (with backdrop) and does not inset viewport. */
  narrow: boolean;
}

function shrinkPair(a: number, b: number, total: number): [number, number] {
  const free = total - a - b;
  if (free >= MIN_FREE || a + b <= 0) return [a, b];
  const room = Math.max(0, total - MIN_FREE);
  const k = room / (a + b);
  return [Math.floor(a * k), Math.floor(b * k)];
}

/** Viewport margins obscured by UI (pure: tested in viewport.test.ts). */
export function computeInsets(g: PanelGeometry, f: PanelFlags, gap = INSET_GAP): ViewInsets {
  const top = Math.max(0, g.topBottom) + gap;
  const left = f.sidebar && !f.narrow ? Math.max(0, g.sideRight) + gap : 0;
  const right = f.drawer && !g.drawerSheet ? Math.max(0, g.vw - g.drawerLeft) + gap : 0;
  const feedH = f.feed ? g.feedOpenH : g.feedClosedH;
  let bottom = feedH > 0 ? feedH + g.feedMargin + gap : 0;
  if (f.drawer && g.drawerSheet) bottom = Math.max(bottom, g.vh - g.drawerTop + gap);
  const [l, r] = shrinkPair(left, right, g.vw);
  const [t, b] = shrinkPair(top, bottom, g.vh);
  return { top: Math.round(t), right: Math.round(r), bottom: Math.round(b), left: Math.round(l) };
}

export function sameInsets(a: ViewInsets | null, b: ViewInsets): boolean {
  return !!a && Math.abs(a.top - b.top) < 1 && Math.abs(a.right - b.right) < 1 && Math.abs(a.bottom - b.bottom) < 1 && Math.abs(a.left - b.left) < 1;
}

export function sameSelection(a: Selection, b: Selection): boolean {
  return a === b || (!!a && !!b && a.type === b.type && a.id === b.id);
}

export interface FreeAreaPanels {
  root: HTMLElement;
  topbar: HTMLElement;
  sidebar: HTMLElement;
  drawer: HTMLElement;
  feed: HTMLElement;
}

/** `follow: 'option'` tracks active "follow selected" pref; `true` = double click (always follows). */
type FocusIntent = { sel: NonNullable<Selection>; follow: boolean | 'option' };

const isCanvas = (t: EventTarget | null): t is HTMLCanvasElement => t instanceof HTMLCanvasElement;

function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
}

export class FreeArea {
  private applied: ViewInsets | null = null;
  private probe: HTMLElement;
  private probeFeedOpen: HTMLElement;
  private probeFeedClosed: HTMLElement;
  private probeGap: HTMLElement;
  private guardTimer: ReturnType<typeof setTimeout> | null = null;
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  private intent: FocusIntent | null = null;
  private toastPlace = '';
  private raf = 0;
  private down: { x: number; y: number; id: number } | null = null;
  private lastTap = { t: 0, x: 0, y: 0 };

  constructor(
    private world: WorldApi,
    private panels: FreeAreaPanels,
    private flags: () => PanelFlags,
  ) {
    // Hidden DOM probe: resolves media-query CSS variables into pixels without waiting on transitions.
    this.probeFeedOpen = document.createElement('span');
    this.probeFeedClosed = document.createElement('span');
    this.probeGap = document.createElement('span');
    this.probeFeedOpen.className = 'ui-probe__feed-open';
    this.probeFeedClosed.className = 'ui-probe__feed-closed';
    this.probeGap.className = 'ui-probe__gap';
    this.probe = document.createElement('div');
    this.probe.className = 'ui-probe';
    this.probe.setAttribute('aria-hidden', 'true');
    this.probe.append(this.probeFeedOpen, this.probeFeedClosed, this.probeGap);
    panels.root.append(this.probe);

    addEventListener('resize', () => this.schedule());
    // Feed width/position animates on panel toggle: reposition toasts on transition completion.
    panels.feed.addEventListener('transitionend', (e) => {
      if (e.target === panels.feed) this.schedule();
    });
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => this.schedule());
      ro.observe(panels.topbar);
      ro.observe(this.probeFeedOpen);
      ro.observe(this.probeGap);
      ro.observe(panels.sidebar);
      ro.observe(panels.drawer);
    }
    this.watchCanvas();
  }

  /** Current insets reported to world engine. */
  get insets(): ViewInsets {
    return this.applied ?? { top: 0, right: 0, bottom: 0, left: 0 };
  }

  /** Indicates if drawer is within double-click guard window (not yet insetting viewport). */
  get guarding(): boolean {
    return this.guardTimer !== null;
  }

  /** Schedules re-measurement on next animation frame (coalesces duplicate frame events). */
  schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.sync();
    });
  }

  /**
   * Measures layout, informs world engine, and synchronizes CSS variables on change.
   * `refocus: false` when caller immediately triggers custom camera focus with new insets.
   */
  sync(opts: { refocus?: boolean } = {}): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    const f = this.flags();
    const g = this.measure();
    const insets = computeInsets(g, { ...f, drawer: f.drawer && !this.guarding });
    this.placeToasts(insets, g);
    if (sameInsets(this.applied, insets)) return;
    this.applied = insets;
    const s = this.panels.root.style;
    s.setProperty('--free-top', `${insets.top}px`);
    s.setProperty('--free-right', `${insets.right}px`);
    s.setProperty('--free-bottom', `${insets.bottom}px`);
    s.setProperty('--free-left', `${insets.left}px`);
    try {
      this.world.setViewInsets?.(insets);
    } catch (err) {
      console.error('[ui] setViewInsets falhou', err);
    }
    if (opts.refocus !== false) this.refocus();
  }

  /**
   * Toasts: positioned in bottom-right corner beside feed when clearance exists outside
   * framed building; otherwise stacked above feed/bottom sheet. Always left of drawer.
   */
  private placeToasts(ins: ViewInsets, g: PanelGeometry): void {
    const feed = this.panels.feed;
    const right = Math.max(g.feedMargin, ins.right);
    const beside = g.vw - right - (feed.offsetLeft + feed.offsetWidth) - g.feedMargin;
    const corner = !g.drawerSheet && beside >= TOAST_MIN_W;
    const bottom = corner ? g.feedMargin : ins.bottom;
    const width = corner ? Math.min(TOAST_W, beside) : Math.min(TOAST_W, Math.max(240, g.vw - right - Math.max(g.feedMargin, ins.left)));
    const key = `${bottom}|${width}`;
    if (key === this.toastPlace) return;
    this.toastPlace = key;
    this.panels.root.style.setProperty('--toast-bottom', `${bottom}px`);
    this.panels.root.style.setProperty('--toast-w', `${Math.round(width)}px`);
  }

  // ---------------------------------------------------------------- focus

  /** Selection initiated with focus (sidebar, feed, notice, Center): re-applies focus when free area shifts. */
  setIntent(sel: NonNullable<Selection>, follow: boolean | 'option' = 'option'): void {
    this.intent = { sel, follow };
  }

  clearIntent(): void {
    this.intent = null;
  }

  /** Selection changed outside UI (canvas click, agent departed). */
  selectionChangedExternally(prev: Selection, sel: Selection): void {
    if (this.intent && !sameSelection(this.intent.sel, sel)) this.intent = null;
    if (!prev && sel) this.beginGuard();
    else if (!sel) this.endGuard(false);
  }

  /** Selection initiated by UI: drawer insets immediately (subsequent focus uses correct area). */
  selectingFromUi(): void {
    this.endGuard(false);
  }

  private refocus(): void {
    const it = this.intent;
    if (!it || !sameSelection(it.sel, this.world.getSelection())) return;
    if (it.sel.type === 'agent') this.world.focusAgent(it.sel.id, { follow: it.follow === 'option' ? this.world.getOptions().followSelected : it.follow });
    else this.world.focusRoom(it.sel.id);
  }

  // ---------------------------------------------------------------- double-click guard window

  private beginGuard(): void {
    this.endGuard(false);
    this.panels.drawer.classList.add('is-opening');
    this.guardTimer = setTimeout(() => this.endGuard(true), DBLCLICK_GUARD_MS);
  }

  private endGuard(check: boolean): void {
    if (this.guardTimer === null) return;
    clearTimeout(this.guardTimer);
    this.guardTimer = null;
    this.panels.drawer.classList.remove('is-opening');
    this.sync();
    if (check) this.ensureVisibleSoon();
  }

  /** After camera settles: if selected agent ended up outside free area, pan camera to reveal it. */
  private ensureVisibleSoon(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null;
      const sel = this.world.getSelection();
      if (sel?.type !== 'agent' || this.intent) return;
      const p = this.world.screenPositionOf(sel.id);
      const i = this.insets;
      const visible = !!p && p.x >= i.left && p.x <= innerWidth - i.right && p.y >= i.top && p.y <= innerHeight - i.bottom;
      if (!visible) this.world.focusAgent(sel.id, { follow: this.world.getOptions().followSelected });
    }, CAMERA_SETTLE_MS);
  }

  /** Double click/tap on canvas: world focused target; UI assumes focus maintenance lock. */
  private onDoubleActivate(): void {
    const sel = this.world.getSelection();
    if (!sel) return;
    // Double click on agent = focus and follow; on room = frame room.
    this.intent = { sel, follow: sel.type === 'agent' };
    if (this.guarding) this.endGuard(false);
  }

  // ---------------------------------------------------------------- camera interaction

  private watchCanvas(): void {
    addEventListener('dblclick', (e) => isCanvas(e.target) && this.onDoubleActivate());
    addEventListener(
      'pointerdown',
      (e) => {
        this.down = isCanvas(e.target) ? { x: e.clientX, y: e.clientY, id: e.pointerId } : null;
      },
      true,
    );
    addEventListener(
      'pointermove',
      (e) => {
        if (!this.down || e.buttons === 0) return;
        if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > DRAG_PX) {
          // Dragged (or pinched): user assumed manual camera control.
          this.intent = null;
          this.down = null;
          this.lastTap.t = 0;
        }
      },
      true,
    );
    addEventListener(
      'pointerup',
      (e) => {
        const d = this.down;
        this.down = null;
        if (!d || !isCanvas(e.target) || e.pointerType === 'mouse') return;
        // Double tap detection (browsers suppress dblclick on touch-action: none).
        const now = performance.now();
        if (now - this.lastTap.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < DOUBLE_TAP_PX) {
          this.lastTap.t = 0;
          // World processes touch on same event: await selection/focus application.
          queueMicrotask(() => this.onDoubleActivate());
        } else {
          this.lastTap = { t: now, x: e.clientX, y: e.clientY };
        }
      },
      true,
    );
    addEventListener('wheel', (e) => isCanvas(e.target) && (this.intent = null), { capture: true, passive: true });
    addEventListener(
      'keydown',
      (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
        if (CAMERA_KEYS.has(e.key)) this.intent = null;
      },
      true,
    );
  }

  // ---------------------------------------------------------------- measurement

  /** Layout metrics (offset*) unaffected by open/close CSS animation transforms. */
  private measure(): PanelGeometry {
    const { topbar, sidebar, drawer } = this.panels;
    const vw = innerWidth;
    const vh = innerHeight;
    const drawerSheet = drawer.offsetWidth >= vw - 40 && drawer.offsetTop > topbar.offsetHeight + 40;
    return {
      vw,
      vh,
      topBottom: topbar.offsetTop + topbar.offsetHeight,
      sideRight: sidebar.offsetLeft + sidebar.offsetWidth,
      drawerLeft: drawer.offsetLeft,
      drawerTop: drawer.offsetTop,
      drawerSheet,
      feedOpenH: this.probeFeedOpen.offsetHeight,
      feedClosedH: this.probeFeedClosed.offsetHeight,
      feedMargin: this.probeGap.offsetWidth,
    };
  }
}
