// "Where did my day go" routes: GET /api/stats?day=YYYY-MM-DD&tz=<IANA>&source=real|demo and GET /api/stats/days?tz=<IANA>.
// Only aggregated numbers and project/account/agent names — same exposure as /api/snapshot, so available on
// exposed ports (without local bind lock required by terminal). Parameters are strictly validated (400).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { addDays, canonicalTimeZone, parseDayKey, RETENTION_DAYS, type StatsSource } from '../../shared/daystats';
import type { DayStatsService } from '../history/daystats';
import { tr } from '../../shared/i18n';

type Send = (res: ServerResponse, status: number, body: unknown) => void;

export type StatsQuery = { ok: true; day: string; tz: string; source?: StatsSource } | { ok: false; status: number; error: string };

/** Parameter appears at most once (value is validated by caller). */
function single(url: URL, name: string): { value?: string; error?: string } {
  const all = url.searchParams.getAll(name);
  if (all.length > 1) return { error: tr('parâmetro "{0}" repetido', [name]) };
  if (!all.length) return {};
  return { value: all[0] };
}

/** Parses and validates `tz` (default: server timezone). */
function parseTz(url: URL, fallback: string): { tz?: string; error?: string } {
  const p = single(url, 'tz');
  if (p.error) return { error: p.error };
  if (p.value === undefined) return { tz: fallback };
  const tz = canonicalTimeZone(p.value);
  if (!tz) return { error: tr('fuso inválido: use um nome IANA, ex.: America/Sao_Paulo') };
  return { tz };
}

/**
 * Validates GET /api/stats query. `today(tz)` returns current date in requested timezone. Errors: 400 (format,
 * non-existent date, future date, repeated parameter, invalid timezone or source) and 404 (beyond retention limit).
 */
export function parseStatsQuery(url: URL, defaultTz: string, today: (tz: string) => string): StatsQuery {
  const t = parseTz(url, defaultTz);
  if (!t.tz) return { ok: false, status: 400, error: t.error ?? tr('fuso inválido') };
  const d = single(url, 'day');
  if (d.error) return { ok: false, status: 400, error: d.error };
  const now = today(t.tz);
  const day = d.value ?? now;
  if (!parseDayKey(day)) return { ok: false, status: 400, error: tr('dia inválido: use AAAA-MM-DD (ex.: 2026-10-08)') };
  if (day > now) return { ok: false, status: 400, error: tr('dia no futuro') };
  if (day < addDays(now, -RETENTION_DAYS)) return { ok: false, status: 404, error: tr('o Habblaud guarda só os últimos {0} dias', [RETENTION_DAYS]) };
  const s = single(url, 'source');
  if (s.error) return { ok: false, status: 400, error: s.error };
  if (s.value !== undefined && s.value !== 'real' && s.value !== 'demo') return { ok: false, status: 400, error: tr('fonte inválida: use real ou demo') };
  const out: StatsQuery = { ok: true, day, tz: t.tz };
  if (s.value) out.source = s.value;
  return out;
}

/** Handles /api/stats and /api/stats/*. */
export function handleStatsRoute(req: IncomingMessage, res: ServerResponse, url: URL, stats: DayStatsService | undefined, send: Send): void {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== '/api/stats' && path !== '/api/stats/days') {
    send(res, 404, { error: tr('rota desconhecida') });
    return;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('Allow', 'GET');
    send(res, 405, { error: tr('método não permitido') });
    return;
  }
  if (!stats) {
    send(res, 404, { error: tr('estatísticas indisponíveis') });
    return;
  }
  if (path === '/api/stats/days') {
    const t = parseTz(url, stats.tz);
    if (!t.tz) send(res, 400, { error: t.error ?? tr('fuso inválido') });
    else send(res, 200, stats.days(t.tz));
    return;
  }
  const q = parseStatsQuery(url, stats.tz, (tz) => stats.today(tz));
  if (!q.ok) {
    send(res, q.status, { error: q.error });
    return;
  }
  if (q.source === 'demo' && !stats.isDemo()) {
    send(res, 404, { error: tr('o modo demonstração está desligado') });
    return;
  }
  const body = stats.day(q.day, q.tz, q.source);
  if (body) send(res, 200, body);
  else send(res, 404, { error: tr('sem estatísticas para este dia') });
}
