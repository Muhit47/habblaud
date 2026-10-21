// SCREEN-SPACE pass (crisp text rendered at native device resolution): nameplates with
// account badges, activity speech bubbles, room names, plaque texts, and selection highlights.
//
// Layout: floating UI elements (plaques, pills, bubbles, nameplates) compete for screen space.
// Items are POSITIONED in descending priority order (lower priority items yield, fall back
// to icon only, or drop) and DRAWN in ascending order (highest priority rendered on top).
import { TILE } from '../../art/api';
import type { WorldOptions } from '../api';
import type { Camera } from '../camera';
import { COL_W, CORRIDOR_Y, SOUTH_Y } from '../constants';
import type { Character } from '../sim/character';
import { shellAgeKey, shellBubbleAlpha, shellBubbleText, STORM_LIFT, unitHash } from '../sim/shell';
import type { Sim } from '../sim/sim';
import { buildAnim } from './anim';
import { drawFxBanner } from './github-fx';
import type { HeadInfo, Renderer } from './renderer';
import { tr } from '../../../../shared/i18n';

// Pixelify Sans has near-closed capital "C" (reads "Oopa" instead of "Copa") across
// canvas weights; world text overlays utilize system UI fonts for reliable legibility.
const UI_FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';
const LABEL_FONT = `600 10.5px ${UI_FONT}`;
const BUBBLE_FONT = `500 11.5px ${UI_FONT}`;
const SAY_FONT = `500 10.5px ${UI_FONT}`;
const FLOAT_FONT = `800 12px ${UI_FONT}`;
const CHIP_FONT = `700 8px ${UI_FONT}`;
const BADGE_FONT = `700 8px ${UI_FONT}`;
const ROOM_FONT = `700 12px ${UI_FONT}`;
const CORE_FONT = `600 11px ${UI_FONT}`;
const CORE_FONT_SMALL = `600 9.5px ${UI_FONT}`;
const signFont = (size: number) => `700 ${size}px ${UI_FONT}`;

/** Maximum speech bubble width (alerts are wider: actionable description). */
export const BUBBLE_MAX_W = 220;
export const ALERT_MAX_W = 340;
const BUBBLE_H = 20;
const LABEL_H = 15;
const RECENT_MS = 4000;
/** Minimum plaque height (CSS px) on screen to render text inside it. */
const SIGN_MIN_PX = 14;
/** Below this zoom (overview), activity bubbles are throttled. */
export const OVERVIEW_ZOOM = 1.8;
/** Below this zoom (full building on small screens), only alerts/deliveries as icons. */
export const TINY_ZOOM = 0.6;
/** In overview: text bubbles budgeted per area (room, core, corridor segment) and in total. */
const OVERVIEW_PER_ROOM = 1;
const OVERVIEW_TOTAL = 4;

const CORE_NAMES: Record<string, string> = {
  'core:recepcao': tr('Recepção'),
  'core:banheiros': tr('Banheiros'),
  'core:copa': tr('Copa'),
  'core:lounge': tr('Lounge'),
  'core:dorm_antigravity': 'Antigravity Dorm',
  'core:dorm_kilo': 'Kilo Dorm',
};

/** 'shell' = waiting on shell: dark terminal bubble with green text. 'say' = gathering dialogue (chat, cheers, bets). */
type Tone = 'info' | 'alert' | 'deliver' | 'shell' | 'say';
/** Maximum width for gathering speech bubbles (narrower than activity bubbles). */
export const SAY_MAX_W = 170;
const SAY_H = 17;
/** Icon for shell wait speech bubble. */
export const SHELL_BUBBLE_ICON = '⏳';

interface Bubble {
  type: 'bubble';
  ch: Character;
  head: HeadInfo;
  icon: string;
  text: string;
  tone: Tone;
  prio: number;
  alpha: number;
  /** Icon only (text omitted): overview, layout collisions, and compact screens. */
  chip: boolean;
  /** Extra elevation (CSS px) when character nameplate is situated overhead. */
  extraLift: number;
  /** Recency ordering (newest activity prioritized in layout budgeting). */
  changedAt: number;
  // geometria resolvida no posicionamento
  x: number;
  y: number;
  w: number;
  h: number;
  /** Pre-clipped text for target width. */
  fitted: string;
  /** Stepped upward to avoid collision: speech tail extends down to head. */
  lifted: boolean;
}

interface Label {
  type: 'label';
  ch: Character;
  head: HeadInfo;
  prio: number;
  /** Nameplate situated overhead (for characters facing camera behind a desk). */
  above: boolean;
  compact: boolean;
  /** Whether nameplate is expanded (full name + badges) or minimal chip. */
  isExpanded: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

type Item = Bubble | Label;

/** Relative luminance of hex color (0..1). */
/** Outlined chip background for Codex accounts (matches UI panels). */
const CODEX_CHIP_BG = '#161b26';
/** "CODEX" badge on nameplates: subtle frosted glass, uncolored. */
const CODEX_BADGE = 'CODEX';

/** Stepped octagon (chamfered square resembling a rounded pixel). */
function steppedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(x + s, y);
  ctx.lineTo(x + w - s, y);
  ctx.lineTo(x + w, y + s);
  ctx.lineTo(x + w, y + h - s);
  ctx.lineTo(x + w - s, y + h);
  ctx.lineTo(x + s, y + h);
  ctx.lineTo(x, y + h - s);
  ctx.lineTo(x, y + s);
  ctx.closePath();
}

/**
 * Account indicator dot (room plaques and pills): filled for Claude Code; outlined (ring in account color) for Codex,
 * matching panel chip styling.
 */
