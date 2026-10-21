// Office messaging integration (Claude Code 2.1.287+): routes text entered in Habblaud (in agent panel
// or key T terminal) into the Claude Code session, behaving as if typed in the CLI terminal.
//
// Key behavior, with `claude plugin validate` listing all module capabilities (output in mod/README.md):
//
// 1. Every 2 s, active only where session renders (`$.session.surfaces()` empty = `claude -p`/SDK: inactive) or in
//    desktop app sessions (CLAUDE_CODE_ENTRYPOINT=claude-desktop: SDK beneath, surface hidden offscreen), polls
//    local Habblaud for pending messages: POST http://127.0.0.1:<HABBLAUD_PORT or 4747>/api/mod/inbox with
//    {session, account}. This heartbeat signals session presence, enabling the office message box.
//    When offline or receiving non-2xx (403 = messaging disabled; 404 = legacy server without route),
//    polling backs off to every 30 s until service resumes.
// 2. Each message in order is submitted to session via `$.prompt.submit({ text, asUser: true })`: model interprets
//    as user input, omitting "The habblaud-mensagens plugin sent a message" banner (session transcript still tags plugin).
//    Text arrives verbatim. `{drop}` (hook denied) or exception = failure, with recorded reason.
//    If session is busy mid-turn, Claude Code queues the prompt; submit call waits at most 2 s.
//    Beyond 2 s, message is deemed queued and delivered, allowing remaining messages in batch to dispatch
//    sequentially without blocking. Thus polling pass finishes within seconds: presence heartbeat (10 s) and
//    ack window (30 s) do not time out on busy sessions. Trade-off: hooks rejecting prompt after 2 s are not reported.
// 3. Single POST /api/mod/inbox/ack with {session, results: [{id, ok, error?}]}. No messages = no ack.
//
// Rationale for separate plugin from `habblaud`: the base mod observes only (plan usage, status line,
// /habblaud) and never alters session execution. This plugin takes action: submits prompts on user's behalf.
// Kept separate so users can opt out (npm run mod:install -- --no-messages) and keeps static analysis focused.
//
// Rules: no hook throws (throwing hooks get skipped, leaving partial state): every step wrapped in
// try/catch and failure = silence. One polling cycle at a time (slow responses never pile up). No $.process,
// $.model, $.fs, transcript inspection, or tool control; network bound to 127.0.0.1 only. Module variables hold state:
// hot reload starts fresh (unconfirmed retrieved message times out on server in 30 s).
// Path helpers duplicate mod/habblaud/hooks/register.ts to allow standalone plugin distribution.
//
// Claude Code static analysis: all calls explicit ($.noun.method), event names are string literals,
// and `$` is only passed to functions declared at top level of this file.
import type { EngineInterface, HttpResponse, Register } from 'claude-code'

/** Default Habblaud port (matching server, base mod, and docker-compose). */
export const DEFAULT_PORT = 4747
/** Polling interval for Habblaud; drops back to offline interval when unreachable. */
export const POLL_MS = 2_000
export const OFFLINE_POLL_MS = 30_000
/** Max wait time for local Habblaud response (`$.http.fetch` lacks AbortSignal: raced with timer). */
export const FETCH_TIMEOUT_MS = 2_000
/** Max wait for `$.prompt.submit` resolution before considering message queued in session. */
export const SUBMIT_WAIT_MS = 2_000
/** Max length for failure reason (from hook or exception; message content is never truncated). */
export const MAX_REASON = 500

/** Message as delivered by POST /api/mod/inbox (shared/types.ts, InboxMessage). */
export interface InboxMessage {
  id: string
  /** Text as entered; empty if server provided non-string payload. */
  text: string
}

/** Message result, as received by POST /api/mod/inbox/ack. */
export interface AckResult {
  id: string
  ok: boolean
  error?: string
}

/** Outcome of `$.prompt.submit`. */
type Submitted = { ok: true } | { ok: false; error: string }

interface ModEnv {
  /** Account ID (folder name, matching server conventions); undefined without HOME (or USERPROFILE) and CLAUDE_CONFIG_DIR. */
  accountId?: string
  port: number
  /** Claude desktop app session (CLAUDE_CODE_ENTRYPOINT=claude-desktop): runs like SDK with surfaces
   *  active only while app window is rendered, but remains interactive and accepts prompts. */
  desktop: boolean
}

