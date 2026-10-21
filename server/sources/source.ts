// Agent sources (one per tool: Claude Code, Codex...) and what the rest of the server expects from them.
//
// Each source observes OPEN sessions of its tool and feeds the Office (addMain, addActivity...). The
// server binds all via a SourceSet: snapshot (meta.sources), /api/health, terminal, and agent transcript
// path all go through it, agnostic to which tool the agent comes from. Currently Claude Code is
// handled by ClaudeWatcher (sources/watcher.ts); Codex integrates via the same contract.
//
// Terminal history (recent sessions, open or closed): one HistoryProvider per tool, united in a
// HistorySet serving /api/sessions/* routes. Claude Code provider is SessionHistory (sources/history.ts).
//
// Boot: a source reconstructing open sessions on start calls office.beginBoot() beforehand and office.endBoot()
// afterwards, ALWAYS in pairs (in a `finally`, including async boots). Office counts active boots: while any
// source boots, notifications are silenced and the feed is buffered to emit in chronological order when the final boot ends (a source
// failing to call endBoot would silence notifications indefinitely).
import type { Provider, RecentSession, SourceInfo } from '../../shared/types';
import { errMsg, log } from '../log';
import { HISTORY_LIMIT } from './history';
import { createTerminalParser, type TerminalParser } from './terminal';
import { tr } from '../../shared/i18n';

/** An agent source: observes open sessions of a tool and feeds the Office. */
export interface AgentSource {
  readonly provider: Provider;
  /**
   * Boot (reconstructs open sessions between office.beginBoot/endBoot) and live tracking. A synchronous
   * source completes boot before returning; an async one returns a promise (errors logged only).
   */
  start(): void | Promise<void>;
  stop(): void;
  /** One entry per observed account (snapshot meta.sources and /api/health). */
  sources(): SourceInfo[];
  /** Conversation file for an active agent from this source; undefined if agent is not from it (or no file yet). */
  transcriptPathOf(agentId: string): string | undefined;
  /**
   * Terminal parser for an agent's conversation from this source: NEW on every call (parsers retain state).
   * Missing, or undefined = Claude Code parser (createTerminalParser).
   */
  terminalParser?(agentId: string): TerminalParser | undefined;
}

/** All connected agent sources, viewed as a unified source. */
export class SourceSet {
  private readonly list: AgentSource[] = [];

  constructor(sources: readonly AgentSource[] = []) {
    for (const s of sources) this.add(s);
  }

  /** Appends a source (before start()). */
  add(source: AgentSource): void {
    this.list.push(source);
  }

  all(): readonly AgentSource[] {
    return this.list;
  }

  /** Source for a tool, if connected. */
  of(provider: Provider): AgentSource | undefined {
    return this.list.find((s) => s.provider === provider);
  }

  /**
   * Connects sources in insertion order: synchronous sources finish boot right here (before hub starts
   * broadcasting). Failure in one source does not block others: logged. Promise resolves once async
   * sources complete startup.
   */
  start(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const s of this.list) {
      const failed = (err: unknown) => log.error(tr('Fonte de agentes {0}: falha ao iniciar ({1}).', [s.provider, errMsg(err)]));
      try {
        const r = s.start();
        if (r) pending.push(r.catch(failed));
      } catch (err) {
        failed(err);
      }
    }
    return Promise.all(pending).then(() => undefined);
  }

  stop(): void {
    for (const s of this.list) {
      try {
        s.stop();
      } catch (err) {
        log.warn(tr('Fonte de agentes {0}: falha ao parar ({1}).', [s.provider, errMsg(err)]));
      }
    }
  }

  sources(): SourceInfo[] {
    return this.list.flatMap((s) => s.sources());
  }

  /** Conversation file for an active agent (first source recognizing it). */
  transcriptPathOf(agentId: string): string | undefined {
    for (const s of this.list) {
      const path = s.transcriptPathOf(agentId);
      if (path) return path;
    }
    return undefined;
  }

  /**
   * NEW parser for an agent's terminal: from the source recognizing their transcript (transcriptPathOf);
   * if none, or if lacking custom parser, Claude Code parser.
   */
  parserFor(agentId: string): TerminalParser {
    const owner = this.list.find((s) => s.transcriptPathOf(agentId) !== undefined);
    return owner?.terminalParser?.(agentId) ?? createTerminalParser();
  }
}

// ------------------------------------------------------------------ terminal history

/** Resolved history session: conversation file and associated terminal parser. */
export interface HistorySession {
  path: string;
  /** NEW parser on each call (terminal creates a new one when file is truncated or replaced). */
  createParser: () => TerminalParser;
}

/** resolve() outcome: session or HTTP error. */
export type HistoryResolveResult = HistorySession | { status: 400 | 404; error: string };

/** Contract required by /api/sessions/* routes: standalone provider or HistorySet. */
export interface SessionLookup {
  /** Recent sessions, from newest activity to oldest. */
  list(): Promise<RecentSession[]>;
  /**
   * Validates and locates session `sessionId` for account (no path traversal). Never throws:
   * 400 = invalid id, 404 = unknown account or session.
   */
  resolve(account: string, sessionId: string): HistoryResolveResult;
}

/** Tool history: recent sessions across its accounts. */
export interface HistoryProvider extends SessionLookup {
  readonly provider: Provider;
  /** Account belongs to this provider (HistorySet routes resolve() here). */
  hasAccount(account: string): boolean;
}

/**
 * Unifies history across all tools: all listings (from newest activity to oldest,
 * up to `limit`) and each session resolved by the account's provider. Accounts unrecognized by any
 * provider route to the first (Claude Code), returning standard errors (400 for invalid id, else 404).
 */
export class HistorySet implements SessionLookup {
  private readonly list_: HistoryProvider[] = [];

  constructor(
    providers: readonly HistoryProvider[] = [],
    private readonly limit = HISTORY_LIMIT,
  ) {
    for (const p of providers) this.add(p);
  }

  add(provider: HistoryProvider): void {
    this.list_.push(provider);
  }

  /** A failing provider does not bring down other listings (logged only); if all fail, error bubbles up. */
  async list(): Promise<RecentSession[]> {
    const results = await Promise.allSettled(this.list_.map((p) => p.list()));
    const out: RecentSession[] = [];
    const failures: Array<{ provider: Provider; err: unknown }> = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') out.push(...r.value);
      else failures.push({ provider: this.list_[i].provider, err: r.reason });
    });
    if (failures.length && failures.length === results.length) throw failures[0].err;
    for (const f of failures) {
      log.warnOnce(`history-list:${f.provider}:${errMsg(f.err)}`, tr('Histórico de sessões ({0}): falha ao listar ({1}).', [f.provider, errMsg(f.err)]));
    }
    return out.sort((a, b) => b.lastAt - a.lastAt).slice(0, this.limit);
  }

  resolve(account: string, sessionId: string): HistoryResolveResult {
    const owner = this.list_.find((p) => p.hasAccount(account)) ?? this.list_[0];
    return owner ? owner.resolve(account, sessionId) : { status: 404, error: tr('conta desconhecida') };
  }
}
