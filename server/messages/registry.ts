// Office messaging: queue for messages sent from web app to agents.
//
// Web app sends via POST /api/messages; plugin habblaud-mensagens (mod/habblaud-mensagens, polling every 2 s
// in each open session) fetches messages for its session via POST /api/mod/inbox, injects each as if typed by
// user, and acknowledges via POST /api/mod/inbox/ack. The registry:
// - tracks PRESENCE of each session polling inbox (AgentInfo.canMessage, via Office);
// - stores messages per agent sequentially and monitors status (queued → sent → delivered/failed);
// - fails messages unfetched within timeout, unacknowledged deliveries, exited agents, or conversations that
//   reset (/clear, /resume): each message is strictly bound to the session it targeted;
// - logs "Message via Habblaud" activity on agent upon delivery confirmation;
// - simulates delivery for demo agents (no real session involved).
// Raw message text is delivered exactly as entered by user and never exposed in web responses or server
// logs; only the activity feed receives a masked and truncated snippet.
//
// Codex agents lack plugins: messages are dispatched via Codex runner (`codex queue`, messages/codex.ts),
// never through plugin inbox. In Node mode server runs command directly (`codex.run` option); in Docker, host
// helper (npm run codex:bridge) polls POST /api/codex/bridge/poll and acks via POST /api/codex/bridge/ack.
// Same states, timeouts, and limits; canMessage = runner available (binary in Node mode or helper seen within
// PRESENCE_MS). `delivered` = successfully enqueued into session thread queue.
import { randomBytes } from 'node:crypto';
import { truncate } from '../../shared/activity';
import { describeMessage, MESSAGE_MAX } from '../../shared/messages';
import type { Activity, AgentInfo, InboxMessage, OutboxMessage } from '../../shared/types';
import { errMsg, log } from '../log';
import type { CodexQueueResult, CodexQueueRunner } from './codex';
import { tr } from '../../shared/i18n';

/** Session polling inbox within this window can receive messages (canMessage). */
export const PRESENCE_MS = 10_000;
/** Queued message not fetched within this duration fails. */
export const QUEUED_TIMEOUT_MS = 60_000;
/** Fetched message unconfirmed within this duration fails. */
export const SENT_TIMEOUT_MS = 30_000;
/** Resolved message retained for this duration for GET /api/messages/:id before eviction. */
export const KEEP_MS = 10 * 60_000;
/** Simulated delivery duration for demo agent message. */
export const DEMO_DELIVERY_MS = 1_000;
export const MAX_TEXT = MESSAGE_MAX;
/** Maximum unresolved messages per agent (subsequent request receives 429). */
export const MAX_OPEN = 5;
/** Maximum messages delivered to plugin per poll round. */
export const INBOX_BATCH = 5;

export const ERR_NOT_FETCHED = tr('a sessão não buscou a mensagem: o plugin habblaud-mensagens está instalado e a sessão aberta?');
export const ERR_NOT_CONFIRMED = tr('a sessão não confirmou a entrega');
export const ERR_GONE = tr('o agente saiu do escritório');
export const ERR_REFUSED = tr('a sessão não aceitou a mensagem');
export const ERR_SESSION_CHANGED = tr('a conversa do agente mudou (/clear ou /resume) antes da entrega');
export const ERR_CODEX_UNAVAILABLE =
  tr('não há como entregar ao Codex agora: rode o Habblaud fora do Docker com o `codex` no PATH (ou HABBLAUD_CODEX_BIN) ou, no Docker, deixe o npm run codex:bridge rodando no Mac');
export const ERR_CODEX_NOT_FETCHED = tr('o auxiliar do Codex não buscou a mensagem: o npm run codex:bridge está rodando no Mac?');
export const ERR_CODEX_SLOW = tr('o Codex demorou demais com as mensagens anteriores a este agente');
export const ERR_CODEX_NOT_CONFIRMED = tr('o auxiliar do Codex não confirmou a entrega');
export const ERR_CODEX_HOME = tr('a pasta da conta do Codex deste agente é desconhecida');
export const ERR_CODEX_REFUSED = tr('o codex queue não aceitou a mensagem');

