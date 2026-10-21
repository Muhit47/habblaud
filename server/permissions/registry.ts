// Answering via office: registry of pending permission requests.
//
// Claude Code PermissionRequest hook (mod/habblaud-permissoes/hooks/permission-hook.mjs, via
// habblaud-permissoes plugin or npm run hooks:install) sends requests to POST /api/permissions and long-polls GET /api/permissions/:id/wait.
// Web app responds via POST /api/permissions/:id/decision. The registry:
// - accepts request only if local web page is open and session is known (otherwise hook exits
//   immediately and terminal proceeds normally);
// - exposes request on agent (AgentInfo.permission, via Office) and publishes to feed;
// - delivers decision to hook (allow/deny, or AskUserQuestion answers) or releases without decision
//   ("answer in terminal");
// - discards orphaned requests: hook timeout, deceased hook process, exited agent, or prompt answered
//   directly in terminal (tool_result found in transcript).
//
// Codex uses same routes (PermissionRequest hook in mod/habblaud-codex/hook.mjs, with `provider: "codex"`
// and account). Differences: agent matched by thread (agent_id ?? session_id) across Codex agents; no
// suggestions or questions; deny strictly with reason; no transcript lookup (in Codex approval
// prompt happens after hook completes, so never answered in terminal while waiting).
import { randomBytes } from 'node:crypto';
import { describeTool, maskSecrets, truncate } from '../../shared/activity';
import { ANSWER_OTHER_MAX, answerSummary, ASK_TOOL, checkAnswers } from '../../shared/answers';
import type { Activity, AgentInfo, PermissionAnswer, PermissionDecision, PermissionRequestInfo, PermissionSuggestionInfo } from '../../shared/types';
import { errMsg, log } from '../log';
import { toolView } from '../sources/terminal';
import { codexToolView } from './codex';
import { callSignature, scanToolCall } from './transcript';
import { tr } from '../../shared/i18n';

/** Default timeout hook waits (hook specifies its own in `timeout_ms`). */
export const DEFAULT_TIMEOUT_MS = 300_000;
export const MIN_TIMEOUT_MS = 5_000;
export const MAX_TIMEOUT_MS = 24 * 60 * 60_000;
/** Grace period after hook timeout before request is evicted automatically. */
export const EXPIRY_GRACE_MS = 5_000;
/** Maximum duration of single long-poll (hook immediately re-polls afterwards). */
export const WAIT_MAX_MS = 25_000;
/** No hook polling for this duration = hook exited (cancelled, timed out, session aborted). */
export const ORPHAN_MS = 8_000;
/** Cached decision retained for hook transitioning between poll cycles. */
export const RESOLVED_KEEP_MS = 30_000;
/** Minimum interval between transcript checks for a pending request. */
export const SCAN_EVERY_MS = 1_000;
/** Primary waiting agent that ceased waiting for this duration: answered directly in terminal. */
export const LEFT_WAITING_MS = 3_000;
export const MAX_PENDING = 32;
/**
 * Extended timeout (HABBLAUD_PERMISSION_TIMEOUT above default) with no responding page and no remote client
 * configured: request reverts to terminal (preventing hanging up to 24 h unseen;
 * for background subagents terminal only shows prompt when hook completes).
 */
export const UNWATCHED_MS = 5 * 60_000;

const DESTINATIONS = new Set(['session', 'localSettings', 'projectSettings', 'userSettings']);
const MAX_SUGGESTIONS = 4;
const MAX_MESSAGE = 1_000;
const RULE_MAX = 160;
/** Answers in an `answer` decision (AskUserQuestion supports up to 4 questions). */
const MAX_ANSWERS = 4;

/** Office methods required by registry (minimal interface for testing). */
export interface OfficeLike {
  get(id: string): AgentInfo | undefined;
  list(): AgentInfo[];
  markDirty(): void;
  addActivity(id: string, activity: Activity, current: boolean, opts?: { feed?: boolean }): void;
  /** Notice "requests permission" or "has a question" (deduped with "needs you" status notice). */
  noticePermission(id: string, what: string, kind?: 'permission' | 'question'): void;
}

