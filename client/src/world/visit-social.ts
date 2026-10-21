// Lightweight social features INSIDE a visited building (Phase 5), wired by Visit scene (world/visit/index.ts):
//   const social = mountVisitSocial(panel, { building, mine, send, toast });
//   ...on each stream message: if (social.message(msg)) return;   // like.update and like/stamp notices
//   ...with new building (`building`, or patch `building`): social.sync(); on exit: social.destroy();
// - Like button (❤️ Like / 💔 Unlike, with total): from inside building, server accepts without doorstep distance check.
// - "Leave a stamp": 8 lobby stamps (ids only), one per building per UTC day (matching server). Stamp left
//   today is saved in this browser (localStorage) for button and reception board; server retains only
//   aggregate counts per stamp and day, never identity of who stamped.
// - Reception stamp board rendered in Visit scene: `stampBoard` provides pure deterministic model (stamp
//   placements on board, tilt, and icons); owners visiting own building can pass "While you were away"
//   stamps for agents to "find" at reception.
import { tr } from '../../../shared/i18n';
import type { WorldSceneCommand } from '../../../shared/world/api';
import type { StampId, WorldBuildingPublic } from '../../../shared/world/protocol';
import { STAMPS, STAMP_IDS, stampIcon, stampLabel } from '../../../shared/world/social-labels';
import { h, setHidden } from '../ui/dom';
import { RateGate } from './city/greetings';
import { browserStorage } from './social/wallet';
import './visit-social.css';

/** World notice immediately following command is its response. */
const PENDING_MS = 4_000;

/** UTC date ("2026-10-15") of an instant: stamps are limited to one per building per UTC day. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Key for today's stamp left by this browser on a building. */
export function stampKey(buildingId: string): string {
  return `habblaud:world-stamp:${buildingId}`;
}

/** Stamp this browser left today on building (or null), read from storage. */
export function stampedToday(raw: string | null, day: string): StampId | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { day?: unknown; stampId?: unknown };
    return v.day === day && (STAMP_IDS as readonly unknown[]).includes(v.stampId) ? (v.stampId as StampId) : null;
  } catch {
    return null;
  }
}

/**
 * Notice responding to a stamp action: `stamped` = confirmed (server confirmed; toast shown on stamp),
 * `already_done` = already stamped today, any other (too far, departed building, rate limit) = rejected.
 */
export function stampReply(text: string): 'ok' | 'already' | 'failed' {
  return text === 'stamped' ? 'ok' : text === 'already_done' ? 'already' : 'failed';
}

/** Stamp on reception board: position (0..1 on board), tilt (degrees), icon, and label. */
export interface StampPin {
  stampId: StampId;
  icon: string;
  label: string;
  count: number;
  /** Browser stamp (highlight). */
  mine: boolean;
  x: number;
  y: number;
  rot: number;
}

/**
 * Reception stamp board (pure model): up to `max` stamps in a 4-column grid, each with jitter
 * and tilt seeded deterministically (consistent board across frames), user's stamp placed first.
 */
export function stampBoard(entries: ReadonlyArray<{ stampId: StampId; count?: number; mine?: boolean }>, seed = 0, max = 8): StampPin[] {
  const sorted = [...entries].filter((e) => (STAMP_IDS as readonly string[]).includes(e.stampId)).sort((a, b) => Number(!!b.mine) - Number(!!a.mine) || (b.count ?? 1) - (a.count ?? 1));
  const cols = 4;
  const rows = Math.max(1, Math.ceil(Math.min(max, sorted.length) / cols));
  let r = (seed ^ 0x9e3779b9) >>> 0;
  const rnd = () => {
    r = (Math.imul(r ^ (r >>> 15), 2246822507) + 0x6d2b79f5) >>> 0;
    return ((r ^ (r >>> 13)) >>> 0) / 4294967296;
  };
  return sorted.slice(0, max).map((e, i) => {
    const c = i % cols;
    const row = Math.floor(i / cols);
    return {
      stampId: e.stampId,
      icon: stampIcon(e.stampId),
      label: stampLabel(e.stampId),
      count: Math.max(1, e.count ?? 1),
      mine: !!e.mine,
      x: (c + 0.5 + (rnd() - 0.5) * 0.35) / cols,
      y: (row + 0.5 + (rnd() - 0.5) * 0.3) / rows,
      rot: Math.round((rnd() - 0.5) * 24),
    };
  });
}

