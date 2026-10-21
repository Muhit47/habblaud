#!/usr/bin/env node
// Habblaud PermissionRequest hook: enables approving or denying Claude Code permission requests
// ("Do you want to...") and answering AskUserQuestion prompts from the office UI. Reaches the session via
// either of two paths (this file is the canonical source for both):
//
// - `habblaud-permissoes` plugin from repository marketplace (Claude Code 2.1.287+): adjacent hooks.json
//   executes `node "${CLAUDE_PLUGIN_ROOT}/hooks/permission-hook.mjs"`, reading port from HABBLAUD_PORT.
//   Claude Code copies ONLY the plugin folder to its cache: hence no imports outside `node:*` are allowed here;
// - `npm run hooks:install` (legacy approach), configuring each <account>/settings.json:
//
//   node /path/to/habblaud/mod/habblaud-permissoes/hooks/permission-hook.mjs [--port 4747] [--timeout 300]
//
// Claude Code renders terminal dialog and runs this hook CONCURRENTLY (first response wins);
// for background subagents, terminal dialog only appears after hook completes. The hook:
// 1. reads request JSON from stdin (session_id, tool_name, tool_input, permission_suggestions...);
// 2. posts to http://127.0.0.1:<port>/api/permissions. If Habblaud is offline, rejects (feature disabled),
//    or reports no active tab / unknown session, exits immediately undecided: terminal proceeds normally;
// 3. otherwise, polls decision on GET /api/permissions/:id/wait (loops of up to 25 s) until timeout
//    (default 5 min: --timeout <s> or HABBLAUD_PERMISSION_TIMEOUT);
// 4. approved/denied: prints decision (hookSpecificOutput.decision). Answered question: approves
//    call with ORIGINAL input plus `answers` ({question text: chosen option labels}, as official hook
//    documentation specifies for AskUserQuestion); UI selects by index and original texts are taken from stdin.
//    "Respond in terminal", timeout, or errors: exits silently, leaving terminal prompt active.
//
// Rules: pure Node (22+), no external dependencies; never hangs or breaks session (all errors = exit undecided).
// Connects to 127.0.0.1 only. HABBLAUD_HOOK_DEBUG=1 logs to stderr.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4747;
export const DEFAULT_TIMEOUT_S = 300;
const MIN_TIMEOUT_S = 5;
const MAX_TIMEOUT_S = 86_400;
/** Max timeout per long-poll (server replies "pending" and hook re-polls). */
const WAIT_S = 25;
/** Request registration: if Habblaud does not respond within this window, it is offline (or hung). */
const REGISTER_TIMEOUT_MS = 2_000;
const STDIN_TIMEOUT_MS = 5_000;
const MAX_STDIN = 8 * 1024 * 1024;
/** Argument texts sent to Habblaud (server displays only a preview). */
const MAX_STRING = 8_000;
/** Request body (server rejects payloads above 256 KB). */
const MAX_BODY = 200_000;
/** AskUserQuestion tool: response is a choice (`answer` decision), not simple approve/deny. */
const ASK_TOOL = 'AskUserQuestion';

const debug = process.env.HABBLAUD_HOOK_DEBUG === '1' ? (msg) => process.stderr.write(`[habblaud-hook] ${msg}\n`) : () => {};

/** Port and timeout: arguments (--port, --timeout) or environment (HABBLAUD_PORT, HABBLAUD_PERMISSION_TIMEOUT). */
export function parseOptions(argv, env = process.env) {
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const port = Number.parseInt(arg('port') ?? env.HABBLAUD_PORT ?? '', 10);
  const timeout = Number(arg('timeout') ?? env.HABBLAUD_PERMISSION_TIMEOUT ?? '');
  return {
    port: Number.isInteger(port) && port > 0 && port < 65_536 ? port : DEFAULT_PORT,
    timeoutMs: (Number.isFinite(timeout) && timeout > 0 ? Math.min(MAX_TIMEOUT_S, Math.max(MIN_TIMEOUT_S, timeout)) : DEFAULT_TIMEOUT_S) * 1_000,
  };
}