export interface RegistryOptions {
  office: OfficeLike;
  /** Connected local pages (Hub.localSize): if none, request is not diverted from terminal. */
  viewers: () => number;
  /** Whether page may answer later (authenticated remote client with `permissions` allowed). */
  answerLater?: () => boolean;
  /** Transcript path of an active agent (ClaudeWatcher.transcriptPathOf). */
  transcriptPathOf?: (agentId: string) => string | undefined;
  /**
   * Codex account (AgentInfo.account) from hook request, matched via CODEX_HOME directory (hook-calculated
   * basename lacks disambiguated IDs like ".codex~2"). undefined = hook account applies.
   */
  codexAccount?: (account: string | undefined, codexHome: string | undefined) => string | undefined;
  /** Decision for synthetic demo prompt (Office.decideDemoPermission); true = demo request handled. */
  demoDecide?: (id: string, d: PermissionDecision) => boolean;
  /** Details of synthetic demo request (snapshot already carries it). */
  demoDetail?: (id: string) => PermissionRequestInfo | undefined;
  now?: () => number;
  /** Internal clock interval (start). */
  tickMs?: number;
  orphanMs?: number;
  resolvedKeepMs?: number;
  maxPending?: number;
}

export type SkipReason = 'no-viewers' | 'unknown-session' | 'unsupported-tool' | 'too-many';
export type RegisterResult = { id: string; expiresAt: number } | { skip: SkipReason };
export type ReleaseReason = 'terminal' | 'answered' | 'expired' | 'orphan' | 'gone' | 'unwatched' | 'shutdown';

/**
 * Long-poll hook response. `answer`: answers by index (hook maps back to original
 * AskUserQuestion strings received from Claude Code).
 */
export type WaitResult =
  | { status: 'pending' }
  | { status: 'decided'; behavior: 'allow' | 'deny'; message?: string; interrupt?: boolean; suggestion?: number }
  | { status: 'decided'; behavior: 'answer'; answers: PermissionAnswer[] }
  | { status: 'released'; reason: ReleaseReason };

/**
 * invalid = unknown rule suggestion; invalid-answer = mismatched decision type (question
 * must be answered with `answer`) or invalid option indices; unsupported = Codex rejects
 * interruptions or "always allow".
 */
export type DecideResult = 'ok' | 'not-found' | 'conflict' | 'invalid' | 'invalid-answer' | 'unsupported';

/** Body validation error from hook (becomes 400). */
export class InvalidRequest extends Error {}

