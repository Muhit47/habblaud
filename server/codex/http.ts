// Codex hook events (mod/habblaud-codex/hook.mjs, registered in <CODEX_HOME>/hooks.json by
// npm run codex:install): SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop,
// SubagentStart, SubagentStop, and SessionEnd arrive with account ID and route to Codex source (CodexLive),
// updating the agent immediately without waiting for transcripts to flush to disk. Events are read-only (responses
// never return to session), accepted strictly from local computer: security locks (local Host and loopback
// connection outside Docker) enforced in http/app.ts. Edge guard (http/guard.ts) enforces JSON content type.
//
//   POST /api/codex/events   (hook)   {account?, codexHome?, event: <hook stdin, truncated text>}: 200 {ok}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import type { AccountEntry } from '../accounts/service';
import { HttpError, readJson, sendJson } from '../http/app';
import { errMsg, log } from '../log';
import type { CodexLive } from '../sources/codex/live';
import { tr } from '../../shared/i18n';

type Rec = Record<string, unknown>;

export interface CodexHookEvent {
  /** Account inferred by hook (basename of CODEX_HOME). */
  account?: string;
  /** Session CODEX_HOME directory on host running the hook. */
  codexHome?: string;
  /** Hook stdin payload (hook_event_name, session_id...). */
  event: Rec;
}

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function shortStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined;
}

/** Body of POST /api/codex/events. Missing `event` (object with hook_event_name): 400. */
export function parseCodexEvent(raw: unknown): CodexHookEvent {
  const r = rec(raw);
  const event = rec(r?.event);
  if (!r || !event || typeof event.hook_event_name !== 'string') throw new HttpError(400, 'expected {account?, codexHome?, event: <Codex hook JSON>}');
  const out: CodexHookEvent = { event };
  const account = shortStr(r.account, 200);
  const codexHome = shortStr(r.codexHome, 4_096);
  if (account) out.account = account;
  if (codexHome) out.codexHome = codexHome;
  return out;
}

/**
 * Codex account for a hook event: matches CODEX_HOME path sent (host path, AccountInfo.configDir,
 * or path read by this process); falls back to calculated account (basename unaware of disambiguated IDs, e.g. ".codex~2").
 */
export function codexAccountOf(entries: readonly AccountEntry[], account: string | undefined, codexHome: string | undefined): string | undefined {
  if (codexHome && isAbsolute(codexHome)) {
    const abs = resolve(codexHome);
    const e = entries.find((x) => resolve(x.detected.configDir) === abs || resolve(x.dir) === abs);
    if (e) return e.id;
  }
  return account;
}

/** Handles POST /api/codex/events (method and Host pre-validated). `ok` = Codex source consumed the event. */
export async function handleCodexEvent(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { live?: CodexLive; entries: () => readonly AccountEntry[] },
): Promise<void> {
  const body = parseCodexEvent(await readJson(req));
  let ok = false;
  if (deps.live) {
    try {
      ok = deps.live.applyHookEvent(codexAccountOf(deps.entries(), body.account, body.codexHome), body.event) === true;
    } catch (err) {
      log.warnOnce(`codex-event:${errMsg(err)}`, tr('Eventos do Codex: falha ao aplicar um evento ({0}).', [errMsg(err)]));
    }
  }
  sendJson(res, 200, { ok });
}
