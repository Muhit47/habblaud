// Account plan usage (5h window and weekly) from local sources:
// - 'statusline': rate_limits passed by Claude Code to statusline, recorded by
//   scripts/statusline-tap.mjs (recommended: live metrics);
// - 'cache': cachedUsageUtilization recorded by Claude Code upon /usage execution;
// - 'codex': rate_limits from Codex session files, pushed by Codex source (AccountsService.setUsage).
// Most recent timestamp (highest fetchedAt) wins. Reads zero credentials and makes
// zero network calls: strictly parses files written locally by tools.
import type { AccountInfo, AccountUsage, UsageWindow } from '../../shared/types';

export type UsageSource = AccountUsage['source'];
export type UsageStatus = AccountInfo['usageStatus'];

/** Metrics older than 30 min render as "stale". */
export const STALE_AFTER_MS = 30 * 60_000;
const WINDOW_KEYS = ['fiveHour', 'sevenDay', 'sevenDayOpus', 'sevenDaySonnet'] as const;

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** Converts ISO string, epoch ms, or epoch seconds to epoch ms. */
export function toEpochMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/** A window in Claude Code format ({utilization, resets_at}) -> UsageWindow. */
function parseWindow(raw: unknown): UsageWindow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const u = num(r.utilization);
  if (u === undefined) return undefined;
  const w: UsageWindow = { utilization: Math.min(100, Math.max(0, u)) };
  const resets = toEpochMs(r.resets_at ?? r.resetsAt);
  if (resets !== undefined) w.resetsAt = resets;
  return w;
}

/**
 * Normalizes usage windows in format written by Claude Code (/usage cache) and dispatched to
 * statusline: {five_hour, seven_day, seven_day_opus, seven_day_sonnet, ...}. No windows -> undefined.
 */
export function usageFromWindows(raw: unknown, source: UsageSource, fetchedAt: number): AccountUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const usage: AccountUsage = { source, fetchedAt };
  const five = parseWindow(r.five_hour);
  const week = parseWindow(r.seven_day);
  const opus = parseWindow(r.seven_day_opus);
  const sonnet = parseWindow(r.seven_day_sonnet);
  if (five) usage.fiveHour = five;
  if (week) usage.sevenDay = week;
  if (opus) usage.sevenDayOpus = opus;
  if (sonnet) usage.sevenDaySonnet = sonnet;
  return five || week || opus || sonnet ? usage : undefined;
}

/** `cachedUsageUtilization` do .claude.json ({fetchedAtMs, utilization:{...}}) -> AccountUsage. */
export function usageFromCache(cached: unknown): AccountUsage | undefined {
  if (!cached || typeof cached !== 'object') return undefined;
  const c = cached as Record<string, unknown>;
  const fetchedAt = toEpochMs(c.fetchedAtMs ?? c.fetchedAt);
  if (fetchedAt === undefined) return undefined;
  return usageFromWindows(c.utilization, 'cache', fetchedAt);
}

/**
 * Windows whose reset timestamp has passed since collection have NO DATA (are omitted): previous
 * percentage is obsolete and current usage in new window is unknown — displaying 0% would
 * falsely imply full quota. They reappear when source provides new readings.
 */
export function rollover(usage: AccountUsage, now: number): AccountUsage {
  const out: AccountUsage = { ...usage };
  for (const key of WINDOW_KEYS) {
    const w = usage[key];
    if (w?.resetsAt !== undefined && w.resetsAt <= now) delete out[key];
  }
  return out;
}

export interface UsageView {
  usage?: AccountUsage;
  status: UsageStatus;
}

/** Stores numbers from each source per account and decides what to display. */
export class UsageStore {
  private entries = new Map<string, Map<UsageSource, AccountUsage>>();

  /** Records numbers from a source. Returns true if changed. */
  set(accountId: string, usage: AccountUsage): boolean {
    let m = this.entries.get(accountId);
    if (!m) this.entries.set(accountId, (m = new Map()));
    const prev = m.get(usage.source);
    m.set(usage.source, usage);
    return JSON.stringify(prev) !== JSON.stringify(usage);
  }

  clear(accountId: string, source: UsageSource): boolean {
    return this.entries.get(accountId)?.delete(source) ?? false;
  }

  /** Forgets all sources for account (signed out). Returns true if previously present. */
  forget(accountId: string): boolean {
    const had = !!this.entries.get(accountId)?.size;
    this.entries.delete(accountId);
    return had;
  }

  view(accountId: string, now: number): UsageView {
    const all = [...(this.entries.get(accountId)?.values() ?? [])];
    const best = all.reduce<AccountUsage | undefined>((acc, u) => (!acc || u.fetchedAt > acc.fetchedAt ? u : acc), undefined);
    if (!best) return { status: 'disabled' };
    return { usage: rollover(best, now), status: now - best.fetchedAt > STALE_AFTER_MS ? 'stale' : 'ok' };
  }
}