interface Waiter {
  done: (r: WaitResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** ORIGINAL AskUserQuestion schema: used to validate index-based option responses. */
interface AskFormat {
  multiSelect: boolean;
  /** Total option count in original prompt (including un-rendered options). */
  options: number;
}

interface Pending {
  /** Full detail version (with `input`): GET /api/permissions/:id. */
  info: PermissionRequestInfo;
  /** Codex request (omits transcript response scan). */
  codex?: boolean;
  /** Question (AskUserQuestion): format of `tool_input.questions` by index (undefined = invalid input). */
  askFormat?: Array<AskFormat | undefined>;
  agentId: string;
  sessionId: string;
  /** Hook agent_id (subagent request). */
  hookAgentId?: string;
  signature: string;
  toolUseId?: string;
  lastScanAt: number;
  /** Session registry already signaled primary agent waiting (dialogue opened in terminal). */
  sawWaiting?: boolean;
  /** Timestamp when agent stopped waiting (after having waited). */
  notWaitingSince?: number;
  waiters: Set<Waiter>;
  /** Timestamp since no hook has been polling. */
  idleSince: number;
  outcome?: Exclude<WaitResult, { status: 'pending' }>;
  resolvedAt?: number;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function shortStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined;
}

function isIndex(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** Prompt answered with `answer` (AskUserQuestion questions; Codex never sends via hook). */
function isQuestion(info: { tool: string; provider?: string }): boolean {
  return info.tool === ASK_TOOL && info.provider !== 'codex';
}

/** Codex does not support interruption or "always allow" (hook only approves or denies with reason). */
function unsupportedByCodex(info: PermissionRequestInfo, d: PermissionDecision): boolean {
  return info.provider === 'codex' && (d.interrupt === true || d.suggestion !== undefined);
}

/**
 * Decision mismatched with request type: `answer` applies only to questions, questions cannot be approved
 * without answers (deny and "answer in terminal" apply to both).
 */
function wrongKind(info: PermissionRequestInfo, d: PermissionDecision): boolean {
  return d.behavior === 'answer' ? !isQuestion(info) || !info.questions?.length : d.behavior === 'allow' && isQuestion(info);
}

/** Original format of AskUserQuestion questions, by index. */
function askFormat(raw: unknown): Array<AskFormat | undefined> {
  if (!Array.isArray(raw)) return [];
  return raw.map((q) => {
    const r = rec(q);
    return r ? { multiSelect: r.multiSelect === true, options: Array.isArray(r.options) ? r.options.length : 0 } : undefined;
  });
}

/** Genuine questions (with non-empty text) in original: all must be displayed in UI to be answerable. */
function askCount(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  return raw.filter((q) => {
    const text = rec(q)?.question;
    return typeof text === 'string' && !!text.trim();
  }).length;
}

/** Answer matches original prompt schema (option indices and selection count). */
function fitsFormat(f: AskFormat | undefined, a: PermissionAnswer): boolean {
  if (!f) return false;
  const options = a.options ?? [];
  if (options.some((i) => i >= f.options)) return false;
  return f.multiSelect || options.length + (a.other ? 1 : 0) === 1;
}

/** Agent still eligible to receive prompt (neither offline nor completed). */
function present(a: AgentInfo | undefined): a is AgentInfo {
  return !!a && a.status !== 'offline' && a.status !== 'done';
}

/** "Bash(npm test:*)" a partir de {toolName, ruleContent}. */
function ruleText(raw: unknown): string | undefined {
  const r = rec(raw);
  const tool = shortStr(r?.toolName, 200);
  if (!tool) return undefined;
  const content = typeof r?.ruleContent === 'string' && r.ruleContent.trim() ? r.ruleContent : undefined;
  return truncate(maskSecrets(content ? `${tool}(${content})` : tool), RULE_MAX);
}

/**
 * "Always allow" suggestions offered: strictly `addRules` with `behavior: "allow"` on known destination.
 * Web UI selects by index and hook applies ORIGINAL suggestion received from Claude Code
 * (server never synthesizes rules).
 */
export function pickSuggestions(raw: unknown): PermissionSuggestionInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: PermissionSuggestionInfo[] = [];
  raw.forEach((s, index) => {
    const r = rec(s);
    if (!r || r.type !== 'addRules' || r.behavior !== 'allow' || typeof r.destination !== 'string' || !DESTINATIONS.has(r.destination)) return;
    const rules = Array.isArray(r.rules) ? r.rules.map(ruleText).filter((x): x is string => !!x) : [];
    if (!rules.length || out.length >= MAX_SUGGESTIONS) return;
    out.push({ index, rules: rules.slice(0, 4), destination: r.destination });
  });
  return out;
}

/**
 * Attaches pending request to agent in snapshot (already cloned by Office). While request pending, agent
 * shows as 'waiting' — including background subagents whose dialogue only renders in terminal
 * once hook answers (Claude Code session registry does not flag background subagent as waiting).
 */
export function applyPermission(a: AgentInfo, p: PermissionRequestInfo | undefined): AgentInfo {
  if (!p || !present(a)) return a;
  a.permission = p;
  if (a.status !== 'waiting') {
    a.status = 'waiting';
    a.statusSince = p.createdAt;
  }
  a.waitingFor ??= isQuestion(p) ? tr('responder uma pergunta') : p.provider === 'codex' ? tr('aprovar um comando') : tr('aprovar uma permissão');
  return a;
}

/**
 * Validates hook JSON (identical to Claude Code stdin payload, with hook `timeout_ms`). Codex hook also
 * provides `provider: "codex"`, account (`account`, basename of CODEX_HOME), and path (`codexHome`);
 * `agent_id` is subagent thread (and `session_id`, root thread).
 */
export function parseHookInput(raw: unknown): {
  provider?: 'codex';
  account?: string;
  codexHome?: string;
  sessionId: string;
  agentId?: string;
  agentType?: string;
  cwd?: string;
  tool: string;
  input: Rec;
  suggestions: unknown;
  timeoutMs: number;
} {
  const r = rec(raw);
  const sessionId = shortStr(r?.session_id, 200);
  const tool = shortStr(r?.tool_name, 200);
  if (!r || !sessionId || !tool) throw new InvalidRequest(tr('esperado o JSON do hook PermissionRequest (session_id e tool_name)'));
  const t = typeof r.timeout_ms === 'number' && Number.isFinite(r.timeout_ms) ? r.timeout_ms : DEFAULT_TIMEOUT_MS;
  const codex = r.provider === 'codex';
  return {
    ...(codex ? { provider: 'codex' as const, account: shortStr(r.account, 200), codexHome: shortStr(r.codexHome, 4_096) } : {}),
    sessionId,
    agentId: shortStr(r.agent_id, 200),
    agentType: shortStr(r.agent_type, 120),
    cwd: shortStr(r.cwd, 4_096),
    tool,
    input: rec(r.tool_input) ?? {},
    suggestions: codex ? undefined : r.permission_suggestions,
    timeoutMs: Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, t)),
  };
}