const ERROR_MAX = 300;
const ID_MAX = 300;
const ACK_MAX = 50;

/** Minimal Office interface used by registry (simplifies unit testing). */
export interface OfficeLike {
  get(id: string): AgentInfo | undefined;
  list(): AgentInfo[];
  markDirty(): void;
  addActivity(id: string, activity: Activity, current: boolean): void;
}

/** Codex queue dispatcher (`codex queue`). */
export interface CodexDeliveryOptions {
  /** Node mode: runs `codex queue` directly (missing in Docker or without binary: host helper dispatches). */
  run?: CodexQueueRunner;
  /** CODEX_HOME directory (host path: AccountInfo.configDir) of a Codex account. */
  homeOf: (account: string) => string | undefined;
}

export interface MessageRegistryOptions {
  office: OfficeLike;
  /** Demo agent lookup (Office.demoAgent): exist exclusively in snapshot. */
  demoAgent?: (id: string) => AgentInfo | undefined;
  /** Synthetic delivery to demo agent (Office.deliverDemoMessage); false = agent departed. */
  demoDeliver?: (agentId: string, text: string) => boolean;
  /** Messaging for Codex agents; missing = feature disabled for Codex agents. */
  codex?: CodexDeliveryOptions;
  now?: () => number;
  /** Internal tick interval (start). */
  tickMs?: number;
  presenceMs?: number;
  queuedTimeoutMs?: number;
  sentTimeoutMs?: number;
  keepMs?: number;
  demoDeliveryMs?: number;
}

export type SendResult = { message: OutboxMessage } | { error: 'not-found' | 'too-many' } | { error: 'unavailable'; reason: string };

/** Message delivered to host Codex helper (POST /api/codex/bridge/poll): runs `codex queue` with it. */
export interface CodexBridgeMessage {
  id: string;
  account: string;
  /** Account CODEX_HOME on host machine. */
  codexHome: string;
  thread: string;
  /** Text exactly as entered by user. */
  text: string;
}

/** Body validation error (translates to 400 response). */
export class InvalidRequest extends Error {}

interface Entry {
  msg: OutboxMessage;
  /** Text as entered; cleared once message resolves. */
  text: string;
  /** Feed activity upon delivery confirmation (masked and truncated text prefix). */
  activity: ReturnType<typeof describeMessage>;
  /** Agent session when message was submitted: strictly targeted (session switch = failure). */
  target: string;
  /** Session that fetched message (sent): strictly authorized to confirm delivery. */
  session?: string;
  sentAt?: number;
  /** Demo agent message: never fetched via real inbox. */
  demo?: boolean;
  /** Codex agent message: dispatched via Codex runner ('node' = direct; 'bridge' = host helper). */
  codex?: true;
  via?: 'node' | 'bridge';
  /** Failed due to missing confirmation: late ack still reconciles state. */
  late?: boolean;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function shortStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined;
}

/** Active agent in office (neither offline nor completed). */
function present(a: AgentInfo | undefined): a is AgentInfo {
  return !!a && a.status !== 'offline' && a.status !== 'done';
}

const isFinal = (e: Entry) => e.msg.status === 'delivered' || e.msg.status === 'failed';

/**
 * Why agent cannot receive messages now (undefined = eligible). `reachable`: session has connected plugin (or,
 * for Codex, runner is available).
 */
function unavailableReason(a: AgentInfo, reachable: boolean): string | undefined {
  if (a.kind !== 'main') return tr('subagentes não recebem mensagens: mande para o agente principal');
  if (!present(a)) return tr('o agente já saiu do escritório');
  if (!reachable) return a.provider === 'codex' ? ERR_CODEX_UNAVAILABLE : tr('a sessão não está com o plugin habblaud-mensagens conectado (npm run mod:install)');
  return undefined;
}

