// Monitored accounts + usage tracking: statusline tap (recommended) and /usage cache
// written in .claude.json. Strictly local files: zero credentials, zero network requests.
//
// Claude Code accounts originate from config dirs (detectAccounts). Other provider accounts (Codex) arrive externally,
// discovered by their source (setProviderAccounts), with unique IDs across all accounts; usage metrics are
// pushed by source (setUsage) alongside Claude Code statusline tap and /usage cache.
import { basename, resolve } from 'node:path';
import type { AccountInfo, AccountUsage, Provider } from '../../shared/types';
import { log } from '../log';
import { detectAccounts, type DetectedAccount } from './detect';
import { StatuslineUsageReader, type StatuslineUsage } from './statusline';
import { usageFromCache, UsageStore, type UsageSource, type UsageView } from './usage';
import { tr } from '../../shared/i18n';

export interface AccountEntry {
  id: string;
  /** Account tool provider. */
  provider: Provider;
  /** Config dir read by this process (mount path inside Docker). */
  dir: string;
  detected: DetectedAccount;
}

/** Non-Claude account (e.g. CODEX_HOME), discovered by its provider source. */
export interface ProviderAccountInput {
  /** Directory path read by this process (mount path inside Docker). */
  dir: string;
  /**
   * Display metadata. `id` is requested id (e.g. ".codex"): if another account already uses it, appended with "~2", "~3"...
   * (final id returned in setProviderAccounts). `provider` is populated by service.
   */
  detected: DetectedAccount;
}

export interface AccountsServiceOptions {
  dirs: string[];
  home: string;
  env: NodeJS.ProcessEnv;
  onChange: () => void;
  now?: () => number;
  /** Polling interval for .claude.json (usage cache). */
  refreshMs?: number;
  /** Directory with statusline-captured usage (scripts/statusline-tap.mjs). Without it, source is disabled. */
  usageDir?: string;
  /** Polling interval for statusline directory (default 5 s). */
  statuslineMs?: number;
}

