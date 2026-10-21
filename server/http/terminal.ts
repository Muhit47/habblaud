// Terminal (Server-Sent Events) on GET /api/agents/:id/terminal: session conversation
// (prompts, responses, tool calls, and results) rebuilt from transcript JSONL via sources/terminal.ts.
// Named events: init | append (`data` matches TerminalMessage in shared/types.ts). The route
// (http/app.ts) already verified feature is enabled and access is local.
//
// Each connection has its own FileTail and parser (agent tool's parser: SourceSet.parserFor; Claude
// Code by default): upon connection, reads transcript tail (≈4 MB, last 500 entries) and sends `init`;
// thereafter, ~400 ms polling sends `append` with new entries.
// Truncated/replaced transcript (or changed via /clear in same process) = new parser and fresh `init`.
// Demo agents lack transcripts: synthetic conversation is generated from demoTerminalEntries every ~500 ms.
// History sessions (GET /api/sessions/:account/:sessionId/terminal, http/sessions.ts) use same reader
// on validated transcript, with wider polling intervals (~2 s).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { demoTerminalEntries } from '../../shared/demo/terminal';
import type { Activity, AgentInfo, TerminalEntry, TerminalInit } from '../../shared/types';
import { errMsg, log } from '../log';
import type { Office } from '../model/office';
import { FileTail } from '../sources/tail';
import { createTerminalParser, type TerminalParser } from '../sources/terminal';
import { sendJson } from './app';
import { frame } from './sse';
import { tr } from '../../shared/i18n';

/** Simultaneously open terminals (each independently reading the transcript). */
export const MAX_STREAMS = 8;
/** How much of transcript tail is read for `init`. */
export const INIT_TAIL_BYTES = 4 * 1024 * 1024;
/** Entries sent on `init` (most recent entries). */
export const INIT_ENTRIES = 500;
export const POLL_MS = 400;
export const DEMO_POLL_MS = 500;
/** History session: almost always finished (polling only detects resumption via /resume). */
export const SESSION_POLL_MS = 2_000;
const PING_MS = 15_000;
/** Slow client (buffered bytes exceeding threshold) is dropped; EventSource reconnects. */
const MAX_BUFFERED = 8 * 1024 * 1024;
/** Reads (up to 8 MB each) per poll cycle: remainder deferred to next cycle. */
const READS_PER_POLL = 4;
const MAX_INIT_READS = 64;
/** Prefix for demo agent IDs (see Office.setDemo). */
const DEMO_PREFIX = 'demo:';

export interface TerminalOptions {
  office: Office;
  /** Transcript path for a real agent (SourceSet.transcriptPathOf). */
  transcriptPathOf: (agentId: string) => string | undefined;
  /**
   * Conversation parser for a real agent (SourceSet.parserFor): fresh instance per call. Missing or undefined
   * = createParser.
   */
  parserFor?: (agentId: string) => TerminalParser | undefined;
  /** Default parser factory (tests); default: createTerminalParser (Claude Code). */
  createParser?: () => TerminalParser;
  /** Synthetic conversation for demo agents (tests); default: demoTerminalEntries. */
  demoEntries?: (agent: AgentInfo, history: Activity[]) => TerminalEntry[];
  maxStreams?: number;
  initTailBytes?: number;
  initEntries?: number;
  pollMs?: number;
  demoPollMs?: number;
  sessionPollMs?: number;
  pingMs?: number;
}

/** Changes since last poll cycle: `init` replaces state; `stop` = agent gone. */
interface PollResult {
  init?: TerminalInit;
  append?: TerminalEntry[];
  stop?: boolean;
}

/** Source of conversation for a connection. */
interface ConversationSource {
  readonly intervalMs: number;
  /** Recent conversation for `init`. */
  load(): TerminalInit;
  poll(): PollResult;
}

/** Passes lines through parser; failing lines are skipped without dropping rest of batch. */
function parseInto(parser: TerminalParser, lines: readonly string[], out: TerminalEntry[]): void {
  for (const line of lines) {
    let entries: TerminalEntry[];
    try {
      entries = parser.push(line);
    } catch (err) {
      log.warnOnce(`terminal-parse:${errMsg(err)}`, tr('Terminal: linha do transcript ignorada ({0}).', [errMsg(err)]));
      continue;
    }
    for (const e of entries) out.push(e);
  }
}

/**
 * Real agent (or history session): reads transcript JSONL using dedicated FileTail. `transcriptPathOf`
 * notifies transcript swaps on primary (/clear); in a history session path never changes.
 */
