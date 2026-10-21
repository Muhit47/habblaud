// Active language formatting (PT-BR by default) (times, numbers, usage). Pure functions: no DOM, tested in ui/format.test.ts.
import { intlLocale, tr } from '../../../shared/i18n';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const LOCALE = intlLocale();

const numberFmt1 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
const integerFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const usdFmt = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
// 24h clock across all languages (in English AM/PM overflows feed column).
const clockFmt = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const clockSecFmt = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const weekdayFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'short' });
const dateTimeFmt = new Intl.DateTimeFormat(LOCALE, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Relative past time: "now", "5s ago", "3m ago", "2h ago", "4d ago". */
export function relativeTime(at: number, now: number): string {
  const diff = now - at;
  if (!Number.isFinite(diff) || diff < 5 * SECOND) return tr('agora');
  if (diff < MINUTE) return tr('há {0} s', [Math.floor(diff / SECOND)]);
  if (diff < HOUR) return tr('há {0} min', [Math.floor(diff / MINUTE)]);
  if (diff < DAY) return tr('há {0} h', [Math.floor(diff / HOUR)]);
  return tr('há {0} d', [Math.floor(diff / DAY)]);
}

/** Human-readable duration: "12 s", "3 min", "2 h 10 min", "3 d 4 h". */
export function formatDuration(ms: number): string {
  const v = Math.max(0, ms);
  if (v < MINUTE) return `${Math.floor(v / SECOND)} s`;
  if (v < HOUR) return `${Math.floor(v / MINUTE)} min`;
  if (v < DAY) {
    const h = Math.floor(v / HOUR);
    const m = Math.floor((v % HOUR) / MINUTE);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(v / DAY);
  const h = Math.floor((v % DAY) / HOUR);
  return h ? `${d} d ${h} h` : `${d} d`;
}

/**
 * Stopwatch for currently running task: "0:07", "12:31", "1:02:10"; from 1 day up, "1 d 2 h".
 * Updates every second; negative values (out-of-sync clocks) become "0:00".
 */
export function formatElapsed(ms: number): string {
  const v = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (v >= DAY) return formatDuration(v);
  const total = Math.floor(v / SECOND);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Countdown timer: "in 2 h 10 min", "in 5 min", "in less than 1 min", "now". */
export function formatCountdown(target: number, now: number): string {
  const diff = target - now;
  if (diff <= 0) return tr('agora');
  if (diff < MINUTE) return tr('em menos de 1 min');
  return `em ${formatDuration(diff)}`;
}

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Calendar days (local time) between `t` and `now` (0 = same day). */
export function calendarDayDiff(t: number, now: number): number {
  return Math.round((startOfDay(t) - startOfDay(now)) / DAY);
}

/**
 * When usage window resets: "at 14:30" (today), "tomorrow at 01:30" or "Thu., 20:00".
 * Timestamp already elapsed returns "" (never display past reset as if upcoming).
 */
export function formatResetAt(resetsAt: number, now: number): string {
  if (!Number.isFinite(resetsAt) || resetsAt <= now) return '';
  const time = clockFmt.format(resetsAt);
  const days = calendarDayDiff(resetsAt, now);
  if (days <= 0) return tr('às {0}', [time]);
  if (days === 1) return tr('amanhã às {0}', [time]);
  return `${weekdayFmt.format(resetsAt)}, ${time}`;
}

/** Compact duration for constrained UI: "45s", "29min", "1h29", "2h", "3d4h". */
export function compactDuration(ms: number): string {
  const v = Math.max(0, ms);
  if (v < MINUTE) return `${Math.floor(v / SECOND)}s`;
  if (v < HOUR) return `${Math.floor(v / MINUTE)}min`;
  if (v < DAY) {
    const h = Math.floor(v / HOUR);
    const m = Math.floor((v % HOUR) / MINUTE);
    return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
  }
  const d = Math.floor(v / DAY);
  const h = Math.floor((v % DAY) / HOUR);
  return h ? `${d}d${h}h` : `${d}d`;
}

export const FIVE_HOURS_MS = 5 * HOUR;
export const WEEK_MS = 7 * DAY;

/** Presentation model of usage window (5h or weekly), taking reading age into account. */
export interface UsageWindowView {
  /** Percentage 0–100; null when window reset after reading (current usage unknown). */
  pct: number | null;
  /** Window has already reset since figures were retrieved. */
  renewed: boolean;
  /** Next reset: "in 1 h 29 min" (<24h), "tomorrow, 13:49" or "Thu., 13:49"; "" if unknown. */
  reset: string;
  /** Compact countdown to reset ("1h29"), for small screens; "" if unknown. */
  resetShort: string;
  /** Complete phrase for tooltips and screen readers. */
  summary: string;
}

/**
 * `windowMs` is window duration (5h or 7d): without reset timestamp, readings older than that
 * are expired (window definitely reset).
 */
export function usageWindowView(win: { utilization: number; resetsAt?: number } | undefined, fetchedAt: number, now: number, windowMs: number): UsageWindowView | null {
  if (!win) return null;
  const resetsAt = win.resetsAt !== undefined && Number.isFinite(win.resetsAt) ? win.resetsAt : undefined;
  const renewed = resetsAt !== undefined ? resetsAt <= now : now - fetchedAt >= windowMs;
  if (renewed) {
    return {
      pct: null,
      renewed: true,
      reset: tr('renovada'),
      resetShort: tr('renovada'),
      summary: tr('renovada depois da última leitura (uso atual desconhecido)'),
    };
  }
  const pct = clampPercent(win.utilization);
  if (resetsAt === undefined) return { pct, renewed: false, reset: '', resetShort: '', summary: tr('{0}% usado', [pct]) };
  const diff = resetsAt - now;
  let reset: string;
  if (diff < DAY) reset = formatCountdown(resetsAt, now);
  else {
    const time = clockFmt.format(resetsAt);
    reset = calendarDayDiff(resetsAt, now) === 1 ? tr('amanhã, {0}', [time]) : `${weekdayFmt.format(resetsAt)}, ${time}`;
  }
  const at = formatResetAt(resetsAt, now);
  return {
    pct,
    renewed: false,
    reset,
    resetShort: compactDuration(diff),
    summary: tr('{0}% usado · reinicia {1} ({2})', [pct, at, formatCountdown(resetsAt, now)]),
  };
}

/** "14:30:05" */
export function formatClock(at: number, withSeconds = true): string {
  return (withSeconds ? clockSecFmt : clockFmt).format(at);
}

/** "06 de out., 14:30" */
export function formatDateTime(at: number): string {
  return dateTimeFmt.format(at);
}

/** Compact tokens: "850", "12.3 k", "1.2 M", "1.1 B". */
export function formatTokens(n: number): string {
  const v = Math.max(0, n);
  if (v < 1_000) return integerFmt.format(v);
  if (v < 1_000_000) return `${numberFmt1.format(v / 1_000)} k`;
  if (v < 1_000_000_000) return `${numberFmt1.format(v / 1_000_000)} M`;
  return `${numberFmt1.format(v / 1_000_000_000)} B`;
}

/** Integer with thousands separator: "12,345". */
export function formatInt(n: number): string {
  return integerFmt.format(n);
}

/** Cost in USD: "$1.23". */
export function formatUSD(n: number): string {
  return usdFmt.format(n).replace(/ /g, ' ');
}

/** Usage percentage clamped to 0–100 and rounded. */
export function clampPercent(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return 0;
  return Math.round(Math.min(100, Math.max(0, v)));
}

export type UsageLevel = 'ok' | 'warn' | 'crit';

/** Color thresholds: green < 50%, amber 50–80%, red >= 80%. */
export function usageLevel(utilization: number): UsageLevel {
  if (utilization >= 80) return 'crit';
  if (utilization >= 50) return 'warn';
  return 'ok';
}

/** "1 agent", "3 agents" */
export function plural(n: number, singular: string, pluralForm: string): string {
  return `${formatInt(n)} ${n === 1 ? singular : pluralForm}`;
}

/** Removes diacritics and normalizes for search ("João" -> "joao"). */
export function normalizeSearch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Short model name: "claude-opus-5-5" -> "Opus 5.5". Preserves original if unrecognized. */
export function prettyModel(model: string | undefined): string {
  if (!model) return '—';
  // Codex: "gpt-5.3-codex" -> "GPT-5.3 Codex", "gpt-5.1-codex-mini" -> "GPT-5.1 Codex Mini", "gpt-5" -> "GPT-5".
  const gpt = /^gpt-(\d+(?:\.\d+)?[a-z]?)((?:-[a-z][a-z0-9]*)*)$/i.exec(model);
  if (gpt) {
    const words = gpt[2]
      .split('-')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    return [`GPT-${gpt[1]}`, ...words].join(' ');
  }
  // Formats: "claude-opus-5-5", "claude-sonnet-4-5-20250929", "claude-opus-4-20250514", "claude-3-5-sonnet-20241022".
  const m = /claude-(?:(\d{1,2}(?:-\d{1,2})?)-)?([a-z]+)(?:-(\d{1,2})(?!\d)(?:-(\d{1,2})(?!\d))?)?/i.exec(model);
  if (!m) return model;
  const family = m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase();
  const version = m[1] ? m[1].replace('-', '.') : m[3] ? (m[4] ? `${m[3]}.${m[4]}` : m[3]) : '';
  return version ? `${family} ${version}` : family;
}

const PERMISSION_LABELS: Record<string, string> = {
  default: tr('Padrão (pergunta)'),
  acceptEdits: tr('Aceita edições'),
  plan: tr('Modo plano'),
  bypassPermissions: tr('Sem confirmações'),
  dontAsk: tr('Não pergunta'),
  auto: tr('Automático'),
};

export function permissionLabel(mode: string | undefined): string {
  if (!mode) return '—';
  return PERMISSION_LABELS[mode] ?? mode;
}

/** Shortens home directory paths: "/Users/ana/projects/x" -> "~/projects/x". */
export function shortPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~');
}