/** Corta textos longos dos argumentos (conteúdo de um Write enorme, por exemplo). */
export function trimInput(v, max = MAX_STRING, depth = 0) {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) : v;
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => trimInput(x, max, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = trimInput(x, max, depth + 1);
  return out;
}

/**
 * Request body forwarded to Habblaud: only relevant fields (no transcript_path or extraneous stdin).
 * If payload remains large (many simultaneous edits), text fields are trimmed more aggressively.
 */
export function requestBody(input, timeoutMs) {
  const body = { session_id: input.session_id, tool_name: input.tool_name, tool_input: {}, timeout_ms: timeoutMs };
  for (const k of ['agent_id', 'agent_type', 'cwd']) if (typeof input[k] === 'string') body[k] = input[k];
  if (Array.isArray(input.permission_suggestions)) body.permission_suggestions = input.permission_suggestions;
  for (const max of [MAX_STRING, 1_000, 200]) {
    body.tool_input = trimInput(input.tool_input ?? {}, max);
    if (JSON.stringify(body).length <= MAX_BODY) break;
  }
  return body;
}

/** Non-empty string (responses use original stdin strings without stripping whitespace). */
const text = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * AskUserQuestion `answers` map ({ORIGINAL question text: ORIGINAL option labels in selection order, plus
 * free-form input at end, joined by ", "}) computed from positional answers from Habblaud.
 * undefined = cannot resolve (exits undecided, falling back to terminal): missing `questions`, unanswered
 * or duplicate answers, invalid index, multiple choices on single-select, or duplicate question strings.
 */
export function answersFor(answers, toolInput) {
  const questions = Array.isArray(toolInput?.questions) ? toolInput.questions : undefined;
  if (!questions || !Array.isArray(answers) || !answers.length) return undefined;
  const out = {};
  const done = new Set();
  for (const a of answers) {
    const q = a && Number.isInteger(a.question) ? questions[a.question] : undefined;
    if (!q || typeof q !== 'object' || !text(q.question) || done.has(a.question) || Object.hasOwn(out, q.question)) return undefined;
    done.add(a.question);
    const options = Array.isArray(q.options) ? q.options : [];
    const parts = [];
    for (const i of Array.isArray(a.options) ? a.options : []) {
      const label = Number.isInteger(i) && i >= 0 ? options[i]?.label : undefined;
      if (!text(label)) return undefined;
      parts.push(label);
    }
    if (text(a.other)) parts.push(a.other.trim());
    if (!parts.length || (q.multiSelect !== true && parts.length > 1)) return undefined;
    out[q.question] = parts.join(', ');
  }
  // Every actual prompt requires a response (invalid ones are not displayed by Habblaud).
  if (questions.some((q, i) => q && typeof q === 'object' && text(q.question) && !done.has(i))) return undefined;
  return out;
}

/**
 * Hook output for Habblaud decision (undefined = exit undecided). An "always allow" rule selected
 * in the UI returns solely as an INDEX: the original suggestion sent by Claude Code is applied.
 * AskUserQuestion: only `answer` decision approves (without `answers` call lacks response); deny is supported.
 */
export function decisionOutput(result, input) {
  if (!result || result.status !== 'decided') return undefined;
  const ask = input?.tool_name === ASK_TOOL;
  if (result.behavior === 'answer') {
    const answers = ask ? answersFor(result.answers, input.tool_input) : undefined;
    if (!answers) return undefined;
    const decision = { behavior: 'allow', updatedInput: { ...input.tool_input, answers } };
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
  }
  if (result.behavior === 'allow') {
    if (ask) return undefined;
    const decision = { behavior: 'allow' };
    const list = Array.isArray(input?.permission_suggestions) ? input.permission_suggestions : [];
    const chosen = Number.isInteger(result.suggestion) ? list[result.suggestion] : undefined;
    if (chosen && typeof chosen === 'object') decision.updatedPermissions = [chosen];
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
  }
  if (result.behavior === 'deny') {
    const reason = typeof result.message === 'string' && result.message.trim() ? result.message.trim().slice(0, 1_000) : '';
    const decision = { behavior: 'deny', message: reason ? `Recusado pelo usuário no Habblaud: ${reason}` : 'Recusado pelo usuário no Habblaud.' };
    if (result.interrupt === true) decision.interrupt = true;
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
  }
  return undefined;
}