class TranscriptSource implements ConversationSource {
  private tail: FileTail;
  /** Created in load(), which always runs before first poll(). */
  private parser!: TerminalParser;

  constructor(
    private readonly agentId: string,
    path: string,
    private readonly o: Required<Pick<TerminalOptions, 'transcriptPathOf' | 'createParser' | 'initTailBytes' | 'initEntries'>>,
    readonly intervalMs: number,
  ) {
    this.tail = new FileTail(path);
  }

  load(): TerminalInit {
    this.parser = this.o.createParser();
    const offset = this.tail.seekTail(this.o.initTailBytes);
    const keep = this.o.initEntries;
    let entries: TerminalEntry[] = [];
    let dropped = false;
    for (let i = 0; i < MAX_INIT_READS; i++) {
      const r = this.tail.read();
      parseInto(this.parser, r.lines, entries);
      // Drops excess entries during load (transcript with many small entries).
      if (entries.length > keep * 2) {
        entries = entries.slice(-keep);
        dropped = true;
      }
      if (!r.more) break;
    }
    if (entries.length > keep) {
      entries = entries.slice(-keep);
      dropped = true;
    }
    return { agentId: this.agentId, entries, truncated: offset > 0 || dropped };
  }

  poll(): PollResult {
    // /clear or /resume in same process: primary agent remains, transcript changes.
    const path = this.o.transcriptPathOf(this.agentId);
    if (path && path !== this.tail.path) {
      this.tail = new FileTail(path);
      return { init: this.load() };
    }
    const fresh: TerminalEntry[] = [];
    for (let i = 0; i < READS_PER_POLL; i++) {
      // File missing: `missing`, no lines; retries in subsequent cycles.
      const r = this.tail.read();
      if (r.reset) return { init: this.load() };
      parseInto(this.parser, r.lines, fresh);
      if (!r.more) break;
    }
    return { append: fresh };
  }
}

/** Demo agent: synthetic conversation constructed from title and simulated activities. */
class DemoSource implements ConversationSource {
  /** IDs from last generated list (already received by client). */
  private sent = new Set<string>();

  constructor(
    private readonly agentId: string,
    private readonly o: { office: Office; demoEntries: NonNullable<TerminalOptions['demoEntries']>; initEntries: number },
    readonly intervalMs: number,
  ) {}

  private list(): TerminalEntry[] | undefined {
    const d = this.o.office.detail(this.agentId);
    return d ? this.o.demoEntries(d.agent, d.history) : undefined;
  }

  load(): TerminalInit {
    const all = this.list() ?? [];
    this.sent = new Set(all.map((e) => e.id));
    const entries = all.slice(-this.o.initEntries);
    return { agentId: this.agentId, entries, truncated: entries.length < all.length };
  }

  poll(): PollResult {
    const all = this.list();
    if (!all) return { stop: true };
    const fresh = all.filter((e) => !this.sent.has(e.id));
    this.sent = new Set(all.map((e) => e.id));
    return { append: fresh };
  }
}

interface Stream {
  res: ServerResponse;
  timer: ReturnType<typeof setInterval> | null;
}

export class TerminalStreams {
  private streams = new Set<Stream>();
  private pinger: ReturnType<typeof setInterval> | null = null;
  private readonly createParser: () => TerminalParser;
  private readonly demoEntries: NonNullable<TerminalOptions['demoEntries']>;
  private readonly maxStreams: number;
  private readonly initTailBytes: number;
  private readonly initEntries: number;
  private readonly pollMs: number;
  private readonly demoPollMs: number;
  private readonly sessionPollMs: number;
  private readonly pingMs: number;

  constructor(private readonly opts: TerminalOptions) {
    this.createParser = opts.createParser ?? createTerminalParser;
    this.demoEntries = opts.demoEntries ?? demoTerminalEntries;
    this.maxStreams = opts.maxStreams ?? MAX_STREAMS;
    this.initTailBytes = opts.initTailBytes ?? INIT_TAIL_BYTES;
    this.initEntries = opts.initEntries ?? INIT_ENTRIES;
    this.pollMs = opts.pollMs ?? POLL_MS;
    this.demoPollMs = opts.demoPollMs ?? DEMO_POLL_MS;
    this.sessionPollMs = opts.sessionPollMs ?? SESSION_POLL_MS;
    this.pingMs = opts.pingMs ?? PING_MS;
  }

  get size(): number {
    return this.streams.size;
  }

  stop(): void {
    for (const s of [...this.streams]) {
      this.drop(s);
      s.res.end();
    }
  }

