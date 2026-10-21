// Spawn new agent via office UI. Fully automated execution: background Claude Code session
// (`claude --bg -n <name> -- <prompt>` in chosen directory), starting immediately, appearing in office like
// any session, receiving messages and permission prompts via Habblaud (`claude attach <id>` opens in Mac terminal).
// Claude Code only permits this in trusted folders (trust prompt accepted in terminal); if folder
// is untrusted or `claude` binary unavailable, falls back to deep link `claude://code/new?folder=<dir>&q=<prompt>`
// (matching Finder's "New Claude Code Session Here"), opening prefilled session modal in desktop app:
// user starts it by pressing Enter on Mac. Runner must execute on machine hosting desktop app:
// - Node mode: server directly;
// - Docker: host helper (scripts/codex-bridge.ts, npm run codex:bridge) polls requests via
//   POST /api/host/spawn/poll, checks folder, executes, and confirms via POST /api/host/spawn/ack.
// Attachments (spawn/attachments.ts): persisted to ~/.habblaud/attachments/ with paths appended to prompt.
// Shell-less execution (execFile), with timeout, prompt appended after `--` (never a sub-command flag).
// Pure Node zero-dependency: also imported by host helper (via tsx).
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { tr } from '../../shared/i18n';
import { attachmentsRoot, promptWithAttachments, writeAttachments, type Attachment, type AttachmentStore } from './attachments';

/** Maximum prompt size (entire link passed via command line to `open`). */
export const PROMPT_MAX = 8_000;
export const FOLDER_MAX = 1_024;
/** Prazo do `open`. */
export const OPEN_TIMEOUT_MS = 10_000;
/** Timeout for `claude --bg` (initializes background daemon on first run and returns). */
export const CLI_TIMEOUT_MS = 30_000;
const NAME_MAX = 48;
/** Helper considered present until this window after latest poll round. */
export const HOST_PRESENCE_MS = 10_000;
/**
 * Fetched unacknowledged request fails; unfetched request also times out. Execution may take `claude --bg`
 * plus `open` (CLI_TIMEOUT_MS + OPEN_TIMEOUT_MS): fetched timeout covers both comfortably, and UI waits
 * longer than both combined (client/src/ui/spawn.ts) to avoid premature timeout reports.
 */
export const SENT_TIMEOUT_MS = CLI_TIMEOUT_MS + OPEN_TIMEOUT_MS + 10_000;
export const QUEUED_TIMEOUT_MS = 30_000;
/** Resolved requests retained for this duration for GET queries. */
export const KEEP_MS = 10 * 60_000;
const MAX_OPEN = 5;
const ERROR_MAX = 300;

export interface SpawnRequest {
  folder: string;
  prompt: string;
}

export type SpawnStatus = 'queued' | 'sent' | 'opened' | 'failed';

/** Spawn method: `cli` = backgrounded daemon session; `app` = desktop app prefilled awaiting Enter. */
export type SpawnHow = 'cli' | 'app';

export interface SpawnInfo {
  id: string;
  folder: string;
  status: SpawnStatus;
  error?: string;
  how?: SpawnHow;
  /** For `app` method following `claude --bg` attempt: reason why backgrounding failed. */
  note?: string;
}

export type OpenResult = { ok: true } | { ok: false; error: string };
export type Opener = (url: string) => Promise<OpenResult>;
export type CliResult = { ok: true; id: string } | { ok: false; error: string };
/** Runs request as background Claude Code session. */
export type CliRunner = (req: SpawnRequest) => Promise<CliResult>;
export type LaunchResult = { ok: true; how: SpawnHow; note?: string } | { ok: false; error: string };