export class AccountsService {
  readonly usage = new UsageStore();
  /** Claude Code accounts (config dirs). */
  private list_: AccountEntry[] = [];
  /** Accounts from other providers, per provider (setProviderAccounts). */
  private external = new Map<Provider, AccountEntry[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private statuslineTimer: ReturnType<typeof setInterval> | null = null;
  private readonly statusline: StatuslineUsageReader | null;
  /** Fingerprint of displayed usage (status changes autonomously over time: ok -> stale, windows reset). */
  private usageSig = '';
  private readonly now: () => number;

  constructor(private readonly opts: AccountsServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.statusline = opts.usageDir ? new StatuslineUsageReader(opts.usageDir) : null;
    this.refresh();
    this.refreshStatusline();
  }

  /** Re-reads metadata and usage cache (lightweight: two or three small JSONs). */
  refresh(): void {
    let detected: DetectedAccount[];
    try {
      detected = detectAccounts(this.opts.dirs, { home: this.opts.home, env: this.opts.env });
    } catch (err) {
      log.warnOnce('detect-accounts', tr('Falha ao detectar contas: {0}', [String(err).slice(0, 120)]));
      return;
    }
    const next = this.opts.dirs.map((dir, i): AccountEntry => ({ id: detected[i].id, provider: 'claude', dir, detected: detected[i] }));
    let changed = JSON.stringify(next.map((e) => ({ ...e.detected, cachedUsage: undefined }))) !==
      JSON.stringify(this.list_.map((e) => ({ ...e.detected, cachedUsage: undefined })));
    this.list_ = next;
    for (const e of next) {
      const cache = usageFromCache(e.detected.cachedUsage);
      if (cache) changed = this.usage.set(e.id, cache) || changed;
      else changed = this.usage.clear(e.id, 'cache') || changed;
    }
    if (this.usageViewChanged()) changed = true;
    if (changed) this.opts.onChange();
  }

  /**
   * Re-reads statusline tap files and applies most recent match to each account
   * (by config dir; fallback by id/basename). Account without file loses 'statusline' source.
   */
  refreshStatusline(): void {
    if (!this.statusline) return;
    let files: StatuslineUsage[];
    try {
      files = this.statusline.read(this.now());
    } catch (err) {
      log.warnOnce('statusline-read', tr('Falha ao ler o uso do statusline: {0}', [String(err).slice(0, 120)]));
      return;
    }
    let changed = false;
    for (const e of this.list_) {
      const mine = files.filter((f) => this.fileMatches(e, f));
      const best = mine.reduce<StatuslineUsage | undefined>((acc, f) => (!acc || f.usage.fetchedAt > acc.usage.fetchedAt ? f : acc), undefined);
      if (best) changed = this.usage.set(e.id, best.usage) || changed;
      else changed = this.usage.clear(e.id, 'statusline') || changed;
    }
    if (this.usageViewChanged()) changed = true;
    if (changed) this.opts.onChange();
  }

  private fileMatches(e: AccountEntry, f: StatuslineUsage): boolean {
    if (f.configDir) {
      const dir = resolve(f.configDir);
      if (dir === resolve(e.detected.configDir) || dir === resolve(e.dir)) return true;
      // Same folder name but different path: only valid if no other account shares this path.
      if (this.list_.some((o) => resolve(o.detected.configDir) === dir || resolve(o.dir) === dir)) return false;
      return basename(dir) === e.id;
    }
    return !!f.accountId && f.accountId === e.id;
  }

  /**
   * Replaces accounts for a non-Claude Code tool (called on each discovery). IDs
   * are unique across all accounts: already used id (by Claude Code, another tool, or duplicate
   * in list) gets "~2", "~3"... in list order. Returns entries with final IDs in identical order:
   * these populate AgentInfo.account. Removed accounts lose cached usage.
   */
  setProviderAccounts(provider: Exclude<Provider, 'claude'>, list: readonly ProviderAccountInput[]): readonly AccountEntry[] {
    const taken = new Set(this.list_.map((e) => e.id));
    for (const [p, entries] of this.external) if (p !== provider) for (const e of entries) taken.add(e.id);
    const next = list.map((input): AccountEntry => {
      const base = input.detected.id || basename(input.dir) || input.dir;
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}~${n}`;
      taken.add(id);
      return { id, provider, dir: input.dir, detected: { ...input.detected, id, provider } };
    });
    const prev = this.external.get(provider) ?? [];
    let changed = JSON.stringify(prev) !== JSON.stringify(next);
    for (const e of prev) if (!next.some((n) => n.id === e.id)) changed = this.usage.forget(e.id) || changed;
    if (next.length) this.external.set(provider, next);
    else this.external.delete(provider);
    if (this.usageViewChanged()) changed = true;
    if (changed) this.opts.onChange();
    return next;
  }

  /**
   * Usage pushed by a source (e.g. Codex, parsed from session files): stored by origin
   * (`usage.source`) alongside others; most recent (highest fetchedAt) wins. Returns true if changed.
   */
  setUsage(accountId: string, usage: AccountUsage): boolean {
    const changed = this.usage.set(accountId, usage);
    const viewChanged = this.usageViewChanged();
    if (changed || viewChanged) this.opts.onChange();
    return changed;
  }

  /** Forgets usage from an account origin (e.g. source has no more data). Returns true if changed. */
  clearUsage(accountId: string, source: UsageSource): boolean {
    const changed = this.usage.clear(accountId, source);
    const viewChanged = this.usageViewChanged();
    if (changed || viewChanged) this.opts.onChange();
    return changed;
  }

  /** Did displayed usage change (including autonomously over time: ok -> stale, windows reset)? */
  private usageViewChanged(): boolean {
    const now = this.now();
    const sig = JSON.stringify(this.allEntries().map((e) => this.usage.view(e.id, now)));
    if (sig === this.usageSig) return false;
    this.usageSig = sig;
    return true;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.refresh(), this.opts.refreshMs ?? 60_000);
    this.timer.unref?.();
    if (this.statusline) {
      this.statuslineTimer = setInterval(() => this.refreshStatusline(), this.opts.statuslineMs ?? 5_000);
      this.statuslineTimer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.statuslineTimer) clearInterval(this.statuslineTimer);
    this.timer = null;
    this.statuslineTimer = null;
  }

  /** Claude Code accounts (watcher, history, and statusline belong strictly to them). */
  entries(): readonly AccountEntry[] {
    return this.list_;
  }

  /** Accounts belonging to a specific tool. */
  entriesOf(provider: Provider): readonly AccountEntry[] {
    return provider === 'claude' ? this.list_ : (this.external.get(provider) ?? []);
  }

  /** Accounts across all tools: Claude Code first. */
  allEntries(): readonly AccountEntry[] {
    if (!this.external.size) return this.list_;
    return [...this.list_, ...[...this.external.values()].flat()];
  }

  idForDir(dir: string): string | undefined {
    const abs = resolve(dir);
    return this.allEntries().find((e) => resolve(e.dir) === abs)?.id;
  }

  find(id: string): AccountEntry | undefined {
    return this.allEntries().find((e) => e.id === id);
  }

  usageView(id: string): UsageView {
    return this.usage.view(id, this.now());
  }

  /** Accounts (across all tools) in protocol format; `sessions` = open sessions per account. */
  list(sessions: ReadonlyMap<string, number>): AccountInfo[] {
    const now = this.now();
    return this.allEntries().map((e) => {
      const d = e.detected;
      const view = this.usage.view(e.id, now);
      const info: AccountInfo = {
        id: e.id,
        short: d.short,
        name: d.name,
        color: d.color,
        configDir: d.configDir,
        sessions: sessions.get(e.id) ?? 0,
        usageStatus: view.status,
      };
      // Absent = 'claude' (Claude Code account snapshot remains unchanged).
      if (e.provider !== 'claude') info.provider = e.provider;
      if (d.email) info.email = d.email;
      if (d.organization) info.organization = d.organization;
      if (d.plan) info.plan = d.plan;
      if (view.usage) info.usage = view.usage;
      return info;
    });
  }
}
