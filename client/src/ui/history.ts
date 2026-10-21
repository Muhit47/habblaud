// Session history (popover opened by top bar button): sessions from past 7 days across all
// accounts (GET /api/sessions/recent), grouped by day, with search by title, project, or account. Clicking opens
// conversation in terminal ("ended session" mode); an active session opens the live terminal
// of the agent. Only available when terminal is enabled (local access). Grouping, search, and response validation are
// pure and tested in ui/history.test.ts; rendering uses textContent only. Codex sessions include "Codex" badge and
// search matches "codex".
import { access } from '../net/access';
import type { RecentSession } from '../../../shared/types';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setAttr, setHidden, setText, setTitle } from './dom';
import { calendarDayDiff, formatClock, formatDateTime, normalizeSearch, plural, shortPath } from './format';
import { ICONS } from './icons';
import { isCodex } from './provider';
import { sessionProjectName, TERMINAL_UNAVAILABLE_HINT, type TerminalControl } from './terminal';
import { createAccountChip, updateAccountChip } from './widgets';
import { intlLocale, tr } from '../../../shared/i18n';

export const HISTORY_URL = '/api/sessions/recent';
/** Closed (outside click) so recently that same button click should not immediately reopen. */
const REOPEN_GUARD_MS = 250;

const weekdayDateFmt = new Intl.DateTimeFormat(intlLocale(), { weekday: 'short', day: '2-digit', month: 'short' });

// ---------------------------------------------------------------- model (pure)

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Valid sessions from /api/sessions/recent response (remainder discarded), newest to oldest. */
export function parseRecentSessions(raw: unknown): RecentSession[] {
  const list = raw && typeof raw === 'object' ? (raw as { sessions?: unknown }).sessions : undefined;
  if (!Array.isArray(list)) return [];
  const out: RecentSession[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const account = str(o.account);
    const sessionId = str(o.sessionId);
    const lastAt = num(o.lastAt);
    if (!account || !sessionId || lastAt === undefined) continue;
    const s: RecentSession = { account, sessionId, projectDir: str(o.projectDir) ?? '', lastAt, size: num(o.size) ?? 0, open: o.open === true };
    const project = str(o.project);
    const title = str(o.title);
    const firstAt = num(o.firstAt);
    const agentId = str(o.agentId);
    // Absent = Claude Code (never stored as 'claude').
    if (o.provider === 'codex') s.provider = 'codex';
    if (project) s.project = project;
    if (title) s.title = title;
    if (firstAt !== undefined) s.firstAt = firstAt;
    if (s.open && agentId) s.agentId = agentId;
    out.push(s);
  }
  return out.sort((a, b) => b.lastAt - a.lastAt);
}

/**
 * Search history: title, project (name or path), account name/letter, and tool ("codex"), case-
 * and accent-insensitive.
 */