/** Body of POST /api/messages: `{agentId, text}`. Text is not modified or trimmed. */
export function parseSend(raw: unknown): { agentId: string; text: string } {
  const r = rec(raw);
  const agentId = shortStr(r?.agentId, ID_MAX);
  if (!r || !agentId || typeof r.text !== 'string') throw new InvalidRequest('esperado {agentId, text}');
  if (!r.text.trim()) throw new InvalidRequest(tr('a mensagem está vazia'));
  if (r.text.length > MAX_TEXT) throw new InvalidRequest(tr('a mensagem passa de 20.000 caracteres'));
  return { agentId, text: r.text };
}

/** Confirmation results ({results: [{id, ok, error?}]}): valid entries up to ACK_MAX. */
function ackResults(raw: unknown): Array<{ id: string; ok: boolean; error?: string }> {
  const r = rec(raw);
  if (!r || !Array.isArray(r.results)) return [];
  const out: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const item of r.results.slice(0, ACK_MAX)) {
    const x = rec(item);
    const id = shortStr(x?.id, ID_MAX);
    if (!x || !id || typeof x.ok !== 'boolean') continue;
    out.push({ id, ok: x.ok, ...(typeof x.error === 'string' && x.error.trim() ? { error: truncate(x.error, ERROR_MAX) } : {}) });
  }
  return out;
}

export class MessageRegistry {
  private messages = new Map<string, Entry>();
  /** Timestamp of latest inbox poll for each primary agent session. */
  private seen = new Map<string, number>();
  /** Last timestamp host Codex helper polled messages. */
  private bridgeAt?: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private readonly now: () => number;
  private readonly presenceMs: number;
  private readonly queuedTimeoutMs: number;
  private readonly sentTimeoutMs: number;
  private readonly keepMs: number;
  private readonly demoDeliveryMs: number;