/** Validates POST /api/spawn body; returns parsed request or rejection reason. */
export function parseSpawn(raw: unknown): SpawnRequest | { error: string } {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const folder = typeof r.folder === 'string' ? r.folder.trim() : '';
  const prompt = typeof r.prompt === 'string' ? r.prompt.replace(/\s+$/, '') : '';
  if (!folder || folder.length > FOLDER_MAX || folder.includes('\0') || !(isAbsolute(folder) || /^[A-Za-z]:[\\/]/.test(folder))) {
    return { error: tr('escolha uma pasta (caminho absoluto, ex.: /Users/voce/projeto)') };
  }
  if (prompt.length > PROMPT_MAX || prompt.includes('\0')) return { error: tr('o pedido passa de {0} caracteres', [PROMPT_MAX]) };
  return { folder, prompt };
}

/** Deep link parsed by Claude desktop app (claude://code/new; `q` = pre-filled prompt). */
export function spawnUrl(req: SpawnRequest): string {
  const q = new URLSearchParams();
  q.set('folder', req.folder);
  if (req.prompt.trim()) q.set('q', req.prompt);
  q.set('source', 'habblaud');
  return `claude://code/new?${q.toString().replace(/\+/g, '%20')}`;
}

/** Background session label: "Habblaud: " + first line snippet of prompt. */
export function sessionName(prompt: string): string {
  const line = prompt.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const cut = line.length > NAME_MAX ? `${line.slice(0, NAME_MAX - 1)}…` : line;
  return cut ? `Habblaud: ${cut}` : 'Habblaud';
}

/** Arguments to `claude`: prompt after `--` (a prompt "doctor" or "-x" is still a prompt). */
export function cliArgs(req: SpawnRequest): string[] {
  const args = ['--bg', '-n', sessionName(req.prompt)];
  return req.prompt.trim() ? [...args, '--', req.prompt] : args;
}

/** `claude --bg` in target folder; returns short ID ("backgrounded · 7eacc670 · name"). */
export function createCliRunner(bin: string, timeoutMs = CLI_TIMEOUT_MS): CliRunner {
  return (req) =>
    new Promise((ok) => {
      const child = execFile(bin, cliArgs(req), { cwd: req.folder, timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, out, stderr) => {
        const id = /backgrounded\s*·\s*([\w-]+)/.exec(out ?? '')?.[1];
        if (!err && id) return ok({ ok: true, id });
        const line = [stderr, out, err?.message].map((t) => (t ?? '').split('\n').map((l) => l.trim()).find(Boolean)).find(Boolean);
        ok({ ok: false, error: (line ?? tr('o claude não começou a sessão')).slice(0, ERROR_MAX) });
      });
      child.stdin?.end();
    });
}

/** User-facing UI notice when `claude --bg` failed to execute directly. */
export function cliNote(error: string): string {
  return /not trusted/i.test(error)
    ? tr('a pasta ainda não é confiável para o Claude Code: rode `claude` nela uma vez no computador e aceite o aviso')
    : error;
}

/** Runs in background; fallback opens prefilled desktop app (explaining why). */
export async function launch(req: SpawnRequest, open: Opener, cli?: CliRunner): Promise<LaunchResult> {
  let note: string | undefined;
  if (cli) {
    const r = await cli(req).catch((err: unknown) => ({ ok: false as const, error: String((err as Error)?.message ?? err) }));
    if (r.ok) return { ok: true, how: 'cli' };
    note = cliNote(r.error);
  }
  const o = await open(spawnUrl(req)).catch(() => ({ ok: false as const, error: tr('falhou ao abrir o app') }));
  if (!o.ok) return note ? { ok: false, error: tr('{0}; e o app não abriu ({1})', [note, o.error]).slice(0, ERROR_MAX) } : o;
  return note ? { ok: true, how: 'app', note } : { ok: true, how: 'app' };
}

/** Verifies folder exists on this computer (helper verifies on host; Docker cannot inspect host paths). */
export function folderProblem(folder: string, stat: (p: string) => { isDirectory(): boolean } = statSync): string | undefined {
  try {
    return stat(folder).isDirectory() ? undefined : tr('não é uma pasta');
  } catch {
    return tr('pasta não encontrada neste computador');
  }
}