function accountDot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, acc: { color: string; provider?: string }): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (acc.provider === 'codex') {
    ctx.fillStyle = CODEX_CHIP_BG;
    ctx.fill();
    ctx.lineWidth = Math.max(1.2, r * 0.55);
    ctx.strokeStyle = acc.color;
    ctx.beginPath();
    ctx.arc(x, y, r - ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  ctx.fillStyle = acc.color;
  ctx.fill();
}

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/** Height (world px) occupied by overhead status icons: bubbles and nameplates offset above them. */
export function headIconLift(ch: Pick<Character, 'mode' | 'icon'>): number {
  if (ch.icon === 'storm') return 13 + STORM_LIFT;
  return ch.mode === 'wait' || ch.mode === 'shell' || ch.icon ? 13 : 0;
}

/** Wait bubble text: reason only (yellow styling and ✋ already communicate "needs attention"). */
export function waitBubbleText(waitingFor: string | undefined): string {
  const why = (waitingFor ?? '').trim().replace(/^precisa de você:?\s*/i, '');
  return why ? why.charAt(0).toUpperCase() + why.slice(1) : tr('Responder no terminal');
}

/**
 * Speech bubble rationing in overview: preserves text for the `perRoom` most recent
 * in each room (up to `total` across viewport); remaining reduce to icon only.
 * Returns indices (within input array) retaining full text. Pure (testable).
 */
export function rationBubbles(items: readonly { room: string; prio: number; changedAt: number }[], perRoom: number, total: number): Set<number> {
  const order = items.map((_, i) => i).sort((a, b) => items[b].prio - items[a].prio || items[b].changedAt - items[a].changedAt);
  const keep = new Set<number>();
  const byRoom = new Map<string, number>();
  for (const i of order) {
    if (keep.size >= total) break;
    const n = byRoom.get(items[i].room) ?? 0;
    if (n >= perRoom) continue;
    byRoom.set(items[i].room, n + 1);
    keep.add(i);
  }
  return keep;
}

export class Overlay {
  private widths = new Map<string, number>();
  private fitted = new Map<string, string>();
  private placed: number[] = [];
  private items: Item[] = [];
  /** Scratch objects reused across frames (zero hot-path allocations). */
  private bubblePool: Bubble[] = [];
  private labelPool: Label[] = [];
  private nb = 0;
  private nl = 0;
  private rationIn: { room: string; prio: number; changedAt: number }[] = [];
  private rationIdx: Bubble[] = [];
  /** Current frame world -> screen transform (CSS px). */
  private k = 1;
  private ox = 0;
  private oy = 0;
  private zoom = 1;

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly sim: Sim,
    private readonly renderer: Renderer,
    private readonly camera: Camera,
  ) {}

  /** Flushes cached text measurements (e.g. font load completion). */
  resetCaches(): void {
    this.widths.clear();
    this.fitted.clear();
  }

  private measure(font: string, text: string): number {
    const key = `${font}|${text}`;
    let w = this.widths.get(key);
    if (w === undefined) {
      if (this.widths.size > 4000) this.widths.clear();
      this.ctx.font = font;
      w = this.ctx.measureText(text).width;
      this.widths.set(key, w);
    }
    return w;
  }

  /** Truncates text with ellipsis to fit within `maxW` px. */
  private fit(font: string, text: string, maxW: number): string {
    const key = `${font}|${maxW}|${text}`;
    const hit = this.fitted.get(key);
    if (hit !== undefined) return hit;
    if (this.fitted.size > 2000) this.fitted.clear();
    let out = text;
    if (this.measure(font, text) > maxW) {
      let lo = 0;
      let hi = text.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (this.measure(font, `${text.slice(0, mid).trimEnd()}…`) <= maxW) lo = mid;
        else hi = mid - 1;
      }
      out = lo > 0 ? `${text.slice(0, lo).trimEnd()}…` : '';
    }
    this.fitted.set(key, out);
    return out;
  }

  /** Screen x/y (CSS px) of world coordinates via current frame transform. */
  private sx(wx: number): number {
    return wx * this.k + this.ox;
  }

  private sy(wy: number): number {
    return wy * this.k + this.oy;
  }

  private overlaps(x: number, y: number, w: number, h: number): boolean {
    const p = this.placed;
    for (let i = 0; i < p.length; i += 4) {
      if (x < p[i] + p[i + 2] && x + w > p[i] && y < p[i + 1] + p[i + 3] && y + h > p[i + 1]) return true;
    }
    return false;
  }

  private place(x: number, y: number, w: number, h: number): void {
    this.placed.push(x, y, w, h);
  }

  draw(now: number, opts: WorldOptions, sel: { agent: string | null; room: string | null; hover: string | null }): void {
    const { ctx, camera } = this;
    const dpr = camera.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textBaseline = 'middle';
    this.placed.length = 0;
    const t = camera.transform();
    this.k = t.scale / dpr;
    this.ox = t.ox / dpr;
    this.oy = t.oy / dpr;
    this.nb = 0;
    this.nl = 0;
    const zoom = (this.zoom = camera.zoom);
    const vw = camera.viewW;
    const vh = camera.viewH;

    // ---- room selection
    if (sel.room) {
      const room = this.sim.rooms.get(sel.room);
      if (room && room.present) {
        const r = room.layout.rect;
        const ax = this.sx(r.x * TILE);
        const ay = this.sy(r.y * TILE);
        const bx = this.sx((r.x + r.w) * TILE);
        const by = this.sy((r.y + r.h) * TILE);
        ctx.save();
        ctx.strokeStyle = room.theme.accent;
        ctx.lineWidth = 2.5;
        ctx.globalAlpha = 0.85 + Math.sin(now / 300) * 0.15;
        ctx.beginPath();
        ctx.roundRect(ax - 2, ay - 2, bx - ax + 4, by - ay + 4, 6);
        ctx.stroke();
        ctx.restore();
      }
    }

    // plaques and pills first: static and large; bubbles and nameplates navigate around them
    this.drawRoomTexts(now, zoom);
    this.drawFxBanners(now, zoom);

    // ---- collect bubbles and nameplates for visible characters
    const items = this.items;
    items.length = 0;
    const heads = this.renderer.heads;
    const showAll = opts.showNames && zoom >= 0.99;
    for (const ch of this.sim.people()) {
      const head = heads.get(ch.id);
      if (!head || !head.visible) continue;
      const hx = this.sx(head.x);
      const hy = this.sy(head.y);
      if (hx < -120 || hx > vw + 120 || hy < -60 || hy > vh + 80) continue;
      const selected = sel.agent === ch.id;
      const hovered = sel.hover === ch.id;
      // visitor (Visit scene) always displays name and badge
      const visitor = ch === this.sim.visitor;
      const labeled = selected || hovered || ch.mode === 'wait' || showAll || visitor;
      const above = labeled && this.labelAbove(ch);
      const b = this.bubbleFor(ch, head, now, opts, selected, hovered);
      if (b) {
        b.extraLift = above ? LABEL_H + 3 : 0;
        items.push(b);
      }
      if (labeled) {
        const prio = selected ? 100 : hovered ? 95 : visitor ? 92 : ch.mode === 'wait' ? 90 : ch.info.kind === 'main' ? 50 : 40;
        let l = this.labelPool[this.nl];
        if (!l) this.labelPool[this.nl] = l = { type: 'label', ch, head, prio, above, compact: false, isExpanded: false, x: 0, y: 0, w: 0, h: 0 };
        else {
          l.ch = ch;
          l.head = head;
          l.prio = prio;
          l.above = above;
        }
        l.compact = zoom < 2.5 && !selected && !hovered;
        l.isExpanded = selected || hovered;
        this.nl++;
        items.push(l);
      }
    }

    this.ration(zoom);

    // ---- position (descending priority) and render (ascending: top priority on top)
    items.sort((a, b) => b.prio - a.prio || (a.type === b.type ? a.head.feetY - b.head.feetY : a.type === 'bubble' ? -1 : 1));
    let n = 0;
    for (const it of items) {
      const ok = it.type === 'bubble' ? this.placeBubble(it) : this.placeLabel(it);
      if (ok) items[n++] = it;
    }
    items.length = n;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.type === 'bubble') this.drawBubble(it, now);
      else this.drawLabel(it, sel);
    }
    this.drawChats(now);
    this.drawFloaters(now);
    ctx.textBaseline = 'alphabetic';
  }

  /** Characters facing camera behind a desk: feet-level nameplate would occlude colleague monitor. */
  private labelAbove(ch: Character): boolean {
    if (!ch.seated || ch.dir !== 'down' || !ch.atSpot) return false;
    const spot = this.sim.spots.get(ch.atSpot);
    return !!spot && spot.kind === 'desk';
  }

  /** Zoom-based rationing: overview with sparse text; compact screens show critical icons only. */
  private ration(zoom: number): void {
    const items = this.items;
    if (zoom < TINY_ZOOM) {
      let n = 0;
      for (const it of items) {
        if (it.type === 'bubble') {
          // regular activity and dialogue hidden; alert, delivery, shell wait, and selection show icon only
          if ((it.tone === 'info' && it.prio < 75) || it.tone === 'say') continue;
          it.chip = true;
        }
        items[n++] = it;
      }
      items.length = n;
      return;
    }
    if (zoom >= OVERVIEW_ZOOM) return;
    const rin = this.rationIn;
    const idx = this.rationIdx;
    rin.length = 0;
    idx.length = 0;
    for (const it of items) {
      if (it.type !== 'bubble' || (it.tone !== 'info' && it.tone !== 'shell' && it.tone !== 'say') || it.prio >= 75) continue;
      // keyed by PHYSICAL area (current character position) to manage visual crowding
      const ch = it.ch;
      rin.push({ room: `${Math.floor(ch.tx / COL_W)}:${ch.ty < CORRIDOR_Y ? 'n' : ch.ty < SOUTH_Y ? 'c' : 's'}`, prio: it.prio, changedAt: it.changedAt });
      idx.push(it);
    }
    if (!idx.length) return;
    const keep = rationBubbles(rin, OVERVIEW_PER_ROOM, OVERVIEW_TOTAL);
    for (let i = 0; i < idx.length; i++) if (!keep.has(i)) idx[i].chip = true;
  }

  // =================================================================== salas

  private drawRoomTexts(now: number, zoom: number): void {
    const { camera } = this;
    const vw = camera.viewW;
    const vh = camera.viewH;
    // column width on screen: pills must not overlap adjacent columns
    const colW = COL_W * TILE * zoom;
    for (const vis of this.renderer.areas.values()) {
      const room = vis.room;
      const r = vis.layout.rect;
      const anim = room ? buildAnim(room.phase, room.progress(now)) : null;
      // plaque text rendered when large enough to read; otherwise floating room name
      const rect = this.renderer.signRect(vis);
      const text = room ? room.info.name : vis.id === 'core:recepcao' ? 'Habblaud' : null;
      const readable = !!rect && rect.h * zoom >= SIGN_MIN_PX;
      if (readable && rect && text && (!anim || anim.sign >= 1)) {
        const ax = this.sx(rect.x);
        const ay = this.sy(rect.y);
        const w = rect.w * zoom;
        const h = rect.h * zoom;
        if (ax + w > 0 && ax < vw && ay + h > 0 && ay < vh) {
          this.drawSignText(text, ax, ay, w, h, this.renderer.signIsDark(vis), room?.accounts ?? []);
          this.place(ax, ay, w, h);
        }
      }
      if (room ? readable : zoom >= 1.4) continue;
      const cx = this.sx((r.x + r.w / 2) * TILE);
      const cy = this.sy(r.y * TILE + 6);
      if (cx < -200 || cx > vw + 200 || cy < -40 || cy > vh + 40) continue;
      if (room) {
        // former address during relocation: name already displayed in new room
        if (!room.present || room.ghost || (anim && anim.walls < 0.6)) continue;
        this.drawRoomPill(room.info.name, cx, cy, colW - 8, room.accounts, this.countIn(room.id), room.theme.accent, room.lightOn);
      } else if (CORE_NAMES[vis.id]) {
        this.drawCorePill(CORE_NAMES[vis.id], cx, cy, colW - 8);
      }
    }
  }

  /** Height of overhead icons, including "!" CI failure bubble (render/github-fx.ts). */
  private iconLift(ch: Character): number {
    const lift = headIconLift(ch);
    return this.sim.roomFx.active.size && this.sim.roomFx.alarmOwner(ch.id, this.sim.now) ? Math.max(lift, 13) : lift;
  }

  /** Celebration/alarm banner (GitHub events) at top of floor for each affected room. */
  private drawFxBanners(now: number, zoom: number): void {
    const fxs = this.sim.roomFx.active;
    if (!fxs.size) return;
    const { camera } = this;
    for (const fx of fxs.values()) {
      const room = this.sim.rooms.get(fx.roomId);
      if (!room || !room.present || now >= fx.end) continue;
      const r = room.layout.rect;
      const cx = this.sx((r.x + r.w / 2) * TILE);
      const top = this.sy((r.y + 2) * TILE) + 4;
      if (cx < -200 || cx > camera.viewW + 200 || top < -40 || top > camera.viewH + 40) continue;
      const b = drawFxBanner(this.ctx, fx, cx, top, r.w * TILE * zoom - 12, now, (f, t, w) => this.fit(f, t, w), (f, t) => this.measure(f, t));
      if (b) this.place(b.x, b.y, b.w, b.h);
    }
  }

  private countIn(roomId: string): number {
    let n = 0;
    for (const c of this.sim.chars.values()) if (c.roomId === roomId && !c.leaving) n++;
    return n;
  }

  private drawSignText(text: string, x: number, y: number, w: number, h: number, dark: boolean, accounts: string[]): void {
    const { ctx } = this;
    // scales font down to 7px; below that, clips with ellipsis
    let size = Math.min(18, Math.max(7, Math.floor(h * 0.72)));
    let font = signFont(size);
    while (size > 7 && this.measure(font, text) > w - 4) {
      size--;
      font = signFont(size);
    }
    const t = this.fit(font, text, w - 4);
    ctx.font = font;
    ctx.textAlign = 'center';
    const cx = Math.round(x + w / 2);
    const cy = Math.round(y + h / 2) + 0.5;
    ctx.fillStyle = dark ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.45)';
    ctx.fillText(t, cx, cy + 1);
    ctx.fillStyle = dark ? '#f5f1e6' : '#26303e';
    ctx.fillText(t, cx, cy);
    ctx.textAlign = 'left';
    // present accounts: colored dots in corner of nameplate
    const r = Math.max(2.5, Math.min(4, h * 0.22));
    let dx = x + w + r + 3;
    for (const id of accounts) {
      const acc = this.sim.accounts.get(id);
      if (!acc) continue;
      accountDot(ctx, dx, y + h / 2, r, acc);
      ctx.beginPath();
      ctx.arc(dx, y + h / 2, r, 0, Math.PI * 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(20,24,36,0.65)';
      ctx.stroke();
      dx += r * 2 + 2;
    }
  }

  private drawRoomPill(name: string, cx: number, cy: number, maxW: number, accounts: string[], count: number, accent: string, lit: boolean): void {
    const { ctx } = this;
    let logo: { letter: string; color: string } | null = null;
    let displayText = name;
    if (name.startsWith('Antigravity')) {
      logo = { letter: 'A', color: '#2563eb' };
      displayText = name.replace(/^Antigravity\s*/i, '') || 'Office';
    } else if (name.startsWith('Kilo')) {
      logo = { letter: 'K', color: '#7c3aed' };
      displayText = name.replace(/^Kilo\s*/i, '') || 'Office';
    }

    let dots = accounts.filter((a) => this.sim.accounts.has(a));
    let countText = count > 0 ? String(count) : '';
    let cw = countText ? this.measure(LABEL_FONT, countText) + 14 : 0;
    
    const chipSpace = logo ? 16 : 0;
    
    // room name clipped to column width; under tight constraints, name takes precedence
    // over count and dots; if less than 3 letters fit, compact pill (count only)
    let text = this.fit(ROOM_FONT, displayText, Math.min(180, maxW - (18 + dots.length * 10 + cw + chipSpace)));
    if (text.length < Math.min(7, displayText.length)) {
      const alone = this.fit(ROOM_FONT, displayText, maxW - 18 - chipSpace);
      if (alone.length >= 4) {
        text = alone;
        dots = [];
        countText = '';
        cw = 0;
      }
    }
    const extras = 18 + dots.length * 10 + cw + chipSpace;
    // Converts to compact pill only when name had to be truncated (short names fit intact).
    const compact = text !== displayText && text.length < 4;
    const tw = compact ? 0 : this.measure(ROOM_FONT, text);
    const w = Math.round(compact ? Math.max(12, 10 + cw + dots.length * 10 + chipSpace) : tw + extras);
    const h = 22;
    const x = Math.round(cx - w / 2);
    const y = Math.round(cy - h - 4);
    ctx.save();
    ctx.globalAlpha = lit ? 1 : 0.8;
    ctx.fillStyle = 'rgba(16,20,32,0.28)';
    ctx.beginPath();
    ctx.roundRect(x, y + 2, w, h, 7);
    ctx.fill();
    ctx.fillStyle = 'rgba(22,27,40,0.9)';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 7);
    ctx.fill();
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.roundRect(x, y, 4, h, [7, 0, 0, 7]);
    ctx.fill();
    
    let dx = x + 10;
    if (logo) {
      ctx.beginPath();
      ctx.arc(dx + 5.5, y + h / 2, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = logo.color;
      ctx.fill();
      ctx.font = CHIP_FONT;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.fillText(logo.letter, dx + 5.5, y + h / 2 + 0.5);
      ctx.textAlign = 'left';
      dx += 16;
    }
    
    if (!compact) {
      ctx.font = ROOM_FONT;
      ctx.fillStyle = '#f3f5fa';
      ctx.fillText(text, dx, y + h / 2 + 1);
      dx += tw + 8;
    }
    for (const id of dots) {
      accountDot(ctx, dx + 3, y + h / 2, 3.5, this.sim.accounts.get(id)!);
      dx += 10;
    }
    if (countText) {
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.beginPath();
      ctx.roundRect(dx + 2, y + 4, cw - 4, h - 8, 5);
      ctx.fill();
      ctx.font = LABEL_FONT;
      ctx.fillStyle = '#dfe5f2';
      ctx.fillText(countText, dx + 7, y + h / 2 + 0.5);
    }
    ctx.restore();
    this.place(x, y, w, h);
  }

  private drawCorePill(name: string, cx: number, cy: number, maxW: number): void {
    const { ctx } = this;
    
    let logo: { letter: string; color: string } | null = null;
    let displayText = name;
    if (name === 'Antigravity Dorm') {
      logo = { letter: 'A', color: '#2563eb' };
      displayText = 'Dorm';
    } else if (name === 'Kilo Dorm') {
      logo = { letter: 'K', color: '#7c3aed' };
      displayText = 'Dorm';
    }
    
    const chipSpace = logo ? 16 : 0;
    
    // slightly smaller font size before truncating name
    const font = this.measure(CORE_FONT, displayText) <= maxW - 14 - chipSpace ? CORE_FONT : CORE_FONT_SMALL;
    const text = this.fit(font, displayText, maxW - 14 - chipSpace);
    if (text.length < 3) return;
    
    const tw = this.measure(font, text);
    const w = Math.round(tw + 14 + chipSpace);
    const h = 18;
    const x = Math.round(cx - w / 2);
    const y = Math.round(cy - h - 4);
    ctx.fillStyle = 'rgba(22,27,40,0.62)';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 6);
    ctx.fill();
    
    let dx = x + 7;
    if (logo) {
      ctx.beginPath();
      ctx.arc(dx + 5, y + h / 2, 5, 0, Math.PI * 2);
      ctx.fillStyle = logo.color;
      ctx.fill();
      ctx.font = CHIP_FONT;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.fillText(logo.letter, dx + 5, y + h / 2 + 0.5);
      ctx.textAlign = 'left';
      dx += 16;
    }
    
    ctx.font = font;
    ctx.fillStyle = '#e8ecf5';
    ctx.fillText(text, dx, y + h / 2 + 1);
    this.place(x, y, w, h);
  }

  // =================================================================== speech bubbles

  private takeBubble(ch: Character, head: HeadInfo, icon: string, text: string, tone: Tone, prio: number, alpha: number, changedAt: number): Bubble {
    let b = this.bubblePool[this.nb];
    if (!b) {
      b = { type: 'bubble', ch, head, icon, text, tone, prio, alpha, chip: false, extraLift: 0, changedAt, x: 0, y: 0, w: 0, h: 0, fitted: '', lifted: false };
      this.bubblePool[this.nb] = b;
    } else {
      b.ch = ch;
      b.head = head;
      b.icon = icon;
      b.text = text;
      b.tone = tone;
      b.prio = prio;
      b.alpha = alpha;
      b.chip = false;
      b.extraLift = 0;
      b.changedAt = changedAt;
      b.lifted = false;
    }
    this.nb++;
    return b;
  }

  private bubbleFor(ch: Character, head: HeadInfo, now: number, opts: WorldOptions, selected: boolean, hovered: boolean): Bubble | null {
    if (opts.bubbles === 'none') return null;
    if (ch.mode === 'wait') return this.takeBubble(ch, head, '✋', this.sim.visit ? tr('Esperando o dono') : waitBubbleText(ch.info.waitingFor), 'alert', 100, 1, now);
    if (ch.bubbleText && now < ch.bubbleUntil) {
      const a = Math.min(1, (now - ch.bubbleAt) / 150, (ch.bubbleUntil - now) / 400);
      return this.takeBubble(ch, head, ch.bubbleIcon, ch.bubbleText, 'deliver', 90, a, ch.bubbleAt);
    }
    // gathering speech bubbles (invite, chat, cheering, bets): concise atop recent activity
    if (ch.sayText && now < ch.sayUntil && !ch.leaving) {
      const a = Math.min(1, (now - ch.sayAt) / 120, (ch.sayUntil - now) / 300);
      return this.takeBubble(ch, head, sayIcon(ch.sayText), ch.sayText, 'say', 55, a, ch.sayAt);
    }
    const act = ch.info.activity;
    if (ch.mode === 'shell' && ch.shellSince > 0 && !ch.leaving) {
      const sb = this.shellBubble(ch, head, now, opts, selected, hovered);
      if (sb) return sb;
    }
    if (!act || ch.leaving) return null;
    const age = now - ch.activityChangedAt;
    if (selected) return this.takeBubble(ch, head, act.icon, act.text, 'info', 80, 1, ch.activityChangedAt);
    if (hovered) return this.takeBubble(ch, head, act.icon, act.text, 'info', 75, 1, ch.activityChangedAt);
    if (opts.bubbles === 'all' && ch.mode === 'work') return this.takeBubble(ch, head, act.icon, act.text, 'info', age < RECENT_MS ? 50 : 30, 1, ch.activityChangedAt);
    if (age < RECENT_MS && ch.activityChangedAt > 0) {
      const a = Math.min(1, age / 150, (RECENT_MS - age) / 500);
      return this.takeBubble(ch, head, act.icon, act.text, 'info', 50, a, ch.activityChangedAt);
    }
    return null;
  }

  /**
   * "⏳ <label> · <time>" bubble for shell waiting. Mode 'all': continuous; 'important': upon entering
   * state and for 4 s every ~30 s; selected/hover: continuous. New activity (e.g. recent
   * shell completion) takes precedence while recent.
   */
  private shellBubble(ch: Character, head: HeadInfo, now: number, opts: WorldOptions, selected: boolean, hovered: boolean): Bubble | null {
    const recent = now - ch.activityChangedAt < RECENT_MS && ch.activityChangedAt > ch.shellEnteredAt + 500;
    if (recent && !selected && !hovered) return null;
    const text = this.shellText(ch, now);
    if (selected) return this.takeBubble(ch, head, SHELL_BUBBLE_ICON, text, 'shell', 80, 1, ch.shellEnteredAt);
    if (hovered) return this.takeBubble(ch, head, SHELL_BUBBLE_ICON, text, 'shell', 75, 1, ch.shellEnteredAt);
    if (opts.bubbles === 'all') return this.takeBubble(ch, head, SHELL_BUBBLE_ICON, text, 'shell', 45, 1, ch.shellEnteredAt);
    // individual cadence per character (prevents synchronized room flashing)
    const a = shellBubbleAlpha(now - ch.shellEnteredAt, unitHash(ch.info.seed, 0, 3) * 9000);
    return a > 0.01 ? this.takeBubble(ch, head, SHELL_BUBBLE_ICON, text, 'shell', 50, a, ch.shellEnteredAt) : null;
  }

  /** Shell bubble text, recreated only when displayed time updates (not every frame). */
  private shellText(ch: Character, now: number): string {
    // visit: label only, timer omitted (timing not provided by world)
    if (this.sim.visit) return ch.shellLabel;
    const age = now - ch.shellSince;
    const key = shellAgeKey(age);
    if (key !== ch.shellTextKey || !ch.shellText) {
      ch.shellTextKey = key;
      ch.shellText = shellBubbleText(ch.shellLabel, age);
    }
    return ch.shellText;
  }

  /** Computes bubble bounds (full or icon-only) at default position above head. */
  private layoutBubble(b: Bubble): void {
    const { camera } = this;
    // above overhead icon (when present), which is rendered in world space
    const lift = Math.max(1, this.iconLift(b.ch)) * this.zoom + b.extraLift;
    const headX = this.sx(b.head.x);
    const headY = this.sy(b.head.y);
    const say = b.tone === 'say';
    const iconW = b.icon && !say ? this.measure(BUBBLE_FONT, b.icon) + 4 : 0;
    if (b.chip || !b.text) {
      b.fitted = '';
      b.w = Math.round(Math.max(20, (say ? this.measure(BUBBLE_FONT, b.icon) + 4 : iconW) + 10));
    } else if (say) {
      b.fitted = this.fit(SAY_FONT, b.text, SAY_MAX_W - 14);
      b.w = Math.round(Math.min(SAY_MAX_W, this.measure(SAY_FONT, b.fitted) + 14));
    } else {
      const maxW = b.tone === 'alert' ? ALERT_MAX_W : BUBBLE_MAX_W;
      b.fitted = this.fit(BUBBLE_FONT, b.text, maxW - 16 - iconW);
      b.w = Math.round(Math.min(maxW, this.measure(BUBBLE_FONT, b.fitted) + iconW + 14));
    }
    b.h = say && !b.chip ? SAY_H : BUBBLE_H;
    b.x = Math.max(4, Math.min(camera.viewW - b.w - 4, Math.round(headX - b.w / 2)));
    b.y = Math.round(headY - lift - b.h - 6);
  }

  /** Positions bubble avoiding visual overlap. Returns false if bubble should be suppressed. */
  private placeBubble(b: Bubble): boolean {
    this.layoutBubble(b);
    if (!this.overlaps(b.x, b.y, b.w, b.h)) {
      this.place(b.x, b.y, b.w, b.h);
      return true;
    }
    if (b.tone === 'alert') {
      // alert is never suppressed: steps up one level (elongated tail to head) or renders atop
      const up = b.y - b.h - 6;
      if (!this.overlaps(b.x, up, b.w, b.h)) {
        b.y = up;
        b.lifted = true;
      }
      this.place(b.x, b.y, b.w, b.h);
      return true;
    }
    if (!b.chip) {
      // text does not fit: fall back to icon-only at same location
      b.chip = true;
      this.layoutBubble(b);
      if (!this.overlaps(b.x, b.y, b.w, b.h)) {
        this.place(b.x, b.y, b.w, b.h);
        return true;
      }
    }
    return false;
  }

  private drawBubble(b: Bubble, now: number): void {
    const { ctx } = this;
    const { x, y, w, h } = b;
    const headX = this.sx(b.head.x);
    const tone = b.tone;
    const bg = tone === 'alert' ? '#ffcf4a' : tone === 'deliver' ? '#e2f0ff' : tone === 'shell' ? '#1d2433' : tone === 'say' ? '#ffffff' : '#fffdf8';
    const border = tone === 'alert' ? '#c58f10' : tone === 'deliver' ? '#7aa7d9' : tone === 'shell' ? '#4b5d7e' : tone === 'say' ? 'rgba(40,48,66,0.38)' : 'rgba(40,48,66,0.22)';
    const fg = tone === 'alert' ? '#3b2a00' : tone === 'deliver' ? '#17324f' : tone === 'shell' ? '#b9f6b4' : tone === 'say' ? '#1d2330' : '#232a36';
    const pulse = tone === 'alert' ? 1 + Math.sin(now / 160) * 0.035 : 1;
    ctx.save();
    ctx.globalAlpha = b.alpha;
    if (b.lifted) {
      // connector line down to standard tail position (bubble displaced upward)
      const tx = Math.max(x + 8, Math.min(x + w - 8, Math.round(headX)));
      ctx.strokeStyle = border;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(tx + 0.5, y + h);
      ctx.lineTo(tx + 0.5, y + 2 * h + 11);
      ctx.stroke();
    }
    if (pulse !== 1) {
      ctx.translate(headX, y + h);
      ctx.scale(pulse, pulse);
      ctx.translate(-headX, -(y + h));
    }
    const tailX = Math.max(x + 8, Math.min(x + w - 8, Math.round(headX)));
    // sombra
    ctx.fillStyle = 'rgba(16,20,32,0.22)';
    ctx.beginPath();
    ctx.roundRect(x, y + 2, w, h, 7);
    ctx.fill();
    // corpo + rabicho
    ctx.fillStyle = bg;
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 7);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tailX - 4.5, y + h - 1);
    ctx.lineTo(tailX, y + h + 5);
    ctx.lineTo(tailX + 4.5, y + h - 1);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(tailX - 4.5, y + h - 0.5);
    ctx.lineTo(tailX, y + h + 5);
    ctx.lineTo(tailX + 4.5, y + h - 0.5);
    ctx.stroke();
    ctx.fillStyle = bg;
    ctx.fillRect(tailX - 4, y + h - 2, 8, 2);
    // content
    ctx.font = tone === 'say' && !b.chip ? SAY_FONT : BUBBLE_FONT;
    ctx.fillStyle = fg;
    if (tone === 'say' && !b.chip && b.fitted) {
      ctx.textAlign = 'center';
      ctx.fillText(b.fitted, x + w / 2, y + h / 2 + 1);
      ctx.textAlign = 'left';
    } else if (b.chip || !b.fitted) {
      ctx.textAlign = 'center';
      ctx.fillText(b.icon || '…', x + w / 2, y + h / 2 + 1);
      ctx.textAlign = 'left';
    } else {
      let tx = x + 7;
      if (b.icon) {
        ctx.fillText(b.icon, tx, y + h / 2 + 1);
        tx += this.measure(BUBBLE_FONT, b.icon) + 4;
      }
      ctx.fillText(b.fitted, tx, y + h / 2 + 1);
    }
    ctx.restore();
  }

  /** Conversation mini-bubbles (emoji only). */
  private drawChats(now: number): void {
    const { ctx } = this;
    for (const ch of this.sim.chars.values()) {
      if (!ch.chatEmoji || now > ch.chatUntil) continue;
      const head = this.renderer.heads.get(ch.id);
      if (!head || !head.visible) continue;
      const px = this.sx(head.x);
      const py = this.sy(head.y);
      const k = Math.min(1, (ch.chatUntil - now) / 300, 1 - (ch.chatUntil - now - 1000) / 200);
      const r = 12;
      const side = ch.dir === 'left' ? -1 : 1;
      const x = Math.round(px + side * 12);
      const y = Math.round(py - 16 - (1 - Math.min(1, k)) * 4);
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, k));
      ctx.fillStyle = 'rgba(16,20,32,0.2)';
      ctx.beginPath();
      ctx.arc(x, y + 1.5, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.moveTo(x - side * 4, y + r - 2);
      ctx.lineTo(x - side * 9, y + r + 4);
      ctx.lineTo(x - side * 1, y + r - 1);
      ctx.fill();
      ctx.font = `14px ${UI_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(ch.chatEmoji, x, y + 1);
      ctx.textAlign = 'left';
      ctx.restore();
    }
  }

  /** "+🪙10" subindo e sumindo sobre quem ganhou (ou "−🪙10" sobre quem perdeu). */
  private drawFloaters(now: number): void {
    const fl = this.sim.social.floaters;
    if (!fl.length || this.zoom < TINY_ZOOM) return;
    const { ctx } = this;
    ctx.save();
    ctx.font = FLOAT_FONT;
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    for (const f of fl) {
      const head = this.renderer.heads.get(f.charId);
      if (!head || !head.visible || now < f.at) continue;
      const t = Math.min(1, (now - f.at) / (f.until - f.at));
      // beside head (dialogue bubble sits above), drifting upward
      const x = Math.round(this.sx(head.x) + 10 * this.zoom + 12);
      const y = Math.round(this.sy(head.y) + 4 * this.zoom - t * 24);
      ctx.globalAlpha = t < 0.12 ? t / 0.12 : Math.max(0, 1 - Math.max(0, t - 0.6) / 0.4);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(20,24,36,0.85)';
      ctx.strokeText(f.text, x, y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, x, y);
    }
    ctx.restore();
  }

  // =================================================================== etiquetas

  /** Width of nameplate sub-components. "CODEX" badge (like "SUB") appears only outside compact mode. */
  private labelWidth(l: Label): { nameW: number; chipW: number; badgeW: number; codexW: number } {
    if (!l.isExpanded) return { nameW: 0, chipW: 12, badgeW: 0, codexW: 0 };
    const ch = l.ch;
    const acc = this.sim.accounts.get(ch.info.account);
    const nameW = this.measure(LABEL_FONT, ch.info.name);
    const chipW = acc ? 13 : 0;
    const visitor = ch === this.sim.visitor;
    const badgeW = visitor ? this.measure(BADGE_FONT, visitorBadge()) + 7 : ch.info.kind === 'sub' && !l.compact ? this.measure(BADGE_FONT, 'SUB') + 7 : 0;
    const codexW = ch.info.provider === 'codex' && !l.compact ? this.measure(BADGE_FONT, CODEX_BADGE) + 7 : 0;
    return { nameW, chipW, badgeW, codexW };
  }

  /** Positions nameplate: at feet (or above head); if colliding, attempts opposite side. */
  private placeLabel(l: Label): boolean {
    const { nameW, chipW, badgeW, codexW } = this.labelWidth(l);
    let w: number;
    let h: number;
    if (!l.isExpanded) {
      w = 16;
      h = 16;
    } else {
      w = Math.round(nameW + 10 + chipW + (badgeW ? badgeW + 3 : 0) + (codexW ? codexW + 3 : 0));
      h = LABEL_H;
    }
    const x = Math.round(this.sx(l.head.x) - w / 2);
    const below = Math.round(this.sy(l.head.feetY) + 3);
    const iconLift = this.iconLift(l.ch) * this.zoom;
    const over = Math.round(this.sy(l.head.y) - iconLift - h - 3);
    const first = l.above ? over : below;
    const second = l.above ? below : over;
    l.w = w;
    l.h = h;
    l.x = x;
    if (!this.overlaps(x, first, w, h)) l.y = first;
    else if (!this.overlaps(x, second, w, h)) l.y = second;
    else if (l.prio >= 90) l.y = first;
    else return false;
    this.place(l.x, l.y, w, h);
    return true;
  }

  private drawLabel(l: Label, sel: { agent: string | null; hover: string | null }): void {
    const { ctx } = this;
    const ch = l.ch;
    const acc = this.sim.accounts.get(ch.info.account);
    const { x, y, w, h } = l;
    const selected = sel.agent === ch.id;
    ctx.fillStyle = selected ? 'rgba(18,96,140,0.95)' : ch.mode === 'wait' ? 'rgba(120,78,0,0.92)' : 'rgba(22,26,38,0.82)';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, h / 2);
    ctx.fill();

    if (!l.isExpanded) {
      const provider = ch.info.provider ?? acc?.provider ?? 'claude';
      let letter: string;
      let color: string;
      switch (provider) {
        case 'antigravity': letter = 'A'; color = '#2563eb'; break;
        case 'kilo': letter = 'K'; color = '#7c3aed'; break;
        case 'codex': letter = 'X'; color = '#a77bf3'; break;
        case 'claude':
        default: letter = 'C'; color = '#f08a3c'; break;
      }
      const cx = x + w / 2;
      const cy = y + h / 2;
      const r = 5;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `700 9px ${UI_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(letter, cx, cy + 0.5);
      ctx.textAlign = 'left';
      return;
    }

    const { nameW, chipW, badgeW, codexW } = this.labelWidth(l);

    let cx = x + (chipW ? chipW / 2 + 5 : 0);
    if (chipW) {
      cx = x + 7;
      let cy = y + h / 2;
      if (ch.info.provider === 'codex' || (acc && acc.provider === 'codex')) {
        steppedRect(ctx, cx - 5, cy - 5, 10, 10, 2);
        ctx.fillStyle = CODEX_CHIP_BG;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = acc?.color ?? '#ffffff';
        steppedRect(ctx, cx - 5 + 0.75, cy - 5 + 0.75, 8.5, 8.5, 1.6);
        ctx.stroke();
        ctx.font = CHIP_FONT;
        ctx.textAlign = 'center';
        ctx.fillStyle = acc?.color ?? '#ffffff';
        ctx.fillText(acc?.short.slice(0, 1) ?? '?', cx, cy + 0.5);
      } else if (acc) {
        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.fillStyle = acc.color;
        ctx.fill();
        ctx.font = CHIP_FONT;
        ctx.textAlign = 'center';
        ctx.fillStyle = luminance(acc.color) > 0.62 ? '#1d2330' : '#ffffff';
        ctx.fillText(acc.short.slice(0, 1), cx, cy + 0.5);
      }
      cx = x + chipW + 10;
    } else {
      cx = x + 5;
    }

    ctx.font = LABEL_FONT;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f5f7fb';
    ctx.fillText(ch.info.name, cx, y + h / 2 + 4);
    cx += nameW;

    if (badgeW) {
      const visitor = ch === this.sim.visitor;
      ctx.fillStyle = visitor ? '#c59a6f' : '#3a4a6d';
      ctx.beginPath();
      ctx.roundRect(cx + 3, y + 2, badgeW, h - 4, 3);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = BADGE_FONT;
      ctx.fillText(visitor ? visitorBadge() : 'SUB', cx + 6, y + h / 2 + 4);
      cx += badgeW + 3;
    }
    if (codexW) {
      ctx.fillStyle = '#3a4a6d';
      ctx.beginPath();
      ctx.roundRect(cx + 3, y + 2, codexW, h - 4, 3);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = BADGE_FONT;
      ctx.fillText(CODEX_BADGE, cx + 6, y + h / 2 + 4);
    }
  }
}

/** Dialogue icon when reduced to compact chip (overview): first emoji in text, or 💬. */
export function sayIcon(text: string): string {
  const m = /\p{Extended_Pictographic}(?:\uFE0F)?/u.exec(text);
  return m ? m[0] : '💬';
}

/** Selo da etiqueta do visitante (cena Visita), no lugar do "SUB". */
export function visitorBadge(): string {
  return tr('visitante').toLocaleUpperCase();
}