/**
 * Answers for `answer` decision: up to MAX_ANSWERS, each with question index, selected option indices
 * (distinct, ascending order) and/or free text (trimmed, up to ANSWER_OTHER_MAX). Registry verifies
 * match against request questions (decide).
 */
function parseAnswers(raw: unknown): PermissionAnswer[] | undefined {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_ANSWERS) return undefined;
  const out: PermissionAnswer[] = [];
  for (const item of raw) {
    const r = rec(item);
    if (!r || !isIndex(r.question)) return undefined;
    const a: PermissionAnswer = { question: r.question };
    if (r.options !== undefined) {
      if (!Array.isArray(r.options) || !r.options.every(isIndex) || new Set(r.options).size !== r.options.length) return undefined;
      if (r.options.length) a.options = (r.options as number[]).slice().sort((x, y) => x - y);
    }
    if (r.other !== undefined) {
      if (typeof r.other !== 'string') return undefined;
      const other = r.other.trim();
      if (other.length > ANSWER_OTHER_MAX) return undefined;
      if (other) a.other = other;
    }
    out.push(a);
  }
  return out;
}

/** Decision payload received from web app. */
export function parseDecision(raw: unknown): PermissionDecision | undefined {
  const r = rec(raw);
  if (r?.behavior === 'answer') {
    const answers = parseAnswers(r.answers);
    return answers ? { behavior: 'answer', answers } : undefined;
  }
  if (!r || (r.behavior !== 'allow' && r.behavior !== 'deny' && r.behavior !== 'terminal')) return undefined;
  const d: PermissionDecision = { behavior: r.behavior };
  if (r.behavior === 'deny') {
    if (typeof r.message === 'string' && r.message.trim()) d.message = r.message.trim().slice(0, MAX_MESSAGE);
    if (r.interrupt === true) d.interrupt = true;
  }
  if (r.behavior === 'allow' && r.suggestion !== undefined) {
    if (typeof r.suggestion !== 'number' || !Number.isInteger(r.suggestion) || r.suggestion < 0) return undefined;
    d.suggestion = r.suggestion;
  }
  return d;
}

