// Habblaud Mod (Claude Code 2.1.287+): connects each session to the office without inspecting conversations.
//
// Performs three small tasks, and `claude plugin validate` lists exactly what the module calls (output
// is in mod/README.md):
//
// 1. Plan usage (replaces statusline tap): at `session.start` and upon each `session.measure`
//    (after each turn and whenever a quota threshold shifts a whole percentage point) writes
//    <HABBLAUD_USAGE_DIR or ~/.habblaud/usage>/<account>.json in the SAME format as scripts/statusline-tap.mjs
//    ({accountId, configDir, fetchedAt, five_hour, seven_day}, `resets_at` in seconds) plus
//    `source: "mod"`. The server reads these files in server/accounts/statusline.ts.
// 2. A status line beneath the prompt when ANOTHER session needs you: polls local Habblaud every 5 s
//    (GET /api/mod/summary, which omits this session and its subagents from the list). When offline, the
//    line disappears and polling drops to every 30 s until service resumes. Only active where session renders
//    (`$.session.surfaces()` empty = `claude -p`/SDK: nothing to display, nothing to poll).
// 3. /habblaud: office summary command handled directly by the mod (no LLM calls, zero token usage).
//
// Rules: no hook throws (a throwing hook is skipped, but leaves partial state): every
// step is wrapped in try/catch and failure = silence. No $.process, $.model, $.prompt, tool
// decisions, or conversation reading; network traffic restricted to 127.0.0.1. State is kept in module
// variables: hot reload starts fresh, costing at most an extra usage file rewrite.
//
// Claude Code static analysis: all calls written explicitly ($.noun.method), event names are
// always string literals, and `$` is only passed to functions declared at top level of this file.
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

/** Default Habblaud port (matching server, permission hook, and docker-compose). */
export const DEFAULT_PORT = 4747
/** Polling interval for Habblaud; drops back to offline interval when unreachable. */
export const POLL_MS = 5_000
export const OFFLINE_POLL_MS = 30_000
/** Max wait time for local Habblaud response (`$.http.fetch` lacks AbortSignal: raced with timer). */
export const FETCH_TIMEOUT_MS = 2_000
/** Identical values written within this window are not rewritten (matching tap rule). */
export const MIN_REWRITE_MS = 10_000
/** Number of names listed beneath prompt before "and N more". */
const MAX_NAMES = 3

/** A tap-formatted usage window: 0–100 percentage and reset time in SECONDS since epoch. */
export interface UsageWindow {
  utilization: number
  resets_at?: number
}

/** Usage record file: tap format plus `source` identifier. */
export interface UsageRecord {
  accountId: string
  configDir: string
  fetchedAt: number
  five_hour?: UsageWindow
  seven_day?: UsageWindow
  source: 'mod'
}

/** Pending agent needing user attention, as returned by GET /api/mod/summary (excluding demo and current session). */
export interface WaitingAgent {
  id: string
  name: string
  room: string
  account: string
  waitingFor: string
  since?: number
  /** Indicates pending permission request answerable via the office UI. */
  answerable: boolean
}

export interface Summary {
  version: string
  agents: number
  working: number
  waiting: WaitingAgent[]
}

/** Outcome of polling Habblaud: successful summary, offline, or legacy server without mod route. */
type Asked = { kind: 'ok'; summary: Summary } | { kind: 'offline' } | { kind: 'outdated' }

interface ModEnv {
  /** Account config directory and id (basename), calculated as tap does; undefined if HOME (or USERPROFILE) and CLAUDE_CONFIG_DIR missing. */
  configDir?: string
  accountId?: string
  /** Usage directory; undefined if HOME (or USERPROFILE) and HABBLAUD_USAGE_DIR missing. */
  usageDir?: string
  port: number
}

// ---------------------------------------------------------------------------------------------
// Pure functions (tested in tests/habblaud.test.ts)
// ---------------------------------------------------------------------------------------------