/** `open`/`xdg-open`/`start` sem shell. */
export function createOpener(platform: NodeJS.Platform = process.platform, timeoutMs = OPEN_TIMEOUT_MS): Opener {
  const [bin, pre] = platform === 'darwin' ? ['open', []] : platform === 'win32' ? ['cmd', ['/c', 'start', '""']] : ['xdg-open', []];
  return (url) =>
    new Promise((ok) => {
      execFile(bin, [...pre, url], { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, _out, stderr) => {
        if (!err) return ok({ ok: true });
        const line = (stderr || err.message || '').split('\n').find((l) => l.trim()) ?? tr('falhou');
        ok({ ok: false, error: `${bin}: ${line.trim()}`.slice(0, ERROR_MAX) });
      });
    });
}

interface Entry {
  info: SpawnInfo;
  req: SpawnRequest;
  files: Attachment[];
  at: number;
}

/** Request dispatched to host helper with base64 attachments. */
export interface PolledSpawn extends SpawnRequest {
  id: string;
  files: Array<{ name: string; type: string; data: string }>;
}

export interface SpawnServiceOptions {
  /** Node mode: executes locally. Missing (Docker): queued for host helper. */
  opener?: Opener;
  /** Node mode: attempts background execution before desktop app fallback (missing = desktop app only). */
  cli?: CliRunner;
  /** Folder existence check before direct execution (default: statSync). */
  folderProblem?: (folder: string) => string | undefined;
  /** Pre-uploaded attachments (POST /api/spawn/attachments); missing = attachment-less requests. */
  attachments?: AttachmentStore;
  /** Direct mode: persists attachments to disk and returns paths (default: ~/.habblaud/attachments/). */
  writeFiles?: (spawnId: string, files: readonly Attachment[]) => string[];
  now?: () => number;
  newId?: () => string;
}

export type SpawnSubmit = { spawn: SpawnInfo } | { error: 'invalid' | 'unavailable' | 'too-many'; reason: string };

export class SpawnService {
  private readonly entries = new Map<string, Entry>();
  private hostSeenAt = -Infinity;
  private readonly now: () => number;

