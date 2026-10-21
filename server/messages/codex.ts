// Office messages for Codex sessions: `codex queue --thread <threadId> --message <text>` enqueues message
// into thread queue (consumed when session is idle; thread owner polls queue every ~10 s; turn created
// carries turn_trigger "queue"). Command must execute on host machine with account's CODEX_HOME:
// - Node mode: server executes command directly (binary HABBLAUD_CODEX_BIN or `codex` in PATH);
// - Docker: host helper (scripts/codex-bridge.ts, npm run codex:bridge) polls messages via
//   POST /api/codex/bridge/poll, executes command, and acknowledges via POST /api/codex/bridge/ack.
// Without shell (execFile), with timeout, never with -c, --enable, --disable, or --no-daemon (which could mutate configuration
// or session daemon). Exit code 0 ("Queued message <id> for thread <thread>.") = enqueued — even if no
// session currently has thread open; non-zero exit = failed, and first stderr line explains reason ("Error: ... no rollout
// found for thread id ..."). If shared Codex daemon is not running, command automatically starts it.
// Pure Node with zero dependencies: also imported by host helper (via tsx).
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { tr } from '../../shared/i18n';

/** Timeout for `codex queue` command. */
export const QUEUE_TIMEOUT_MS = 20_000;
/** Codex thread ID (UUID; `codex queue --thread` accepts names, but Habblaud always sends IDs). */
export const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_MAX = 300;

export interface CodexQueueJob {
  /** Account CODEX_HOME directory (host path). */
  codexHome: string;
  /** Thread ID (AgentInfo.sessionId of Codex agent). */
  thread: string;
  /** Text exactly as entered by user. */
  text: string;
}

export type CodexQueueResult = { ok: true } | { ok: false; error: string };
export type CodexQueueRunner = (job: CodexQueueJob) => Promise<CodexQueueResult>;

function canExecute(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Binary name in PATH. On Windows, strictly `codex.exe`: extensionless `codex` and `codex.cmd` generated
 * by npm are scripts that execFile (without shell) cannot invoke.
 */
export const CODEX_BIN_NAME = process.platform === 'win32' ? 'codex.exe' : 'codex';

/** Codex binary: HABBLAUD_CODEX_BIN (executable path) or `codex` in PATH. undefined = not found. */
export function findCodexBin(env: NodeJS.ProcessEnv, isExecutable: (p: string) => boolean = canExecute): string | undefined {
  const explicit = env.HABBLAUD_CODEX_BIN?.trim();
  if (explicit) return isExecutable(explicit) ? explicit : undefined;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, CODEX_BIN_NAME);
    if (isExecutable(p)) return p;
  }
  return undefined;
}

/** Arguments for `codex queue` (with "=": text starting with "-" is never parsed as a flag). */
export function queueArgs(thread: string, text: string): string[] {
  return ['queue', `--thread=${thread}`, `--message=${text}`];
}

/** First non-empty line (Codex prints error as "Error: ..."), truncated. */
export function firstLine(s: string | undefined): string | undefined {
  const line = (s ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length > ERROR_MAX ? `${line.slice(0, ERROR_MAX - 1)}…` : line;
}

/** Runs `codex queue` with given binary. Never rejects: failures resolve to `{ok: false, error}`. */
export function createCodexQueueRunner(bin: string, opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): CodexQueueRunner {
  const timeoutMs = opts.timeoutMs ?? QUEUE_TIMEOUT_MS;
  return (job) =>
    new Promise<CodexQueueResult>((done) => {
      if (!THREAD_ID.test(job.thread)) return done({ ok: false, error: tr('id de thread do Codex inválido') });
      if (!isAbsolute(job.codexHome)) return done({ ok: false, error: tr('pasta da conta do Codex inválida') });
      const env = { ...(opts.env ?? process.env), CODEX_HOME: job.codexHome };
      try {
        execFile(bin, queueArgs(job.thread, job.text), { env, timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true, encoding: 'utf8' }, (err, _stdout, stderr) => {
          if (!err) return done({ ok: true });
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.killed) return done({ ok: false, error: tr('o codex queue não respondeu em {0} s (a mensagem pode ter entrado na fila mesmo assim)', [Math.round(timeoutMs / 1_000)]) });
          if (e.code === 'ENOENT' || e.code === 'EACCES') return done({ ok: false, error: tr('não consegui rodar o Codex ({0})', [bin]) });
          done({ ok: false, error: firstLine(stderr) ?? tr('o codex queue falhou (código {0})', [String(e.code ?? '?')]) });
        });
      } catch {
        // Argument invalid for process spawn (e.g. NUL byte in message string).
        done({ ok: false, error: tr('a mensagem tem caracteres que não dá para mandar ao Codex') });
      }
    });
}