/**
 * Normalizes path (duplicate slashes, `.`, `..`, and trailing slash): mod environment lacks node:path.
 * Windows paths (drive or UNC) use `/`, accepted by Windows, and drive letter (`C:`) counts
 * as root: Docker server (Linux) can still parse account folder name from stored configDir. On
 * other platforms, `\` is part of name (Linux and macOS) and left as is.
 */
export function normalizePath(p: string): string {
  const win = /^(?:[A-Za-z]:|\\\\)/.test(p)
  const slashed = win ? p.replace(/\\/g, '/') : p
  // Root: drive letter or leading UNC slashes (`\\nas\share` becomes `//nas/share`, needing both).
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

/** Leading `~` resolves to HOME (as tap does with CLAUDE_CONFIG_DIR and HABBLAUD_USAGE_DIR). */
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

export function usageDirOf(habblaudUsageDir: string | undefined, home: string | undefined): string | undefined {
  const d = (habblaudUsageDir ?? '').trim()
  if (d) return normalizePath(expandHome(d, home))
  return home ? normalizePath(`${home}/.habblaud/usage`) : undefined
}

export function portOf(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : DEFAULT_PORT
}

/**
 * A rate limit window from `$.session.usage().rateLimits` in tap format. `percentUsed` is 0 to 100
 * (exceeds 100 only on exceeded spend limits, which are ignored); `resetsAt` is ISO 8601, tap records SECONDS.
 */
export function windowOf(rl: SessionRateLimit | undefined): UsageWindow | undefined {
  if (!rl || typeof rl.percentUsed !== 'number' || !Number.isFinite(rl.percentUsed)) return undefined
  const w: UsageWindow = { utilization: Math.min(100, Math.max(0, rl.percentUsed)) }
  const ms = typeof rl.resetsAt === 'string' ? Date.parse(rl.resetsAt) : Number.NaN
  if (Number.isFinite(ms)) w.resets_at = Math.round(ms / 1_000)
  return w
}

/**
 * The written usage record, or undefined if no usable window (outside subscriptions or prior to first
 * API response, `rateLimits` is empty). Only `five_hour` and `seven_day`: gateway `spend_limit`
 * is not a plan quota limit.
 */
export function usageRecord(rateLimits: readonly SessionRateLimit[], configDir: string, now: number): UsageRecord | undefined {
  const accountId = accountIdOf(configDir)
  if (!accountId) return undefined
  const five = windowOf(rateLimits.find((r) => r.kind === 'five_hour'))
  const week = windowOf(rateLimits.find((r) => r.kind === 'seven_day'))
  if (!five && !week) return undefined
  const rec: UsageRecord = { accountId, configDir, fetchedAt: now, source: 'mod' }
  if (five) rec.five_hour = five
  if (week) rec.seven_day = week
  return rec
}

/** Single line text (names and rooms come from server; newlines would break status line). */
function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? oneLine(v) : undefined
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
}

/** Parses GET /api/mod/summary response; malformed output returns undefined (treated as offline). */
export function parseSummary(text: string): Summary | undefined {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined
  const r = j as Record<string, unknown>
  if (!Array.isArray(r.waiting)) return undefined
  const waiting: WaitingAgent[] = []
  for (const item of r.waiting) {
    if (!item || typeof item !== 'object') continue
    const w = item as Record<string, unknown>
    const name = str(w.name)
    if (!name) continue
    const agent: WaitingAgent = {
      id: str(w.id) ?? name,
      name,
      room: str(w.room) ?? '?',
      account: str(w.account) ?? '',
      waitingFor: str(w.waitingFor) ?? 'responder no terminal',
      answerable: w.answerable === true,
    }
    if (typeof w.since === 'number' && Number.isFinite(w.since)) agent.since = w.since
    waiting.push(agent)
  }
  return { version: str(r.version) ?? '?', agents: count(r.agents), working: count(r.working), waiting }
}

