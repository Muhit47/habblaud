// Synthetic JSONL line builders matching Claude Code transcript format (for unit testing).
// Nothing here originates from real conversations.
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const ts = (at: number) => new Date(at).toISOString();

export interface LineOpts {
  at?: number;
  sessionId?: string;
  agentId?: string;
  gitBranch?: string;
}

function base(type: string, o: LineOpts): Record<string, unknown> {
  const rec: Record<string, unknown> = {
    type,
    uuid: uuid(),
    timestamp: ts(o.at ?? Date.now()),
    sessionId: o.sessionId ?? 'sess-teste',
    cwd: '/projetos/demo',
    gitBranch: o.gitBranch ?? 'main',
    isSidechain: !!o.agentId,
  };
  if (o.agentId) rec.agentId = o.agentId;
  return rec;
}

export const L = {
  prompt(text: string, o: LineOpts = {}): string {
    return JSON.stringify({ ...base('user', o), message: { role: 'user', content: text } });
  },
  meta(text: string, o: LineOpts = {}): string {
    return JSON.stringify({ ...base('user', o), isMeta: true, message: { role: 'user', content: text } });
  },
  assistant(
    blocks: Array<Record<string, unknown>>,
    o: LineOpts & { msgId?: string; stop?: string | null; usage?: Record<string, number>; model?: string } = {},
  ): string {
    return JSON.stringify({
      ...base('assistant', o),
      requestId: `req_${o.msgId ?? n}`,
      message: {
        id: o.msgId ?? `msg_${++n}`,
        role: 'assistant',
        model: o.model ?? 'claude-teste-1',
        content: blocks,
        stop_reason: o.stop ?? null,
        usage: o.usage ?? { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
      },
    });
  },
  thinking: () => ({ type: 'thinking', thinking: 'hmm', signature: 'x' }),
  text: (text: string) => ({ type: 'text', text }),
  tool: (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input }),
  result(
    id: string,
    content: string,
    o: LineOpts & { error?: boolean; toolUseResult?: unknown; extraText?: string } = {},
  ): string {
    const blocks: Array<Record<string, unknown>> = [{ type: 'tool_result', tool_use_id: id, content, ...(o.error ? { is_error: true } : {}) }];
    if (o.extraText) blocks.push({ type: 'text', text: o.extraText });
    const rec: Record<string, unknown> = { ...base('user', o), message: { role: 'user', content: blocks } };
    if (o.toolUseResult !== undefined) rec.toolUseResult = o.toolUseResult;
    return JSON.stringify(rec);
  },
  system(subtype: string, extra: Record<string, unknown> = {}, o: LineOpts = {}): string {
    return JSON.stringify({ ...base('system', o), subtype, ...extra });
  },
  /** Untimestamped metadata lines (custom-title, ai-title, cost-state...). */
  raw(type: string, fields: Record<string, unknown>): string {
    return JSON.stringify({ type, sessionId: 'sess-teste', ...fields });
  },
  notification(toolUseId: string, status: string, summary: string, o: LineOpts = {}): string {
    const text = `<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;
    return JSON.stringify({ ...base('user', o), origin: { kind: 'task-notification' }, message: { role: 'user', content: text } });
  },
  /**
   * Fork transcript header as recorded by Claude Code: parent context reference,
   * COPY of parent Agent call (matching tool_use ID from meta.json), and its result ("Fork
   * started…") with fork prompt after <fork-boilerplate> block.
   */
  forkStart(agentId: string, toolUseId: string, directive: string, o: LineOpts = {}): string[] {
    const ref = JSON.stringify({ type: 'fork-context-ref', agentId, parentSessionId: o.sessionId ?? 'sess-teste', parentLastUuid: uuid(), contextLength: 42 });
    const spawn = JSON.parse(L.assistant([L.tool(toolUseId, 'Agent', { description: 'x', subagent_type: 'fork', prompt: directive, run_in_background: true })], { ...o, agentId, stop: 'tool_use' })) as Record<string, unknown>;
    spawn.parentUuid = null;
    const text = `<fork-boilerplate>\nYou are a worker fork. Do the directive.\n</fork-boilerplate>\n\nYour directive: ${directive}`;
    return [ref, JSON.stringify(spawn), L.result(toolUseId, 'Fork started — processing in background', { ...o, agentId, extraText: text })];
  },
  /** Background Bash spawned: tool_result containing task ID (as recorded by Claude Code). */
  bgLaunched(toolUseId: string, taskId: string, o: LineOpts = {}): string {
    return L.result(toolUseId, `Command running in background with ID: ${taskId}. Output is being written to: /tmp/tasks/${taskId}.output`, {
      ...o,
      toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: taskId },
    });
  },
  /**
   * Completion of background shell: 'queue' = queue-operation line (enqueue upon exit);
   * 'message' = notification delivered to agent as user message.
   */
  shellNotification(
    via: 'queue' | 'message',
    n: { taskId: string; toolUseId?: string; status: string; summary?: string },
    o: LineOpts = {},
  ): string {
    const text = [
      '<task-notification>',
      `<task-id>${n.taskId}</task-id>`,
      ...(n.toolUseId ? [`<tool-use-id>${n.toolUseId}</tool-use-id>`] : []),
      `<output-file>/tmp/tasks/${n.taskId}.output</output-file>`,
      `<status>${n.status}</status>`,
      `<summary>${n.summary ?? `Background command "x" ${n.status}`}</summary>`,
      '</task-notification>',
    ].join('\n');
    if (via === 'queue') {
      return JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: ts(o.at ?? Date.now()), sessionId: o.sessionId ?? 'sess-teste', content: text });
    }
    return JSON.stringify({ ...base('user', o), origin: { kind: 'task-notification' }, message: { role: 'user', content: text } });
  },
};

/** Does file system preserve POSIX permission bits? On Windows, stat returns 0o666 (or 0o444 for read-only). */
export const HAS_POSIX_MODES = process.platform !== 'win32';

/** Statusline tap helpers (pure JavaScript, un-typed). */
const { originalShell } = (await import(pathToFileURL(resolve(__dirname, '../../scripts/statusline-tap.mjs')).href)) as { originalShell: () => string | true };

/**
 * Shell used by Claude Code to execute hooks and statusline commands:
 * /bin/sh; on Windows, Git Bash (discovered by tap). undefined = Windows without Git Bash (test skipped).
 */
export function posixShell(): string | undefined {
  if (process.platform !== 'win32') return '/bin/sh';
  const sh = originalShell();
  return typeof sh === 'string' ? sh : undefined;
}

/**
 * File symlinkSync, skipping test if system disallows link creation: on Windows this requires
 * Developer Mode or Administrator privileges (EPERM). Directory symlink: `'junction'` (requires no privileges).
 */
export function symlinkOrSkip(skip: (note: string) => never, target: string, path: string): void {
  try {
    symlinkSync(target, path);
  } catch (err) {
    if (process.platform === 'win32' && (err as NodeJS.ErrnoException).code === 'EPERM') skip('o Windows não deixou criar o link (Modo de Desenvolvedor desligado)');
    throw err;
  }
}

/** Temporary directory for test run (cleaned up via `cleanup`). */
export function tempDir(prefix = 'habblaud-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function writeLines(path: string, lines: string[]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, lines.map((l) => `${l}\n`).join(''));
}

export function appendLines(path: string, lines: string[]): void {
  appendFileSync(path, lines.map((l) => `${l}\n`).join(''));
}