  constructor(private readonly opts: SpawnServiceOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Available for dispatch now: direct mode or active host helper recently polled. */
  available(): boolean {
    return !!this.opts.opener || this.now() - this.hostSeenAt <= HOST_PRESENCE_MS;
  }

  mode(): 'direct' | 'host' {
    return this.opts.opener ? 'direct' : 'host';
  }

  submit(raw: unknown): SpawnSubmit {
    this.prune();
    const req = parseSpawn(raw);
    if ('error' in req) return { error: 'invalid', reason: req.error };
    if (!this.available()) {
      return { error: 'unavailable', reason: tr('o auxiliar do computador não está rodando: deixe npm run codex:bridge no ar (o Habblaud está no Docker)') };
    }
    let open = 0;
    for (const e of this.entries.values()) if (e.info.status === 'queued' || e.info.status === 'sent') open++;
    if (open >= MAX_OPEN) return { error: 'too-many', reason: tr('já há {0} agentes novos esperando para abrir', [MAX_OPEN]) };
    const ids = raw && typeof raw === 'object' ? (raw as { attachments?: unknown }).attachments : undefined;
    let files: Attachment[] = [];
    if (ids !== undefined && !(Array.isArray(ids) && !ids.length)) {
      if (!this.opts.attachments) return { error: 'invalid', reason: tr('anexos desligados') };
      const taken = this.opts.attachments.take(ids);
      if ('error' in taken) return { error: 'invalid', reason: taken.error };
      files = taken;
    }
    const info: SpawnInfo = { id: this.opts.newId?.() ?? randomUUID(), folder: req.folder, status: 'queued' };
    const entry: Entry = { info, req, files, at: this.now() };
    this.entries.set(info.id, entry);
    if (this.opts.opener) void this.openDirect(entry, this.opts.opener);
    return { spawn: { ...info } };
  }

  get(id: string): SpawnInfo | undefined {
    this.prune();
    const e = this.entries.get(id);
    return e && { ...e.info };
  }

  /** Host helper poll round: refreshes presence and delivers queued requests (helper constructs link safely). */
  poll(): PolledSpawn[] {
    this.hostSeenAt = this.now();
    this.prune();
    const out: PolledSpawn[] = [];
    for (const e of this.entries.values()) {
      if (e.info.status !== 'queued') continue;
      e.info.status = 'sent';
      e.at = this.now();
      const files = e.files.map((f) => ({ name: f.name, type: f.type, data: f.data.toString('base64') }));
      this.dropFiles(e);
      out.push({ id: e.info.id, folder: e.req.folder, prompt: e.req.prompt, files });
    }
    return out;
  }

  ack(raw: unknown): void {
    this.hostSeenAt = this.now();
    const list = raw && typeof raw === 'object' && Array.isArray((raw as { results?: unknown }).results) ? (raw as { results: unknown[] }).results : [];
    for (const r of list) {
      const x = r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
      const e = typeof x.id === 'string' ? this.entries.get(x.id) : undefined;
      if (!e || e.info.status !== 'sent') continue;
      const how: SpawnHow = x.how === 'cli' ? 'cli' : 'app';
      const note = typeof x.note === 'string' && x.note ? x.note.slice(0, ERROR_MAX) : undefined;
      this.resolve(
        e,
        x.ok === true ? { ok: true, how, ...(note ? { note } : {}) } : { ok: false, error: typeof x.error === 'string' && x.error ? x.error.slice(0, ERROR_MAX) : tr('o auxiliar não abriu o app') },
      );
    }
  }

  private async openDirect(e: Entry, opener: Opener): Promise<void> {
    e.info.status = 'sent';
    const problem = (this.opts.folderProblem ?? folderProblem)(e.req.folder);
    if (problem) return this.resolve(e, { ok: false, error: problem });
    let paths: string[];
    try {
      paths = (this.opts.writeFiles ?? ((id, files) => writeAttachments(attachmentsRoot(), id, files)))(e.info.id, e.files);
    } catch (err) {
      return this.resolve(e, { ok: false, error: tr('não deu para gravar os anexos ({0})', [(err as Error).message]).slice(0, ERROR_MAX) });
    } finally {
      this.dropFiles(e);
    }
    const req = { folder: e.req.folder, prompt: promptWithAttachments(e.req.prompt, paths) };
    this.resolve(e, await launch(req, opener, this.opts.cli));
  }

  /** Request attachments are evicted from memory (and deducted from AttachmentStore ceiling). */
  private dropFiles(e: Entry): void {
    this.opts.attachments?.release(e.files.reduce((n, f) => n + f.data.length, 0));
    e.files = [];
  }

  private resolve(e: Entry, r: OpenResult | LaunchResult): void {
    this.dropFiles(e);
    e.info.status = r.ok ? 'opened' : 'failed';
    if (!r.ok) e.info.error = r.error;
    else if ('how' in r) {
      e.info.how = r.how;
      if (r.note) e.info.note = r.note;
    }
    e.at = this.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, e] of this.entries) {
      const age = now - e.at;
      if (e.info.status === 'queued' && age > QUEUED_TIMEOUT_MS) this.resolve(e, { ok: false, error: tr('o auxiliar do computador não buscou o pedido') });
      else if (e.info.status === 'sent' && age > SENT_TIMEOUT_MS) this.resolve(e, { ok: false, error: tr('o auxiliar do computador não confirmou') });
      else if ((e.info.status === 'opened' || e.info.status === 'failed') && age > KEEP_MS) this.entries.delete(id);
    }
  }
}