export function filterSessions(list: readonly RecentSession[], query: string, accountLabel: (id: string) => string = (id) => id): RecentSession[] {
  const terms = normalizeSearch(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return list.slice();
  return list.filter((s) => {
    const hay = normalizeSearch([s.title ?? '', s.project ?? '', s.projectDir, accountLabel(s.account), isCodex(s) ? 'Codex' : ''].join(' '));
    return terms.every((t) => hay.includes(t));
  });
}

/** Day label: "Today", "Yesterday", or "Mon, Oct 5". */
export function dayLabel(at: number, now: number): string {
  const diff = calendarDayDiff(at, now);
  if (diff === 0) return tr('Hoje');
  if (diff === -1) return tr('Ontem');
  const label = weekdayDateFmt.format(at);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export interface SessionDay {
  /** Start of day (local time), stable for list keying. */
  key: number;
  label: string;
  sessions: RecentSession[];
}

/** Groups by day of latest activity (local time), newest day to oldest. */
export function groupSessionsByDay(list: readonly RecentSession[], now: number): SessionDay[] {
  const days = new Map<number, SessionDay>();
  for (const s of [...list].sort((a, b) => b.lastAt - a.lastAt)) {
    const d = new Date(s.lastAt);
    d.setHours(0, 0, 0, 0);
    const key = d.getTime();
    let day = days.get(key);
    if (!day) {
      day = { key, label: dayLabel(s.lastAt, now), sessions: [] };
      days.set(key, day);
    }
    day.sessions.push(s);
  }
  return [...days.values()].sort((a, b) => b.key - a.key);
}

/** Transcript size for tooltip: "820 KB", "3.4 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

// ---------------------------------------------------------------- popover

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

export class HistoryPopover implements UiComponent {
  readonly el: HTMLElement;
  /** Top bar button (index.ts places it in panel group). */
  readonly button: HTMLButtonElement;
  private input: HTMLInputElement;
  private listEl: HTMLElement;
  private stateEl: HTMLElement;
  private stateText: HTMLElement;
  private retryBtn: HTMLButtonElement;
  private footEl: HTMLElement;
  private sessions: RecentSession[] = [];
  private state: LoadState = 'idle';
  private error = '';
  private query = '';
  private request = 0;
  private closedAt = -Infinity;
  /** Render signature of list (avoids DOM rebuild each frame). */
  private drawn = '';

  constructor(
    private ctx: UiContext,
    private terminal: Pick<TerminalControl, 'openSession'>,
  ) {
    this.button = iconButton(ICONS.clock, tr('Histórico de sessões'), () => this.toggle(), 'ui-hist-btn');
    setAttr(this.button, 'aria-haspopup', 'dialog');
    setAttr(this.button, 'aria-expanded', 'false');

    const searchIcon = h('span', { class: 'ui-search__icon', attrs: { 'aria-hidden': 'true' } });
    searchIcon.innerHTML = ICONS.search;
    this.input = h('input', {
      class: 'ui-search__input',
      type: 'search',
      attrs: { placeholder: tr('Buscar por título, projeto ou conta'), 'aria-label': tr('Buscar sessões por título, projeto ou conta'), autocomplete: 'off', spellcheck: 'false' },
    });
    this.input.addEventListener('input', () => {
      this.query = this.input.value;
      this.renderList();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.items()[0]?.focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.items()[0]?.click();
      } else if (e.key === 'Escape' && this.input.value) {
        // First Escape clears search; next closes popover (browser light dismiss).
        e.preventDefault();
        e.stopPropagation();
        this.input.value = '';
        this.query = '';
        this.renderList();
      }
    });

    this.stateText = h('span');
    this.retryBtn = h('button', { class: 'ui-link-btn', type: 'button', text: tr('Tentar de novo'), hidden: true, on: { click: () => void this.load() } });
    this.stateEl = h('p', { class: 'ui-hist__state', role: 'status' }, this.stateText, this.retryBtn);
    this.listEl = h('div', { class: 'ui-hist__list', attrs: { 'aria-label': tr('Sessões recentes') } });
    this.listEl.addEventListener('keydown', (e) => this.onListKey(e));
    this.footEl = h('p', { class: 'ui-hist__foot' });

    const close = iconButton(ICONS.close, tr('Fechar histórico'), () => this.hide(), 'ui-icon-btn--sm');
    this.el = h(
      'div',
      { class: 'ui-popover ui-hist', role: 'dialog', tabIndex: -1, attrs: { 'aria-label': tr('Histórico de sessões'), id: 'ui-history', popover: 'auto' } },
      h('div', { class: 'ui-popover__head' }, h('h2', { text: tr('Histórico de sessões') }), close),
      h('p', { class: 'ui-hist__hint', text: tr('Últimos 7 dias, de todas as contas. Clique para ler a conversa no terminal.') }),
      h('label', { class: 'ui-search ui-hist__search' }, searchIcon, this.input),
      this.stateEl,
      this.listEl,
      this.footEl,
    );
    this.el.addEventListener('toggle', () => {
      setAttr(this.button, 'aria-expanded', String(this.isOpen));
      this.button.classList.toggle('is-on', this.isOpen);
      if (!this.isOpen) this.closedAt = performance.now();
      this.ctx.root.classList.toggle('has-popover', this.isOpen);
    });
  }

  get isOpen(): boolean {
    try {
      return this.el.matches(':popover-open');
    } catch {
      return this.el.classList.contains('is-open');
    }
  }

  /** Feature availability (terminal active: local access and real server). */
  private get available(): boolean {
    return !!this.ctx.store.snapshot?.meta.terminal && access().terminal && !this.ctx.store.mock;
  }

  toggle(): void {
    if (this.isOpen) return this.hide();
    if (!this.available) {
      this.ctx.announce(`${TERMINAL_UNAVAILABLE_HINT}.`);
      return;
    }
    // Click closing popover (outside click on button itself) should not reopen.
    if (performance.now() - this.closedAt < REOPEN_GUARD_MS) return;
    const r = this.button.getBoundingClientRect();
    this.el.style.top = `${Math.round(r.bottom + 8)}px`;
    this.el.style.right = `${Math.max(8, Math.round(innerWidth - r.right - 4))}px`;
    if (typeof this.el.showPopover === 'function') this.el.showPopover();
    else this.el.classList.add('is-open');
    setAttr(this.button, 'aria-expanded', 'true');
    this.button.classList.add('is-on');
    this.ctx.root.classList.add('has-popover');
    this.renderList();
    this.input.focus();
    this.input.select();
    void this.load();
  }

  hide(): void {
    if (typeof this.el.hidePopover === 'function' && this.isOpen) this.el.hidePopover();
    this.el.classList.remove('is-open');
    setAttr(this.button, 'aria-expanded', 'false');
    this.button.classList.remove('is-on');
    this.ctx.root.classList.remove('has-popover');
  }

  render(): void {
    const available = this.available;
    // aria-disabled (not disabled): button remains focusable and reason shows on hover.
    setAttr(this.button, 'aria-disabled', available ? null : 'true');
    this.button.classList.toggle('is-disabled', !available);
    setTitle(this.button, available ? tr('Histórico de sessões (últimos 7 dias)') : TERMINAL_UNAVAILABLE_HINT);
    setAttr(this.button, 'aria-label', available ? tr('Histórico de sessões') : tr('Histórico de sessões: {0}', [TERMINAL_UNAVAILABLE_HINT]));
    if (!this.isOpen) return;
    if (!available) return this.hide();
    this.renderList();
  }

  /** Fetches list from server on each open (previous list remains displayed in meantime). */
  private async load(): Promise<void> {
    const id = ++this.request;
    this.error = '';
    this.state = this.sessions.length ? 'ready' : 'loading';
    this.renderList();
    try {
      const res = await fetch(HISTORY_URL, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        this.error = res.status === 403 ? `${TERMINAL_UNAVAILABLE_HINT}.` : tr('Não foi possível carregar o histórico.');
        throw new Error(String(res.status));
      }
      const sessions = parseRecentSessions(await res.json());
      if (id !== this.request) return;
      this.sessions = sessions;
      this.state = 'ready';
    } catch {
      if (id !== this.request) return;
      if (!this.error) this.error = tr('Não foi possível falar com o servidor.');
      this.state = 'error';
    }
    this.renderList();
  }

  private renderList(): void {
    const now = this.ctx.now();
    const shown = filterSessions(this.sessions, this.query, (id) => this.accountLabel(id));
    const days = groupSessionsByDay(shown, now);
    const q = this.query.trim();
    const loading = this.state === 'loading' || this.state === 'idle';
    let stateText = '';
    if (this.state === 'error') stateText = this.error || tr('Não foi possível carregar o histórico.');
    else if (loading) stateText = tr('Carregando as sessões…');
    else if (!this.sessions.length) stateText = tr('Nenhuma sessão nos últimos 7 dias.');
    else if (!shown.length) stateText = tr('Nenhuma sessão encontrada para “{0}”.', [q]);
    setText(this.stateText, stateText);
    setHidden(this.stateEl, !stateText);
    setHidden(this.retryBtn, this.state !== 'error');
    setText(
      this.footEl,
      this.sessions.length ? (q ? `${shown.length} de ${plural(this.sessions.length, tr('sessão'), tr('sessões'))}` : plural(this.sessions.length, tr('sessão'), tr('sessões'))) : '',
    );
    setHidden(this.footEl, !this.sessions.length);

    // Rebuilds DOM only when content changes (list is small: at most ~150 sessions).
    const sig = JSON.stringify([days.map((d) => [d.key, d.label]), shown.map((s) => [s.account, s.sessionId, s.title, s.lastAt, s.open, s.agentId && !!this.ctx.agent(s.agentId)])]);
    if (sig === this.drawn) return;
    const focusedKey = (document.activeElement as HTMLElement | null)?.dataset?.session;
    this.drawn = sig;
    const frag = document.createDocumentFragment();
    for (const day of days) {
      const group = h('section', { class: 'ui-hist__day', attrs: { 'aria-label': day.label } }, h('h3', { class: 'ui-hist__day-label', text: day.label }));
      for (const s of day.sessions) group.append(this.item(s, now));
      frag.append(group);
    }
    this.listEl.replaceChildren(frag);
    if (focusedKey) this.items().find((b) => b.dataset.session === focusedKey)?.focus();
  }

  private item(s: RecentSession, now: number): HTMLButtonElement {
    const account = this.ctx.account(s.account);
    const chip = createAccountChip('sm');
    updateAccountChip(chip, account, s.account, s.provider);
    const title = s.title?.trim() || tr('Sessão sem título');
    const project = sessionProjectName(s);
    const live = s.open && !!s.agentId && !!this.ctx.agent(s.agentId);
    const codex = isCodex(s);
    const meta = h(
      'span',
      { class: 'ui-hist__meta' },
      codex ? h('span', { class: 'ui-prov ui-prov--xs', text: 'Codex' }) : null,
      h('span', { class: 'ui-hist__project', text: project }),
      h('span', { class: 'ui-hist__time', text: formatClock(s.lastAt, false) }),
    );
    if (live) meta.append(h('span', { class: 'ui-hist__live', text: tr('aberta') }));
    const btn = h('button', { class: `ui-hist__item${live ? ' is-live' : ''}`, type: 'button' }, chip, h('span', { class: 'ui-hist__text' }, h('span', { class: 'ui-hist__title', text: title }), meta));
    btn.dataset.session = `${s.account}:${s.sessionId}`;
    const when = s.firstAt !== undefined && calendarDayDiff(s.firstAt, s.lastAt) !== 0 ? `${formatDateTime(s.firstAt)} → ${formatDateTime(s.lastAt)}` : s.firstAt !== undefined ? `${formatDateTime(s.firstAt)} → ${formatClock(s.lastAt, false)}` : formatDateTime(s.lastAt);
    setTitle(
      btn,
      [title, shortPath(s.project ?? s.projectDir), `${account?.name ?? s.account}${codex ? ' (Codex)' : ''} · ${when} · ${formatSize(s.size)}`, live ? tr('Ainda aberta: abre o terminal ao vivo do agente') : tr('Encerrada: abre a conversa no terminal')].join('\n'),
    );
    setAttr(btn, 'aria-label', `${title}, ${project}, ${account?.name ?? s.account}${codex ? ', Codex' : ''}, ${live ? tr('aberta') : tr('última atividade {0} às {1}', [dayLabel(s.lastAt, now).toLowerCase(), formatClock(s.lastAt, false)])}`);
    btn.addEventListener('click', () => {
      this.hide();
      this.terminal.openSession(s, this.button);
    });
    return btn;
  }

  private items(): HTMLButtonElement[] {
    return [...this.listEl.querySelectorAll<HTMLButtonElement>('.ui-hist__item')];
  }

  /** Arrow keys, Home, and End navigate sessions; Up arrow on first returns to search box. */
  private onListKey(e: KeyboardEvent): void {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = this.items();
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    if (e.key === 'ArrowUp' && i === 0) return this.input.focus();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    items[next]?.focus();
  }

  private accountLabel(id: string): string {
    const a = this.ctx.account(id);
    return a ? `${a.name} ${a.short}` : id;
  }
}