/** Text for prompt status line: undefined when nobody (aside from this session) needs attention. */
export function statusText(waiting: readonly WaitingAgent[]): string | undefined {
  const first = waiting[0]
  if (!first) return undefined
  if (waiting.length === 1) return `🏢 ${first.name} precisa de você em ${first.room}`
  const shown = waiting.slice(0, MAX_NAMES).map((w) => `${w.name} (${w.room})`)
  const rest = waiting.length - shown.length
  return `🏢 ${waiting.length} precisam de você: ${shown.join(', ')}${rest > 0 ? ` e mais ${rest}` : ''}`
}

/** Output for /habblaud when Habblaud server is online. */
export function summaryText(s: Summary, url: string): string {
  const agents = s.agents === 1 ? '1 agente' : `${s.agents} agentes`
  const waiting = s.waiting.length === 0 ? 'ninguém precisa de você' : s.waiting.length === 1 ? '1 precisa de você' : `${s.waiting.length} precisam de você`
  const lines = [`Habblaud ${s.version} em ${url}`, `${agents} · ${s.working} trabalhando · ${waiting}`]
  for (const w of s.waiting) lines.push(`✋ ${w.name} (${w.room}): ${w.waitingFor}${w.answerable ? ' · dá para responder pelo escritório' : ''}`)
  return lines.join('\n')
}

export function offlineText(url: string): string {
  return `O Habblaud não respondeu em ${url}. Para subir: npm run docker:up na pasta do Habblaud.`
}

export function outdatedText(url: string): string {
  return `O Habblaud em ${url} está numa versão sem a rota do mod. Para atualizar: git pull e npm run docker:up na pasta do Habblaud.`
}

// ---------------------------------------------------------------------------------------------
// Module state (reset on hot reload) and Claude Code integration
// ---------------------------------------------------------------------------------------------

let env: ModEnv | undefined
/** Last written usage record (key = file + values), preventing rewrites within 10 s. */
let lastWrite: { key: string; at: number } | undefined
/** Status line text; null = untouched during this load (first update always executes). */
let lastStatus: string | undefined | null = null
let timer: { cancel: () => void } | undefined
let timerMs = 0
/** Single poll in flight: slow responses do not queue up. */
let polling = false

/** Session environment, loaded once per module load (explicit property access required by static analyzer). */
async function readEnv($: EngineInterface): Promise<ModEnv> {
  if (env) return env
  // On Windows, HOME only exists if defined: falls back to USERPROFILE (same order as server: HOME then homedir()).
  const home = (await $.env.get('HOME'))?.trim() || (await $.env.get('USERPROFILE'))?.trim() || undefined
  const configDir = configDirOf(await $.env.get('CLAUDE_CONFIG_DIR'), home)
  const next: ModEnv = {
    port: portOf(await $.env.get('HABBLAUD_PORT')),
    usageDir: usageDirOf(await $.env.get('HABBLAUD_USAGE_DIR'), home),
  }
  if (configDir) {
    next.configDir = configDir
    const accountId = accountIdOf(configDir)
    if (accountId) next.accountId = accountId
  }
  env = next
  return next
}

/** Writes account usage (if windows exist and changed or interval passed). May throw: caller suppresses. */
async function writeUsage($: EngineInterface, rateLimits: readonly SessionRateLimit[]): Promise<void> {
  if (!rateLimits.length) return
  const e = await readEnv($)
  if (!e.configDir || !e.usageDir) return
  const now = await $.clock.now()
  const rec = usageRecord(rateLimits, e.configDir, now)
  if (!rec) return
  const file = `${e.usageDir}/${rec.accountId}.json`
  const key = JSON.stringify([file, rec.configDir, rec.five_hour, rec.seven_day])
  if (lastWrite && lastWrite.key === key && now - lastWrite.at >= 0 && now - lastWrite.at < MIN_REWRITE_MS) return
  // $.fs.write creates directory if missing and is NOT atomic: server reader ignores partial
  // reads and retains the last valid record (server/accounts/statusline.ts).
  await $.fs.write(file, `${JSON.stringify(rec)}\n`)
  lastWrite = { key, at: now }
}