  constructor(private readonly opts: MessageRegistryOptions) {
    this.now = opts.now ?? Date.now;
    this.presenceMs = opts.presenceMs ?? PRESENCE_MS;
    this.queuedTimeoutMs = opts.queuedTimeoutMs ?? QUEUED_TIMEOUT_MS;
    this.sentTimeoutMs = opts.sentTimeoutMs ?? SENT_TIMEOUT_MS;
    this.keepMs = opts.keepMs ?? KEEP_MS;
    this.demoDeliveryMs = opts.demoDeliveryMs ?? DEMO_DELIVERY_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        log.warnOnce(`messages-tick:${errMsg(err)}`, tr('Mensagens: falha no relógio ({0}).', [errMsg(err)]));
      }
    }, this.opts.tickMs ?? 500);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Stored messages (including resolved messages, until cleanup). */
  get size(): number {
    return this.messages.size;
  }

  /**
   * Active primary agents eligible to receive messages: Claude Code agents whose session recently
   * polled inbox, and Codex agents if runner is available. Populates Office snapshot.
   */
  reachable(): Set<string> {
    const out = new Set<string>();
    for (const id of this.seen.keys()) if (this.canMessage(id)) out.add(id);
    if (this.codexAvailable()) for (const a of this.opts.office.list()) if (a.provider === 'codex' && a.kind === 'main' && present(a)) out.add(a.id);
    return out;
  }

  canMessage(agentId: string): boolean {
    const a = this.opts.office.get(agentId);
    if (a?.provider === 'codex') return this.codexAvailable() && present(a) && a.kind === 'main';
    const at = this.seen.get(agentId);
    if (at === undefined || this.now() - at >= this.presenceMs) return false;
    return present(a) && a.kind === 'main';
  }

  /** Whether delivery to Codex is available: direct binary in Node mode or active host helper. */
  codexAvailable(): boolean {
    const c = this.opts.codex;
    return !!c && (!!c.run || this.bridgeRecent());
  }

  /**
   * Message received from web app. `{error}`: unknown agent (not-found), ineligible agent (unavailable, with
   * reason: subagent, departed/completed, session without plugin, or Codex without runner), or queue limit
   * reached (too-many). Invalid body throws InvalidRequest.
   */
  send(raw: unknown): SendResult {
    const { agentId, text } = parseSend(raw);
    const real = this.opts.office.get(agentId);
    const demo = real ? undefined : this.opts.demoAgent?.(agentId);
    const agent = real ?? demo;
    if (!agent) return { error: 'not-found' };
    const reason = unavailableReason(agent, real ? this.canMessage(agentId) : demo!.canMessage === true);
    if (reason) return { error: 'unavailable', reason };
    let open = 0;
    for (const e of this.messages.values()) if (e.msg.agentId === agentId && !isFinal(e)) open++;
    if (open >= MAX_OPEN) return { error: 'too-many' };

    const now = this.now();
    const id = `m-${now.toString(36)}-${++this.seq}-${randomBytes(9).toString('base64url')}`;
    const entry: Entry = { msg: { id, agentId, status: 'queued', createdAt: now, updatedAt: now }, text, activity: describeMessage(text), target: agent.sessionId };
    if (demo) entry.demo = true;
    else if (real?.provider === 'codex') entry.codex = true;
    this.messages.set(id, entry);
    const out = { ...entry.msg };
    if (entry.codex) this.pumpCodex();
    return { message: out };
  }

  /** Message status (excluding text), or undefined. */
  get(id: string): OutboxMessage | undefined {
    const e = this.messages.get(id);
    return e ? { ...e.msg } : undefined;
  }

  /**
   * Plugin poll round: marks session presence and delivers pending messages for its agent (marking them
   * `sent`). Session without known primary agent: no messages. Malformed body: throws InvalidRequest.
   */
  inbox(raw: unknown): InboxMessage[] {
    const r = rec(raw);
    const session = shortStr(r?.session, ID_MAX);
    if (!r || !session) throw new InvalidRequest('esperado {session, account?}');
    const account = shortStr(r.account, ID_MAX);
    // Plugin belongs to Claude Code: Codex agents never receive through this channel.
    const agent = this.opts.office
      .list()
      .find((a) => a.kind === 'main' && a.provider !== 'codex' && a.sessionId === session && (!account || a.account === account) && present(a));
    if (!agent) return [];

    const now = this.now();
    const was = this.canMessage(agent.id);
    this.seen.set(agent.id, now);
    // Only presence change touches snapshot (round repeats every 2s).
    if (!was) this.opts.office.markDirty();

    const out: InboxMessage[] = [];
    for (const e of this.messages.values()) {
      if (out.length >= INBOX_BATCH) break;
      if (e.demo || e.codex || e.msg.agentId !== agent.id || e.msg.status !== 'queued' || e.target !== session) continue;
      this.setStatus(e, 'sent', now);
      e.session = session;
      e.sentAt = now;
      out.push({ id: e.msg.id, text: e.text });
    }
    return out;
  }

  /**
   * Plugin confirmation: `sent` → `delivered` (ok) or `failed` (with error reason). Strictly valid from
   * session that fetched message; unknown or mismatched IDs ignored. Late confirmation (after timeout failure)
   * still reconciles state: plugin authoritatively knows whether text was injected.
   */
  ack(raw: unknown): void {
    const r = rec(raw);
    const session = shortStr(r?.session, ID_MAX);
    if (!r || !session || !Array.isArray(r.results)) throw new InvalidRequest('esperado {session, results: [{id, ok, error?}]}');
    const now = this.now();
    for (const x of ackResults(r)) {
      const e = this.messages.get(x.id);
      if (!e || e.demo || e.codex || e.session !== session) continue;
      if (e.msg.status !== 'sent' && !(e.msg.status === 'failed' && e.late)) continue;
      if (x.ok) this.finish(e, 'delivered', now);
      else this.fail(e, now, x.error ?? ERR_REFUSED);
    }
  }

  /**
   * Host Codex helper round: marks its presence and delivers pending messages to Codex agents
   * (marking them `sent`), in per-agent sequence (no messages to an agent with in-flight delivery). In Node mode
   * server delivers directly: nothing dispatched here (avoids duplicate delivery).
   */
  codexPoll(raw: unknown): CodexBridgeMessage[] {
    if (!rec(raw)) throw new InvalidRequest(tr('esperado um objeto JSON ({})'));
    const c = this.opts.codex;
    if (!c) return [];
    const now = this.now();
    const was = this.codexAvailable();
    this.bridgeAt = now;
    if (!was) this.opts.office.markDirty();
    if (c.run) return [];

    const busy = new Set<string>();
    for (const e of this.messages.values()) if (e.codex && e.msg.status === 'sent') busy.add(e.msg.agentId);
    const out: CodexBridgeMessage[] = [];
    for (const e of this.messages.values()) {
      if (out.length >= INBOX_BATCH) break;
      if (!e.codex || e.msg.status !== 'queued' || busy.has(e.msg.agentId)) continue;
      busy.add(e.msg.agentId);
      const target = this.codexTarget(e, now);
      if (!target) continue;
      this.setStatus(e, 'sent', now);
      e.sentAt = now;
      e.via = 'bridge';
      out.push({ id: e.msg.id, account: target.account, codexHome: target.codexHome, thread: target.thread, text: e.text });
    }
    return out;
  }

  /**
   * Codex helper confirmation: `sent` → `delivered` (`codex queue` accepted) or `failed` (with reason). Strictly
   * valid for messages fetched by helper; late ack reconciles state like plugin. Invalid body throws.
   */
  codexAck(raw: unknown): void {
    const r = rec(raw);
    if (!r || !Array.isArray(r.results)) throw new InvalidRequest('esperado {results: [{id, ok, error?}]}');
    const now = this.now();
    this.bridgeAt = now;
    for (const x of ackResults(r)) {
      const e = this.messages.get(x.id);
      if (!e || !e.codex || e.via !== 'bridge') continue;
      if (e.msg.status !== 'sent' && !(e.msg.status === 'failed' && e.late)) continue;
      if (x.ok) this.finish(e, 'delivered', now);
      else this.fail(e, now, x.error ?? ERR_CODEX_REFUSED);
    }
  }

  /** Clock: deadlines, departed agent, mock demo delivery, expired presence, and resolved cleanup. */
  tick(): void {
    const now = this.now();
    for (const [id, e] of this.messages) {
      if (isFinal(e)) {
        if (now - e.msg.updatedAt >= this.keepMs) this.messages.delete(id);
        continue;
      }
      if (e.demo) {
        if (!present(this.opts.demoAgent?.(e.msg.agentId))) this.fail(e, now, ERR_GONE);
        else if (now - e.msg.createdAt >= this.demoDeliveryMs) {
          if (this.opts.demoDeliver?.(e.msg.agentId, e.text)) this.finish(e, 'delivered', now);
          else this.fail(e, now, ERR_GONE);
        }
        continue;
      }
      const a = this.opts.office.get(e.msg.agentId);
      if (!present(a)) this.fail(e, now, ERR_GONE);
      else if (e.msg.status === 'queued' && a.sessionId !== e.target) this.fail(e, now, ERR_SESSION_CHANGED);
      else if (e.msg.status === 'queued' && now - e.msg.createdAt >= this.queuedTimeoutMs) {
        this.fail(e, now, !e.codex ? ERR_NOT_FETCHED : this.opts.codex?.run ? ERR_CODEX_SLOW : ERR_CODEX_NOT_FETCHED);
      } else if (e.msg.status === 'sent' && now - (e.sentAt ?? now) >= this.sentTimeoutMs) {
        this.fail(e, now, e.codex ? ERR_CODEX_NOT_CONFIRMED : ERR_NOT_CONFIRMED);
        e.late = true;
      }
    }
    // Expired presence (or departed agent): snapshot updates to indicate messaging unavailable.
    for (const [agentId, at] of this.seen) {
      if (now - at < this.presenceMs && present(this.opts.office.get(agentId))) continue;
      this.seen.delete(agentId);
      this.opts.office.markDirty();
    }
    if (this.bridgeAt !== undefined && now - this.bridgeAt >= this.presenceMs) {
      this.bridgeAt = undefined;
      // Without binary in Node mode, Codex agents cease receiving.
      if (!this.opts.codex?.run) this.opts.office.markDirty();
    }
    this.pumpCodex();
  }

  // ---------------------------------------------------------------- internos

  private bridgeRecent(): boolean {
    return this.bridgeAt !== undefined && this.now() - this.bridgeAt < this.presenceMs;
  }

  /** Thread and account directory for Codex message; without them, message fails (returns undefined). */
  private codexTarget(e: Entry, now: number): { account: string; codexHome: string; thread: string } | undefined {
    const a = this.opts.office.get(e.msg.agentId);
    if (!present(a)) return void this.fail(e, now, ERR_GONE);
    if (a.sessionId !== e.target) return void this.fail(e, now, ERR_SESSION_CHANGED);
    const codexHome = this.opts.codex?.homeOf(a.account);
    if (!codexHome) return void this.fail(e, now, ERR_CODEX_HOME);
    return { account: a.account, codexHome, thread: a.sessionId };
  }

  /**
   * Node mode: runs `codex queue` for next message per Codex agent (one concurrent message per agent in order;
   * next dispatches after previous finishes).
   */
  private pumpCodex(): void {
    const run = this.opts.codex?.run;
    if (!run) return;
    const busy = new Set<string>();
    for (const e of this.messages.values()) if (e.codex && e.msg.status === 'sent') busy.add(e.msg.agentId);
    const now = this.now();
    for (const e of this.messages.values()) {
      if (!e.codex || e.msg.status !== 'queued' || busy.has(e.msg.agentId)) continue;
      busy.add(e.msg.agentId);
      const target = this.codexTarget(e, now);
      if (!target) continue;
      this.setStatus(e, 'sent', now);
      e.sentAt = now;
      e.via = 'node';
      run({ codexHome: target.codexHome, thread: target.thread, text: e.text }).then(
        (r) => this.codexDone(e, r),
        (err: unknown) => this.codexDone(e, { ok: false, error: errMsg(err) }),
      );
    }
  }

  /** Completion of `codex queue` run by this server. */
  private codexDone(e: Entry, r: CodexQueueResult): void {
    if (this.messages.get(e.msg.id) !== e) return;
    if (e.msg.status !== 'sent' && !(e.msg.status === 'failed' && e.late)) return;
    const now = this.now();
    if (r.ok) this.finish(e, 'delivered', now);
    else this.fail(e, now, truncate(r.error, ERROR_MAX) || ERR_CODEX_REFUSED);
    this.pumpCodex();
  }

  private setStatus(e: Entry, status: OutboxMessage['status'], now: number): void {
    e.msg.status = status;
    e.msg.updatedAt = now;
  }

  /** Resolves message: text is no longer needed. */
  private finish(e: Entry, status: 'delivered' | 'failed', now: number): void {
    this.setStatus(e, status, now);
    delete e.late;
    if (status === 'delivered') {
      delete e.msg.error;
      // Demo message dispatches to synthetic agent (Office.deliverDemoMessage).
      if (!e.demo) this.opts.office.addActivity(e.msg.agentId, { id: `${e.msg.agentId}#msg:${e.msg.id}`, at: now, ...e.activity }, false);
    }
    e.text = '';
  }

  private fail(e: Entry, now: number, error: string): void {
    e.msg.error = error;
    this.finish(e, 'failed', now);
  }
}