export class PermissionRegistry {
  private pending = new Map<string, Pending>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private readonly now: () => number;
  private readonly orphanMs: number;
  private readonly resolvedKeepMs: number;
  private readonly maxPending: number;
  /** Timestamp since no responsive page was connected (null = page connected). */
  private unwatchedSince: number | null = null;

  constructor(private readonly opts: RegistryOptions) {
    this.now = opts.now ?? Date.now;
    this.orphanMs = opts.orphanMs ?? ORPHAN_MS;
    this.resolvedKeepMs = opts.resolvedKeepMs ?? RESOLVED_KEEP_MS;
    this.maxPending = opts.maxPending ?? MAX_PENDING;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        log.warnOnce(`permissions-tick:${errMsg(err)}`, tr('Pedidos de permissão: falha no relógio ({0}).', [errMsg(err)]));
      }
    }, this.opts.tickMs ?? 500);
    this.timer.unref?.();
  }

  /** Stops timer and releases any waiting hooks (hook exits without deciding). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const p of this.pending.values()) if (!p.outcome) this.release(p, 'shutdown');
  }

  /** Open requests (pending decision). */
  get size(): number {
    let n = 0;
    for (const p of this.pending.values()) if (!p.outcome) n++;
    return n;
  }

  /**
   * Registers request from hook. `{skip}` = do not divert (hook exits immediately, terminal continues):
   * prompt cannot be rendered fully, no watcher present, unknown session, or requests
   * too frequent. Malformed payload throws InvalidRequest.
   */
  register(raw: unknown): RegisterResult {
    const req = parseHookInput(raw);
    const codex = req.provider === 'codex';
    const desc = codex ? codexToolView(req.tool, req.input, req.cwd) : describeTool(req.tool, req.input);
    const questions = 'questions' in desc ? desc.questions : undefined;
    const ask = isQuestion(req);
    // Question prompt: all must be displayed in UI (hook only answers if each question has response).
    if (ask && (!questions?.length || questions.length !== askCount(req.input.questions))) return { skip: 'unsupported-tool' };
    if (this.opts.viewers() <= 0) return { skip: 'no-viewers' };
    const target = codex
      ? this.resolveCodexAgent(req.sessionId, req.agentId, req.agentType, this.opts.codexAccount?.(req.account, req.codexHome) ?? req.account)
      : this.resolveAgent(req.sessionId, req.agentId, req.agentType);
    if (!target) return { skip: 'unknown-session' };
    if (this.size >= this.maxPending) return { skip: 'too-many' };

    const now = this.now();
    const id = `p-${now.toString(36)}-${++this.seq}-${randomBytes(9).toString('base64url')}`;
    // Codex: title, summary, and arguments via its tool names (permissions/codex.ts).
    const view = 'title' in desc ? desc : toolView(req.tool, req.input, req.cwd);
    const info: PermissionRequestInfo = { id, tool: req.tool, title: view.title, text: desc.text, icon: desc.icon, createdAt: now, expiresAt: now + req.timeoutMs };
    if (codex) info.provider = 'codex';
    if (view.input) info.input = view.input;
    if (view.inputKind) info.inputKind = view.inputKind;
    if (target.subagent) info.subagent = target.subagent;
    const suggestions = pickSuggestions(req.suggestions);
    if (suggestions.length) info.suggestions = suggestions;
    if (ask) info.questions = questions;

    const p: Pending = {
      info,
      agentId: target.id,
      sessionId: req.sessionId,
      signature: codex ? '' : callSignature(req.tool, req.input),
      lastScanAt: 0,
      waiters: new Set(),
      idleSince: now,
    };
    if (codex) p.codex = true;
    if (req.agentId) p.hookAgentId = req.agentId;
    if (ask) p.askFormat = askFormat(req.input.questions);
    this.pending.set(id, p);

    const by = target.subagent ? tr(' (subagente {0})', [target.subagent]) : '';
    const first = info.questions?.[0]?.question;
    if (first) {
      const all = info.questions!.map((q) => q.question).join(' · ');
      this.opts.office.addActivity(target.id, { id: `${target.id}#perm:${id}`, at: now, kind: 'wait', icon: '❓', text: truncate(tr('Pergunta: {0}', [first]), 46), detail: truncate(all, 300), tool: 'PermissionRequest' }, false);
      this.opts.office.noticePermission(target.id, `${truncate(first, 120)}${by}`, 'question');
    } else {
      this.opts.office.addActivity(target.id, { id: `${target.id}#perm:${id}`, at: now, kind: 'wait', icon: '🔐', text: truncate(tr('Pede permissão: {0}', [desc.text]), 46), detail: view.title, tool: 'PermissionRequest' }, false);
      this.opts.office.noticePermission(target.id, `${desc.text}${by}`);
    }
    this.opts.office.markDirty();
    return { id, expiresAt: info.expiresAt + EXPIRY_GRACE_MS };
  }

  /** Full detail of an open request (with arguments), or undefined. */
  detail(id: string): PermissionRequestInfo | undefined {
    const p = this.pending.get(id);
    if (p && !p.outcome) return { ...p.info, ...this.queueOf(p) };
    return this.opts.demoDetail?.(id);
  }

  /**
   * Oldest request per agent (without `input`, exposed only in details), with count of waiters
   * behind it. Populates Office snapshot.
   */
  snapshot(): Map<string, PermissionRequestInfo> {
    const out = new Map<string, PermissionRequestInfo>();
    const counts = new Map<string, number>();
    for (const p of this.pending.values()) {
      if (p.outcome) continue;
      counts.set(p.agentId, (counts.get(p.agentId) ?? 0) + 1);
      if (out.has(p.agentId)) continue;
      const { input: _input, inputKind: _kind, ...info } = p.info;
      out.set(p.agentId, info);
    }
    for (const [agentId, info] of out) {
      const n = (counts.get(agentId) ?? 1) - 1;
      if (n > 0) info.queued = n;
    }
    return out;
  }

  /**
   * Awaits decision for a request up to `ms`. undefined = unknown id (hook gives up). `cancel`
   * terminates waiter (connection closed). An existing decision returns immediately.
   */
  wait(id: string, ms: number): { result: Promise<WaitResult>; cancel: () => void } | undefined {
    const p = this.pending.get(id);
    if (!p) return undefined;
    if (p.outcome) {
      const outcome = p.outcome;
      // Delivered: no longer needs retention.
      this.pending.delete(id);
      return { result: Promise.resolve(outcome), cancel: () => {} };
    }
    let waiter: Waiter | undefined;
    const result = new Promise<WaitResult>((done) => {
      const timer = setTimeout(() => this.dropWaiter(p, waiter!, { status: 'pending' }), Math.max(0, Math.min(ms, WAIT_MAX_MS)));
      timer.unref?.();
      waiter = { done, timer };
      p.waiters.add(waiter);
    });
    return { result, cancel: () => waiter && this.dropWaiter(p, waiter) };
  }

  /** Web page decision. Demo requests route to `demoDecide` (with identical question rules). */
  decide(id: string, d: PermissionDecision): DecideResult {
    const p = this.pending.get(id);
    if (!p) {
      const demo = this.opts.demoDetail?.(id);
      if (demo && unsupportedByCodex(demo, d)) return 'unsupported';
      if (demo && (wrongKind(demo, d) || (d.behavior === 'answer' && !checkAnswers(demo.questions ?? [], d.answers)))) return 'invalid-answer';
      return this.opts.demoDecide?.(id, d) ? 'ok' : 'not-found';
    }
    if (p.outcome) return 'conflict';
    if (unsupportedByCodex(p.info, d)) return 'unsupported';
    if (d.suggestion !== undefined && !p.info.suggestions?.some((s) => s.index === d.suggestion)) return 'invalid';
    if (d.behavior === 'terminal') {
      this.release(p, 'terminal');
      return 'ok';
    }
    if (wrongKind(p.info, d)) return 'invalid-answer';
    if (d.behavior === 'answer') return this.answer(p, d.answers);
    const outcome: WaitResult = { status: 'decided', behavior: d.behavior };
    if (d.message) outcome.message = d.message;
    if (d.interrupt) outcome.interrupt = true;
    if (d.suggestion !== undefined) outcome.suggestion = d.suggestion;
    this.resolve(p, outcome);
    const now = this.now();
    const act: Activity =
      d.behavior === 'allow'
        ? { id: `${p.agentId}#perm-ok:${id}`, at: now, kind: 'other', icon: '✅', text: d.suggestion !== undefined ? tr('Aprovado no Habblaud (sempre permitir)') : tr('Aprovado no Habblaud'), detail: p.info.title, tool: 'PermissionRequest' }
        : { id: `${p.agentId}#perm-no:${id}`, at: now, kind: 'wait', icon: '🚫', text: tr('Recusado no Habblaud'), detail: d.message ? `${p.info.title} — ${d.message}` : p.info.title, tool: 'PermissionRequest' };
    this.opts.office.addActivity(p.agentId, act, false);
    return 'ok';
  }

  /**
   * AskUserQuestion answers: each rendered question answered exactly once, with its
   * options, validated against ORIGINAL format (hook resolves text by index).
   */
  private answer(p: Pending, raw: PermissionAnswer[] | undefined): DecideResult {
    const questions = p.info.questions ?? [];
    const answers = checkAnswers(questions, raw);
    if (!answers || answers.some((a) => !fitsFormat(p.askFormat?.[a.question], a))) return 'invalid-answer';
    this.resolve(p, { status: 'decided', behavior: 'answer', answers });
    const act: Activity = { id: `${p.agentId}#perm-answer:${p.info.id}`, at: this.now(), kind: 'other', icon: '💬', text: tr('Respondido no Habblaud'), detail: answerSummary(questions, answers), tool: 'PermissionRequest' };
    this.opts.office.addActivity(p.agentId, act, false);
    return 'ok';
  }

  /** Tick: expiration, orphans, departed agents, terminal answers, and cleanup of delivered decisions. */
  tick(): void {
    const now = this.now();
    this.unwatchedSince = this.opts.viewers() > 0 ? null : (this.unwatchedSince ?? now);
    const unwatched = this.unwatchedSince !== null && now - this.unwatchedSince >= UNWATCHED_MS && !this.opts.answerLater?.();
    for (const [id, p] of this.pending) {
      if (p.outcome) {
        if (now - (p.resolvedAt ?? now) >= this.resolvedKeepMs) this.pending.delete(id);
        continue;
      }
      if (now >= p.info.expiresAt + EXPIRY_GRACE_MS) this.release(p, 'expired');
      else if (!p.waiters.size && now - p.idleSince >= this.orphanMs) this.release(p, 'orphan');
      else if (!present(this.opts.office.get(p.agentId))) this.release(p, 'gone');
      else if (unwatched && p.info.expiresAt - p.info.createdAt > DEFAULT_TIMEOUT_MS) this.release(p, 'unwatched');
      // In Codex terminal requests approval after hook finishes: no terminal answers to scan.
      else if (p.codex) continue;
      else if (now - p.lastScanAt >= SCAN_EVERY_MS && this.answeredInTerminal(p, now)) this.release(p, 'answered');
      else if (this.leftWaiting(p, now)) this.release(p, 'answered');
    }
  }

  // ---------------------------------------------------------------- internos

  private resolveAgent(sessionId: string, agentId?: string, agentType?: string): { id: string; subagent?: string } | undefined {
    const office = this.opts.office;
    if (agentId) {
      const subId = `${sessionId}:${agentId}`;
      const sub = office.get(subId);
      if (present(sub) && sub.provider !== 'codex') return { id: subId };
    }
    const main = office.list().find((a) => a.kind === 'main' && a.provider !== 'codex' && a.sessionId === sessionId && a.status !== 'offline');
    if (!main) return undefined;
    return agentId ? { id: main.id, subagent: agentType ?? tr('subagente') } : { id: main.id };
  }

  /**
   * Codex agent associated with request: thread `agent_id ?? session_id` (subagent has dedicated thread; primary is
   * root thread). Account breaks ties (thread IDs are UUIDs). Un-rendered subagents: request assigns
   * to primary agent with its kind.
   */
  private resolveCodexAgent(sessionId: string, agentId: string | undefined, agentType: string | undefined, account: string | undefined): { id: string; subagent?: string } | undefined {
    const find = (thread: string): AgentInfo | undefined => {
      const found = this.opts.office.list().filter((a) => a.provider === 'codex' && a.sessionId === thread && present(a));
      return found.find((a) => a.account === account) ?? found[0];
    };
    const sub = agentId && agentId !== sessionId ? agentId : undefined;
    const own = sub ? find(sub) : undefined;
    if (own) return { id: own.id };
    const main = find(sessionId);
    if (!main) return undefined;
    return sub ? { id: main.id, subagent: agentType ?? tr('subagente') } : { id: main.id };
  }

  private queueOf(p: Pending): { queued?: number } {
    // By insertion order (Map order), not createdAt: two requests in same ms would tie and
    // count each other as "behind".
    let n = 0;
    let after = false;
    for (const o of this.pending.values()) {
      if (o === p) after = true;
      else if (after && !o.outcome && o.agentId === p.agentId) n++;
    }
    return n ? { queued: n } : {};
  }

  /** Did call's tool_result appear in transcript (answered in terminal)? Never throws. */
  private answeredInTerminal(p: Pending, now: number): boolean {
    p.lastScanAt = now;
    // Unmonitored subagents (prompt attributed to primary): transcript is unknown
    // and primary transcript lacks call; handled via expiration and orphan detection.
    if (p.hookAgentId && p.agentId !== `${p.sessionId}:${p.hookAgentId}`) return false;
    const path = this.opts.transcriptPathOf?.(p.agentId);
    if (!path) return false;
    try {
      const r = scanToolCall(path, { tool: p.info.tool, signature: p.signature, knownId: p.toolUseId, createdAt: p.info.createdAt });
      if (r.toolUseId) p.toolUseId = r.toolUseId;
      return r.answered;
    } catch {
      return false;
    }
  }

  /**
   * Fallback terminal detection, strictly for primary requests whose call was not found in
   * transcript: session registry showed open prompt ('waiting') and subsequently ceased showing
   * for LEFT_WAITING_MS. (When call was found, strictly tool_result applies: sequential prompts
   * transition through 'busy' between dialogues.)
   */
  private leftWaiting(p: Pending, now: number): boolean {
    if (p.hookAgentId || p.toolUseId) return false;
    const a = this.opts.office.get(p.agentId);
    if (a?.kind !== 'main') return false;
    if (a.status === 'waiting') {
      p.sawWaiting = true;
      delete p.notWaitingSince;
      return false;
    }
    if (!p.sawWaiting) return false;
    p.notWaitingSince ??= now;
    return now - p.notWaitingSince >= LEFT_WAITING_MS;
  }

  private dropWaiter(p: Pending, w: Waiter, result?: WaitResult): void {
    if (!p.waiters.delete(w)) return;
    clearTimeout(w.timer);
    if (!p.waiters.size) p.idleSince = this.now();
    if (result) w.done(result);
  }

  private resolve(p: Pending, outcome: Exclude<WaitResult, { status: 'pending' }>): void {
    p.outcome = outcome;
    p.resolvedAt = this.now();
    const delivered = p.waiters.size > 0;
    for (const w of [...p.waiters]) this.dropWaiter(p, w, outcome);
    // Delivered to waiter: removed immediately; otherwise retained until hook returns (or RESOLVED_KEEP_MS).
    if (delivered) this.pending.delete(p.info.id);
    this.opts.office.markDirty();
  }

  private release(p: Pending, reason: ReleaseReason): void {
    this.resolve(p, { status: 'released', reason });
  }
}