/** GET /api/mod/summary with 2 s timeout; never throws. */
async function askHabblaud($: EngineInterface, port: number, query: string): Promise<Asked> {
  let wait: { cancel: () => void } | undefined
  const timeout = new Promise<undefined>((resolve) => {
    wait = $.clock.after(FETCH_TIMEOUT_MS, () => resolve(undefined))
  })
  try {
    const res = await Promise.race([$.http.fetch(`http://127.0.0.1:${port}/api/mod/summary${query}`, { headers: { accept: 'application/json' } }), timeout])
    if (!res) return { kind: 'offline' }
    // 404 JSON = legacy Habblaud server prior to mod route; other 404 = not Habblaud.
    if (res.status === 404 && res.text.includes('rota desconhecida')) return { kind: 'outdated' }
    const summary = res.ok ? parseSummary(res.text) : undefined
    return summary ? { kind: 'ok', summary } : { kind: 'offline' }
  } catch {
    return { kind: 'offline' }
  } finally {
    wait?.cancel()
  }
}

/** Updates status line only when text changes. */
function setStatus($: EngineInterface, text: string | undefined): void {
  if (text === lastStatus) return
  lastStatus = text
  $.ui.status(text)
}

/** (Re)schedules polling: 5 s while online, 30 s while offline. */
function schedule($: EngineInterface, ms: number): void {
  if (timer && timerMs === ms) return
  timer?.cancel()
  timerMs = ms
  timer = $.clock.every(ms, () => {
    void poll($)
  })
}

/** Single polling pass for prompt status line. Never throws. */
async function poll($: EngineInterface): Promise<void> {
  if (polling) return
  polling = true
  try {
    const surfaces = await $.session.surfaces()
    if (!surfaces.length) {
      setStatus($, undefined)
      return
    }
    const e = await readEnv($)
    const params = new URLSearchParams()
    if (e.accountId) params.set('account', e.accountId)
    params.set('session', await $.session.id())
    const asked = await askHabblaud($, e.port, `?${params.toString()}`)
    if (asked.kind !== 'ok') {
      setStatus($, undefined)
      schedule($, OFFLINE_POLL_MS)
      return
    }
    schedule($, POLL_MS)
    setStatus($, statusText(asked.summary.waiting))
  } catch {
    // silence: next interval retries
  } finally {
    polling = false
  }
}

/** Output for /habblaud: whole office summary (unfiltered by session, matching screen counts). */
async function habblaudText($: EngineInterface): Promise<string> {
  const e = await readEnv($)
  const url = `http://localhost:${e.port}`
  const asked = await askHabblaud($, e.port, '')
  if (asked.kind === 'outdated') return outdatedText(url)
  if (asked.kind === 'offline') return offlineText(url)
  return summaryText(asked.summary, url)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'habblaud', description: 'Resumo do Habblaud: quantos agentes, quem trabalha e quem precisa de você' })
    } catch {
      // without command registration, remainder continues
    }
    try {
      const usage = await $.session.usage()
      await writeUsage($, usage.rateLimits)
    } catch {
      // write failure = silence (Habblaud retains last recorded value)
    }
    try {
      schedule($, POLL_MS)
    } catch {
      // without prompt notification, remainder continues
    }
    return next(e)
  })

  // After each turn and whenever quota shifts a point. `e` provides current `$.session.usage()`
  // metrics, avoiding redundant queries.
  on('session.measure', async ($, e, next) => {
    try {
      await writeUsage($, e.rateLimits)
    } catch {
      // write failure = silence
    }
    return next(e)
  })

  on('command.run', { command: 'habblaud' }, async ($) => {
    try {
      return { text: await habblaudText($) }
    } catch {
      return { text: offlineText(`http://localhost:${env?.port ?? DEFAULT_PORT}`) }
    }
  })
}