// ---------------------------------------------------------------------------------------------
// Pure functions (tested in tests/habblaud-mensagens.test.ts)
// ---------------------------------------------------------------------------------------------

/**
 * Normalizes path (duplicate slashes, `.`, `..`, and trailing slash): mod environment lacks node:path. Copied
 * from mod/habblaud: Windows paths (drive or UNC) use `/` with drive as root; on other platforms, `\`
 * is part of the name.
 */
export function normalizePath(p: string): string {
  const win = /^(?:[A-Za-z]:|\\\\)/.test(p)
  const slashed = win ? p.replace(/\\/g, '/') : p
  const drive = /^[A-Za-z]:(?=\/|$)/.exec(slashed)?.[0] ?? (win && slashed.startsWith('//') ? '/' : '')
  const rest = slashed.slice(drive.length)
  const abs = rest.startsWith('/')
  const out: string[] = []
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!abs) out.push(seg)
      continue
    }
    out.push(seg)
  }
  const joined = out.join('/')
  return drive + (abs ? `/${joined}` : joined || (drive ? '' : '.'))
}

/** `~` no começo vira o HOME. */
function expandHome(p: string, home: string | undefined): string {
  return home && /^~(?=[\\/]|$)/.test(p) ? home + p.slice(1) : p
}

/** Account config dir: first item in CLAUDE_CONFIG_DIR (`~` expanded) or ~/.claude. */
export function configDirOf(claudeConfigDir: string | undefined, home: string | undefined): string | undefined {
  const first = (claudeConfigDir ?? '').split(',')[0]?.trim() ?? ''
  if (first) return normalizePath(expandHome(first, home))
  return home ? normalizePath(`${home}/.claude`) : undefined
}

/** Account ID = folder name (server AccountInfo.id, e.g. ".claude-account2"). */
export function accountIdOf(configDir: string): string | undefined {
  const name = configDir.split('/').filter(Boolean).pop()
  return name && name !== '.' && name !== '..' ? name : undefined
}

export function portOf(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : DEFAULT_PORT
}

/** Body of POST /api/mod/inbox: includes account only when known. */
export function inboxBody(session: string, account: string | undefined): string {
  return JSON.stringify(account ? { session, account } : { session })
}

/** Body of POST /api/mod/inbox/ack. */
export function ackBody(session: string, results: readonly AckResult[]): string {
  return JSON.stringify({ session, results })
}

/**
 * Parses POST /api/mod/inbox response; invalid payloads return undefined (treated as offline). Items without id
 * are dropped (cannot be acknowledged); items with id and missing text enter with empty text, resolving as failure
 * rather than stalling the server for 30 s.
 */
export function parseInbox(text: string): InboxMessage[] | undefined {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined
  const list = (j as Record<string, unknown>).messages
  if (!Array.isArray(list)) return undefined
  const out: InboxMessage[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const m = item as Record<string, unknown>
    if (typeof m.id !== 'string' || !m.id) continue
    out.push({ id: m.id, text: typeof m.text === 'string' ? m.text : '' })
  }
  return out
}

/** Single-line failure reason with length ceiling: `{drop}` reason or exception message. */
export function reasonText(raw: unknown, fallback: string): string {
  const msg = typeof raw === 'string' ? raw : raw && typeof (raw as { message?: unknown }).message === 'string' ? (raw as { message: string }).message : ''
  const line = msg.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!line) return fallback
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line
}

// ---------------------------------------------------------------------------------------------
// Module state (reset on hot reload) and Claude Code integration
// ---------------------------------------------------------------------------------------------

let env: ModEnv | undefined
let timer: { cancel: () => void } | undefined
let timerMs = 0
/** Single cycle in flight: slow server or busy session does not queue multiple cycles. */
let polling = false