function readStdin() {
  return new Promise((ok) => {
    const chunks = [];
    let size = 0;
    const finish = (text) => {
      clearTimeout(timer);
      ok(text);
    };
    const timer = setTimeout(() => finish(undefined), STDIN_TIMEOUT_MS);
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size > MAX_STDIN) return finish(undefined);
      chunks.push(c);
    });
    process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => finish(undefined));
  });
}

/** Request to local Habblaud; null = offline, timed out, or unparseable response. */
async function call(base, method, path, body, timeoutMs) {
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  } catch (err) {
    debug(`${method} ${path}: ${err?.name ?? 'erro'} ${err?.message ?? ''}`);
    return null;
  }
}

/** Decides request (or not). Returns stdout payload to print, or undefined. Never throws. */
export async function run(argv = process.argv.slice(2), env = process.env, stdinText) {
  try {
    const opts = parseOptions(argv, env);
    const raw = stdinText ?? (await readStdin());
    if (!raw) return undefined;
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!input || typeof input !== 'object' || typeof input.session_id !== 'string' || typeof input.tool_name !== 'string') return undefined;
    if (input.hook_event_name !== undefined && input.hook_event_name !== 'PermissionRequest') return undefined;

    const base = `http://127.0.0.1:${opts.port}`;
    const deadline = Date.now() + opts.timeoutMs;
    const reg = await call(base, 'POST', '/api/permissions', requestBody(input, opts.timeoutMs), REGISTER_TIMEOUT_MS);
    if (!reg || reg.status !== 201 || typeof reg.json?.id !== 'string') {
      debug(`sem desvio (${reg ? `${reg.status} ${JSON.stringify(reg.json ?? null)}` : 'Habblaud fora do ar'})`);
      return undefined;
    }
    const id = encodeURIComponent(reg.json.id);
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) {
        debug('tempo esgotado: vale o terminal');
        return undefined;
      }
      const waitS = Math.max(0.05, Math.min(WAIT_S, left / 1_000));
      const r = await call(base, 'GET', `/api/permissions/${id}/wait?timeout=${waitS}`, undefined, waitS * 1_000 + 5_000);
      if (!r || r.status !== 200) return undefined;
      const status = r.json?.status;
      if (status === 'pending') continue;
      debug(`resposta: ${JSON.stringify(r.json)}`);
      return decisionOutput(r.json, input);
    }
  } catch (err) {
    debug(`erro: ${err?.message ?? err}`);
    return undefined;
  }
}

/** Entry point (exported for legacy shortcut scripts/permission-hook.mjs). */
export async function main() {
  const { timeoutMs } = parseOptions(process.argv.slice(2));
  // Safety net: ensure process does not outlive timeout.
  setTimeout(() => process.exit(0), timeoutMs + 15_000).unref();
  const out = await run();
  // Avoid process.exit() immediately after fetch: on Windows (Node 23 to 24.19) it crashes with
  // 0xC0000409 while V8 background-compiles fetch parser (libuv assertion,
  // nodejs/node#56645). Process exits naturally when loop drains, also flushing asynchronous
  // pipe writes (e.g. on macOS); if anything still holds the loop, process.exit follows 1 s later.
  const finish = () => setTimeout(() => process.exit(0), 1_000).unref();
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`, finish);
  else finish();
}

function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main().catch(() => process.exit(0));