  /**
   * Opens agent terminal: `init` with recent conversation, then `append` with updates.
   * Prior to stream start, errors reply with JSON `{error}`: 404 (agent or transcript missing),
   * 429 (too many open terminals), or 500 (unreadable transcript).
   */
  attach(req: IncomingMessage, res: ServerResponse, agentId: string): void {
    const source = this.sourceFor(agentId);
    if (typeof source === 'string') return sendJson(res, 404, { error: source });
    this.serve(req, res, agentId, source);
  }

  /**
   * Opens conversation for a history session at transcript `path` (account, id, and path pre-validated).
   * `streamId` is sent in `init` (e.g. "session:<account>:<sessionId>"); `createParser` matches session tool
   * (HistorySession.createParser; default: Claude Code). Same attach error codes (429/500).
   */
  attachSession(req: IncomingMessage, res: ServerResponse, streamId: string, path: string, createParser?: () => TerminalParser): void {
    const o = { transcriptPathOf: () => undefined, createParser: createParser ?? this.createParser, initTailBytes: this.initTailBytes, initEntries: this.initEntries };
    this.serve(req, res, streamId, new TranscriptSource(streamId, path, o, this.sessionPollMs));
  }

  /** Terminal concurrency limit, `init` payload, and SSE stream from chosen source. */
  private serve(req: IncomingMessage, res: ServerResponse, id: string, source: ConversationSource): void {
    if (this.streams.size >= this.maxStreams) {
      return sendJson(res, 429, { error: tr('terminais abertos demais (máximo de {0}); feche algum e tente de novo', [this.maxStreams]) });
    }
    let init: TerminalInit;
    try {
      init = source.load();
    } catch (err) {
      log.warnOnce(`terminal-load:${id}:${errMsg(err)}`, tr('Terminal de {0}: não foi possível ler o transcript ({1}).', [id, errMsg(err)]));
      return sendJson(res, 500, { error: tr('não foi possível ler o transcript') });
    }
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const s: Stream = { res, timer: null };
    this.streams.add(s);
    this.write(s, frame('init', init));
    s.timer = setInterval(() => this.pump(s, source, id), source.intervalMs);
    s.timer.unref?.();
    const drop = () => this.drop(s);
    req.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
    if (!this.pinger) {
      this.pinger = setInterval(() => {
        for (const c of [...this.streams]) this.write(c, ': ping\n\n');
      }, this.pingMs);
      this.pinger.unref?.();
    }
  }

  /** Conversation source for agent, or 404 error message. */
  private sourceFor(agentId: string): ConversationSource | string {
    const office = this.opts.office;
    if (office.has(agentId)) {
      const path = this.opts.transcriptPathOf(agentId);
      if (!path) return tr('transcript do agente não encontrado');
      const parserFor = this.opts.parserFor;
      const createParser = parserFor ? () => parserFor(agentId) ?? this.createParser() : this.createParser;
      const o = { transcriptPathOf: this.opts.transcriptPathOf, createParser, initTailBytes: this.initTailBytes, initEntries: this.initEntries };
      return new TranscriptSource(agentId, path, o, this.pollMs);
    }
    // Demo agents are not among Office real agents, but office.detail resolves them.
    if (agentId.startsWith(DEMO_PREFIX) && office.detail(agentId)) {
      return new DemoSource(agentId, { office, demoEntries: this.demoEntries, initEntries: this.initEntries }, this.demoPollMs);
    }
    return tr('agente não encontrado');
  }

  private pump(s: Stream, source: ConversationSource, agentId: string): void {
    let r: PollResult;
    try {
      r = source.poll();
    } catch (err) {
      // E.g. transcript unreadable due to permissions. Retries on next cycle.
      log.warnOnce(`terminal:${agentId}:${errMsg(err)}`, tr('Terminal de {0}: {1}', [agentId, errMsg(err)]));
      return;
    }
    if (r.init) this.write(s, frame('init', r.init));
    if (r.append?.length) this.write(s, frame('append', r.append));
    // Agent vanished (demo disabled or simulated session ended): stream remains open with pings only.
    if (r.stop && s.timer) {
      clearInterval(s.timer);
      s.timer = null;
    }
  }

  private write(s: Stream, chunk: string): void {
    const res = s.res;
    if (res.destroyed || res.writableEnded) return this.drop(s);
    if (res.writableLength > MAX_BUFFERED) {
      this.drop(s);
      res.destroy();
      return;
    }
    res.write(chunk);
  }

  private drop(s: Stream): void {
    if (!this.streams.delete(s)) return;
    if (s.timer) clearInterval(s.timer);
    s.timer = null;
    if (!this.streams.size && this.pinger) {
      clearInterval(this.pinger);
      this.pinger = null;
    }
  }
}
