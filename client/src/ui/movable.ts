// Movable windows: dragging the title bar unpins the panel from its default dock (makes it "floating");
// pulling any edge or corner resizes (and also unpins); double-clicking the title bar docks it back.
// Position and dimensions are persisted in the browser (localStorage, per panel). On narrow viewports, panels stay docked.
import { ICONS } from './icons';
import { tr } from '../../../shared/i18n';

const DRAG_THRESHOLD = 4;
/** How much of the window must remain visible on screen. */
const KEEP_VISIBLE = 80;
const MIN_W = 300;
const MIN_H = 160;

/** Edges and corners that resize: n/s adjust top/bottom, e/w adjust right/left. */
const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type Edge = (typeof EDGES)[number];

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MovableOptions {
  /** Key in localStorage. */
  key: string;
  /** Can it float now? (false on narrow screens). */
  enabled?: () => boolean;
  /** Invoked when unpinning or docking the panel back. */
  onChange?: (floating: boolean) => void;
  /** Invoked after moving or resizing (e.g. re-fitting a terminal). */
  onMove?: () => void;
}

export class Movable {
  private box: Box | null = null;
  private max = false;
  private sizing: { id: number; edge: Edge; sx: number; sy: number; start: Box } | null = null;
  private drag: { id: number; dx: number; dy: number; sx: number; sy: number; moving: boolean } | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private el: HTMLElement,
    handle: HTMLElement,
    private opts: MovableOptions,
  ) {
    handle.classList.add('ui-move-handle');
    handle.addEventListener('pointerdown', (e) => this.onDown(e, handle));
    handle.addEventListener('pointermove', (e) => this.onMove(e));
    handle.addEventListener('pointerup', (e) => this.onUp(e, handle));
    handle.addEventListener('pointercancel', (e) => this.onUp(e, handle));
    handle.addEventListener('dblclick', (e) => {
      if (interactive(e.target)) return;
      if (this.max) this.toggleMaximize();
      else this.dock();
    });
    for (const edge of EDGES) el.append(this.edgeHandle(edge));
    const saved = load(opts.key);
    if (saved && this.allowed()) this.float(saved, false);
    addEventListener('resize', () => {
      // Narrow viewport: dock back without discarding saved coordinates, restored when viewport widens again.
      if (!this.allowed()) this.unfloat();
      else if (this.box) this.apply(this.box);
      else {
        const saved = load(opts.key);
        if (saved) this.float(saved, true);
      }
    });
    // Resized via corner handle (resize: both): persist new dimensions.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        if (!this.box || this.max || this.drag?.moving || this.sizing || this.el.hidden) return;
        const w = this.el.offsetWidth;
        const h = this.el.offsetHeight;
        if (!w || !h || (w === this.box.w && h === this.box.h)) return;
        this.box = { ...this.box, w, h };
        this.scheduleSave();
        this.opts.onMove?.();
      }).observe(el);
    }
  }

  get floating(): boolean {
    return this.box !== null;
  }

  /** Occupies entire Habblaud screen (on top of everything; not draggable). */
  get maximized(): boolean {
    return this.max;
  }

  toggleMaximize(force?: boolean): void {
    const next = force ?? !this.max;
    if (next === this.max) return;
    this.max = next;
    this.el.classList.toggle('is-max', next);
    this.opts.onMove?.();
  }

  /**
   * Re-reads saved position (another window with the same key might have changed) and applies it:
   * two windows taking turns in the same slot (the two terminals) remain consistently positioned.
   */
  restore(): void {
    const saved = load(this.opts.key);
    if (saved && this.allowed()) this.float(saved, false);
    else if (this.box) {
      this.box = null;
      this.el.classList.remove('is-floating');
      for (const p of ['left', 'top', 'width', 'height']) this.el.style.removeProperty(p);
    }
  }

  /** Docks back to default slot (and clears saved position). */
  dock(): void {
    if (!this.box) return;
    save(this.opts.key, null);
    this.unfloat();
  }

  /** Docks back to default slot without clearing saved position. */
  private unfloat(): void {
    if (!this.box) return;
    // A pending save timer would persist an outdated box (or overwrite the saved one).
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.box = null;
    this.el.classList.remove('is-floating');
    for (const p of ['left', 'top', 'width', 'height']) this.el.style.removeProperty(p);
    this.opts.onChange?.(false);
    this.opts.onMove?.();
  }

  /** Invisible handle on an edge/corner: dragging resizes window (unpinning it if docked). */
  private edgeHandle(edge: Edge): HTMLElement {
    const g = document.createElement('div');
    g.className = `ui-resize ui-resize--${edge}`;
    g.setAttribute('aria-hidden', 'true');
    g.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.max || !this.allowed()) return;
      e.preventDefault();
      e.stopPropagation();
      const r = this.el.getBoundingClientRect();
      if (!this.box) this.float({ x: r.left, y: r.top, w: r.width, h: r.height }, true);
      this.sizing = { id: e.pointerId, edge, sx: e.clientX, sy: e.clientY, start: { ...this.box! } };
      this.el.classList.add('is-resizing');
      g.setPointerCapture(e.pointerId);
    });
    g.addEventListener('pointermove', (e) => {
      const z = this.sizing;
      if (!z || z.id !== e.pointerId) return;
      const dx = e.clientX - z.sx;
      const dy = e.clientY - z.sy;
      const b = { ...z.start };
      if (edge.includes('e')) b.w = Math.max(MIN_W, z.start.w + dx);
      if (edge.includes('s')) b.h = Math.max(MIN_H, z.start.h + dy);
      if (edge.includes('w')) {
        b.w = Math.max(MIN_W, z.start.w - dx);
        b.x = z.start.x + z.start.w - b.w;
      }
      if (edge.includes('n')) {
        // Clamps at top boundary: past this point, the bottom edge would shift down.
        b.h = Math.max(MIN_H, Math.min(z.start.h - dy, z.start.y + z.start.h - this.minTop()));
        b.y = z.start.y + z.start.h - b.h;
      }
      this.apply(b);
    });
    const end = (e: PointerEvent) => {
      const z = this.sizing;
      if (!z || z.id !== e.pointerId) return;
      this.sizing = null;
      this.el.classList.remove('is-resizing');
      if (g.hasPointerCapture(e.pointerId)) g.releasePointerCapture(e.pointerId);
      this.scheduleSave();
      this.opts.onMove?.();
    };
    g.addEventListener('pointerup', end);
    g.addEventListener('pointercancel', end);
    return g;
  }

  private allowed(): boolean {
    return this.opts.enabled?.() ?? true;
  }

  private onDown(e: PointerEvent, handle: HTMLElement): void {
    if (e.button !== 0 || this.max || interactive(e.target) || !this.allowed()) return;
    const r = this.el.getBoundingClientRect();
    this.drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moving: false };
    handle.setPointerCapture(e.pointerId);
  }

  private onMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moving) {
      if (Math.abs(e.clientX - d.sx) < DRAG_THRESHOLD && Math.abs(e.clientY - d.sy) < DRAG_THRESHOLD) return;
      d.moving = true;
      const r = this.el.getBoundingClientRect();
      this.float({ x: r.left, y: r.top, w: r.width, h: r.height }, true);
      this.el.classList.add('is-dragging');
    }
    e.preventDefault();
    if (this.box) this.apply({ ...this.box, x: e.clientX - d.dx, y: e.clientY - d.dy });
  }

  private onUp(e: PointerEvent, handle: HTMLElement): void {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    if (!d.moving) return;
    this.el.classList.remove('is-dragging');
    this.scheduleSave();
    this.opts.onMove?.();
  }

  private float(b: Box, notify: boolean): void {
    const was = this.box !== null;
    this.el.classList.add('is-floating');
    this.apply(b);
    if (!was && notify) this.opts.onChange?.(true);
    else if (!was) queueMicrotask(() => this.opts.onChange?.(true));
  }

  /**
   * Top limit: just below the top bar, like docked panels. Above it, the window bar would be covered
   * and there would be nowhere to drag back from (or close, in the terminal).
   */
  private minTop(): number {
    const s = getComputedStyle(this.el);
    return (parseFloat(s.getPropertyValue('--top-h')) || 0) + (parseFloat(s.getPropertyValue('--gap')) || 0);
  }

  /** Applies box, keeping a piece of window (and bar) inside screen. */
  private apply(b: Box): void {
    const w = Math.max(MIN_W, Math.min(b.w, innerWidth));
    const x = Math.min(innerWidth - KEEP_VISIBLE, Math.max(KEEP_VISIBLE - w, b.x));
    // Top limit wins over bottom: in a window too low, bar remains reachable.
    const y = Math.max(this.minTop(), Math.min(innerHeight - MIN_H, b.y));
    // Height shrinks so window does not pass bottom edge.
    const h = Math.max(MIN_H, Math.min(b.h, innerHeight - y - 8));
    this.box = { x, y, w, h };
    const s = this.el.style;
    s.left = `${Math.round(x)}px`;
    s.top = `${Math.round(y)}px`;
    s.width = `${Math.round(w)}px`;
    s.height = `${Math.round(h)}px`;
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => save(this.opts.key, this.box), 250);
  }
}