/** Session environment, loaded once per module load (explicit property access required by static analyzer). */
async function readEnv($: EngineInterface): Promise<ModEnv> {
  if (env) return env
  // On Windows, HOME only exists if defined: falls back to USERPROFILE (matching habblaud mod precedence).
  const home = (await $.env.get('HOME'))?.trim() || (await $.env.get('USERPROFILE'))?.trim() || undefined
  const configDir = configDirOf(await $.env.get('CLAUDE_CONFIG_DIR'), home)
  const next: ModEnv = {
    port: portOf(await $.env.get('HABBLAUD_PORT')),
    desktop: (await $.env.get('CLAUDE_CODE_ENTRYPOINT'))?.trim() === 'claude-desktop',
  }
  const accountId = configDir ? accountIdOf(configDir) : undefined
  if (accountId) next.accountId = accountId
  env = next
  return next
}

/** Resolves promise within timeout; on expiration returns undefined (promise continues in background). */
async function waitAtMost<T>($: EngineInterface, promise: Promise<T>, ms: number): Promise<T | undefined> {
  let wait: { cancel: () => void } | undefined
  const timeout = new Promise<undefined>((resolve) => {
    wait = $.clock.after(ms, () => resolve(undefined))
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    wait?.cancel()
  }
}

/** Posts JSON to local Habblaud with 2 s timeout: returns response, or undefined (offline/hung). Never throws. */
async function postJson($: EngineInterface, port: number, path: string, body: string): Promise<HttpResponse | undefined> {
  try {
    const request = $.http.fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      // Without Content-Type, server guard rejects POST (415).
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
    })
    return await waitAtMost($, request, FETCH_TIMEOUT_MS)
  } catch {
    return undefined
  }
}

/** Submits one message to session, behaving as if typed by user. Never throws. */
async function submitOne($: EngineInterface, text: string): Promise<Submitted> {
  try {
    const r = await $.prompt.submit({ text, asUser: true })
    if (typeof r?.drop === 'string') return { ok: false, error: reasonText(r.drop, 'um hook da sessão recusou a mensagem') }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: reasonText(err, 'a sessão não aceitou a mensagem') }
  }
}

/** Delivers messages to session sequentially and returns individual results. Never throws. */
async function deliver($: EngineInterface, messages: readonly InboxMessage[]): Promise<AckResult[]> {
  const results: AckResult[] = []
  /** Submit timed out: session is busy and subsequent messages queue behind it without blocking. */
  let queued = false
  for (const m of messages) {
    if (!m.text.trim()) {
      results.push({ id: m.id, ok: false, error: 'mensagem vazia' })
      continue
    }
    const submitted = submitOne($, m.text)
    if (queued) {
      void submitted
      results.push({ id: m.id, ok: true })
      continue
    }
    const out = await waitAtMost($, submitted, SUBMIT_WAIT_MS)
    if (!out) {
      queued = true
      results.push({ id: m.id, ok: true })
    } else results.push(out.ok ? { id: m.id, ok: true } : { id: m.id, ok: false, error: out.error })
  }
  return results
}

/** (Re)schedules polling cycles: 2 s while online, 30 s while offline. */
function schedule($: EngineInterface, ms: number): void {
  if (timer && timerMs === ms) return
  timer?.cancel()
  timerMs = ms
  timer = $.clock.every(ms, () => {
    void round($)
  })
}

/** Single cycle: polls session messages, delivers each, and confirms ack. Never throws. */
async function round($: EngineInterface): Promise<void> {
  if (polling) return
  polling = true
  try {
    const e = await readEnv($)
    const surfaces = await $.session.surfaces()
    if (!surfaces.length && !e.desktop) return
    const session = await $.session.id()
    const res = await postJson($, e.port, '/api/mod/inbox', inboxBody(session, e.accountId))
    const messages = res?.ok ? parseInbox(res.text) : undefined
    if (!messages) {
      schedule($, OFFLINE_POLL_MS)
      return
    }
    schedule($, POLL_MS)
    if (!messages.length) return
    const results = await deliver($, messages)
    // Failed ack: server marks messages as failed after 30 s ("session did not confirm delivery").
    await postJson($, e.port, '/api/mod/inbox/ack', ackBody(session, results))
  } catch {
    // silence: next cycle retries
  } finally {
    polling = false
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    try {
      schedule($, POLL_MS)
    } catch {
      // without polling cycles, session proceeds normally
    }
    return next(e)
  })
}