// ====================================================================== DOM

export interface VisitSocialApi {
  /** Visited building (interior `building`), or null when outside. */
  building(): WorldBuildingPublic | null;
  /** Is user's own building (owner preview mode): no like or stamp actions. */
  mine(): boolean;
  /** Dispatches scene stream commands (like, unlike, stamp). */
  send(cmds: WorldSceneCommand[]): void;
  /** Scene toast notice. */
  toast(text: string): void;
  now?(): number;
}

export interface VisitSocialHandle {
  readonly el: HTMLElement;
  /** World message: building `like.update` and notices responding to likes/stamps. true = handled. */
  message(msg: unknown): boolean;
  /** Different building (or updated instance): rebuilds buttons. */
  sync(): void;
  /** Stamp this browser left today in this building (reception board). */
  stampedToday(): StampId | null;
  destroy(): void;
}

/** Monta o Like e o "Deixar um carimbo" em `container` (o painel da cena Visita). */
export function mountVisitSocial(container: HTMLElement, api: VisitSocialApi): VisitSocialHandle {
  const now = () => api.now?.() ?? Date.now();
  // localStorage (without ui/prefs.ts: Visit scene does not import office UI)
  const store = browserStorage();
  let likes = 0;
  let liked = false;
  let id = '';
  let pending: { kind: 'like' | 'stamp'; at: number; stampId?: StampId } | null = null;
  // slightly below server 10/min rate limit (commands batch and may arrive concurrently)
  const likeGate = new RateGate(9, 400);

  const likeBtn = h('button', { class: 'ui-visit-social__like', type: 'button', on: { click: () => toggleLike() } });
  const stampBtn = h('button', { class: 'ui-visit-social__stamp', type: 'button', attrs: { 'aria-expanded': 'false' }, on: { click: () => togglePicker() } });
  const picker = h(
    'div',
    { class: 'ui-visit-social__picker', role: 'group', hidden: true, attrs: { 'aria-label': tr('Escolha um carimbo para a portaria') } },
    h('p', { class: 'ui-visit-social__hint', text: tr('Um carimbo por prédio por dia. O dono vê quantos de cada recebeu, nunca quem deixou.') }),
    h(
      'div',
      { class: 'ui-visit-social__grid' },
      ...STAMP_IDS.map((s) =>
        h(
          'button',
          { class: 'ui-visit-social__choice', type: 'button', title: stampLabel(s), attrs: { 'data-stamp': s }, on: { click: () => stamp(s) } },
          h('span', { class: 'ui-visit-social__choice-icon', text: STAMPS[s].icon, attrs: { 'aria-hidden': 'true' } }),
          h('span', { text: stampLabel(s) }),
        ),
      ),
    ),
  );
  const el = h('div', { class: 'ui-visit-social' }, h('div', { class: 'ui-visit-social__row' }, likeBtn, stampBtn), picker);
  container.append(el);

  const today = (): StampId | null => (id ? stampedToday(readStamp(id), utcDay(now())) : null);
  function readStamp(bid: string): string | null {
    try {
      return store?.getItem(stampKey(bid)) ?? null;
    } catch {
      return null;
    }
  }
  function writeStamp(bid: string, s: StampId | null): void {
    try {
      if (s) store?.setItem(stampKey(bid), JSON.stringify({ day: utcDay(now()), stampId: s }));
      else store?.removeItem?.(stampKey(bid));
    } catch {
      // no localStorage: lasts only until page is closed
    }
  }

  function paint(): void {
    const b = api.building();
    const mine = api.mine();
    setHidden(el, !b || mine);
    if (!b) return;
    likeBtn.replaceChildren(h('span', { text: liked ? '💔' : '❤️', attrs: { 'aria-hidden': 'true' } }), ` ${liked ? tr('Descurtir') : tr('Curtir')}`, h('b', { class: 'ui-visit-social__count', text: String(likes) }));
    likeBtn.classList.toggle('is-liked', liked);
    likeBtn.title = liked ? tr('Desfazer o like no prédio de {0}', [b.owner.name]) : tr('Curtir o prédio de {0}', [b.owner.name]);
    const s = today();
    stampBtn.disabled = !!s;
    stampBtn.replaceChildren(h('span', { text: s ? stampIcon(s) : '📮', attrs: { 'aria-hidden': 'true' } }), ` ${s ? tr('Carimbo de hoje: {0}', [stampLabel(s)]) : tr('Deixar um carimbo')}`);
    if (s) closePicker();
  }

  function sync(): void {
    const b = api.building();
    if (b && b.id !== id) {
      id = b.id;
      closePicker();
    }
    if (b) {
      likes = b.likes;
      liked = b.likedByMe === true;
    }
    paint();
  }

  function toggleLike(): void {
    const b = api.building();
    if (!b || api.mine()) return;
    if (!likeGate.take(now())) {
      api.toast(tr('Devagar com os likes: espere um pouquinho.'));
      return;
    }
    const on = !liked;
    api.send([{ t: on ? 'like' : 'unlike', buildingId: b.id }]);
    pending = { kind: 'like', at: now() };
    // otimista: o like.update confirma (ou corrige)
    liked = on;
    likes = Math.max(0, likes + (on ? 1 : -1));
    likeBtn.classList.remove('is-pop');
    void likeBtn.offsetWidth;
    if (on) likeBtn.classList.add('is-pop');
    paint();
  }

  function closePicker(): void {
    setHidden(picker, true);
    stampBtn.setAttribute('aria-expanded', 'false');
  }

  function togglePicker(): void {
    if (today()) return;
    const open = picker.hidden;
    setHidden(picker, !open);
    stampBtn.setAttribute('aria-expanded', String(open));
  }

  function stamp(s: StampId): void {
    const b = api.building();
    if (!b || api.mine() || today()) return;
    api.send([{ t: 'stamp', buildingId: b.id, stampId: s }]);
    pending = { kind: 'stamp', at: now(), stampId: s };
    writeStamp(b.id, s);
    api.toast(`${stampIcon(s)} ${tr('Carimbo deixado na portaria: {0}', [stampLabel(s)])}`);
    paint();
  }

  function message(msg: unknown): boolean {
    if (!msg || typeof msg !== 'object') return false;
    const m = msg as Record<string, unknown>;
    if (m.t === 'like.update' && m.buildingId === id && typeof m.likes === 'number') {
      likes = m.likes;
      liked = m.likedByMe === true;
      if (pending?.kind === 'like') pending = null;
      paint();
      return false;
    }
    if (m.t !== 'notice' || typeof m.text !== 'string' || !pending || now() - pending.at > PENDING_MS) return false;
    const p = pending;
    pending = null;
    if (p.kind === 'stamp') {
      const reply = stampReply(m.text);
      if (reply === 'ok') return true;
      if (reply === 'already') {
        api.toast(tr('Você já deixou um carimbo aqui hoje.'));
        return true;
      }
      // rejected (too far, building departed): stamp was not recorded
      writeStamp(id, null);
      paint();
      api.toast(m.text === 'too_far' ? tr('Entre no prédio ou chegue mais perto da porta para carimbar.') : tr('O carimbo não foi deixado. Tente de novo.'));
      return true;
    }
    if (m.text === 'daily_limit') api.toast(tr('Você já deu os 50 likes de hoje. Amanhã tem mais!'));
    else if (m.text === 'rate_limited') api.toast(tr('Devagar com os likes: espere um pouquinho.'));
    else return false;
    // like rejected: revert to previous state
    liked = !liked;
    likes = Math.max(0, likes + (liked ? 1 : -1));
    paint();
    return true;
  }

  sync();
  return {
    el,
    message,
    sync,
    stampedToday: today,
    destroy: () => el.remove(),
  };
}

/** Short stamp text for bulletin board (screen readers and tooltips). */
export function stampPinTitle(p: StampPin): string {
  return p.count > 1 ? `${p.label} ×${p.count}` : p.label;
}