/** "expand to full screen / restore" button for a movable window (the `get` returns its Movable). */
export function maximizeButton(get: () => Movable | undefined, onToggle?: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ui-icon-btn ui-icon-btn--sm ui-term__max';
  const sync = () => {
    const max = !!get()?.maximized;
    b.innerHTML = max ? ICONS.restore : ICONS.maximize;
    const label = max ? tr('Restaurar o tamanho') : tr('Expandir na tela toda');
    b.title = label;
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-pressed', String(max));
  };
  b.addEventListener('click', () => {
    get()?.toggleMaximize();
    sync();
    onToggle?.();
  });
  sync();
  return b;
}

/** Clicking button/field on bar does not drag. */
function interactive(t: EventTarget | null): boolean {
  return t instanceof Element && !!t.closest('button, a, input, select, textarea, [role="button"], kbd');
}

function load(key: string): Box | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<Box> | null;
    if (v && [v.x, v.y, v.w, v.h].every((n) => typeof n === 'number' && Number.isFinite(n))) return v as Box;
  } catch {
    // no storage
  }
  return null;
}

function save(key: string, b: Box | null): void {
  try {
    if (b) localStorage.setItem(key, JSON.stringify({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) }));
    else localStorage.removeItem(key);
  } catch {
    // no storage
  }
}
