// Habblaud helper for Codex messages when Habblaud runs in Docker. Runs on the HOST (Mac/host machine) with tsx:
//
//   npm run codex:bridge     (options: --port <n>, --once)
//
// Codex messages are delivered to session via `codex queue --thread <threadId> --message <text>`, which must run
// on host (where Codex CLI and account folders reside); inside Docker the server cannot reach the binary. This process,
// every 2s, polls Habblaud for pending Codex session messages (POST /api/codex/bridge/poll), executes the command
// for each sequentially with the account CODEX_HOME, and acknowledges results (POST /api/codex/bridge/ack).
// While running, the office allows sending messages to Codex agents (Habblaud considers bridge active for up to
// 10s after last poll). Outside Docker this is not needed: server runs command directly.
//
// Binary: HABBLAUD_CODEX_BIN or `codex` on PATH. Never executes Codex with -c, --enable, --disable or --no-daemon,
// and validates every message beforehand (thread ID, existing Codex directory). Message text is never printed to console.
// Also launches new agents requested from office (with HABBLAUD_PTY=1 in Habblaud; attachments stored in
// ~/.habblaud/attachments/), reads delivery files (only from known project directories, temp folder, and attachments),
// and transcribes dictation via local Whisper (whisper-cli + ffmpeg + model; see server/dictation/whisper.ts).
// File transfers and dictation use long-polling: Habblaud responds only when work arrives (or every 20s).
// Ctrl+C to stop.
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isClaudeDir } from '../server/accounts/detect';
import { createCodexQueueRunner, findCodexBin, THREAD_ID, type CodexQueueResult, type CodexQueueRunner } from '../server/messages/codex';
import { tr } from '../shared/i18n';
import { createCliRunner, createOpener, folderProblem, launch, parseSpawn, type CliRunner, type Opener, type SpawnHow } from '../server/spawn/spawn';
import { runnableClaudeBin } from '../server/claude-bin';
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_SPAWN, attachmentsRoot, promptWithAttachments, safeFileName, writeAttachments, type Attachment } from '../server/spawn/attachments';
import { createWhisperTranscriber, findWhisper, type Transcriber } from '../server/dictation/whisper';
import { checkFile, insideKnownFolder, tempRoots } from '../server/deliveries/files';
import { discoverClaudeDirs } from '../server/accounts/detect';
import { HOST_WAIT_MS } from '../server/host-wait';
import { readFileSync } from 'node:fs';

export const DEFAULT_PORT = 4747;
/** Interval between poll rounds. */
export const POLL_MS = 2_000;
/** Minimum delay between long-poll cycles (legacy Habblaud responding immediately) and following errors. */
export const WAIT_ROUND_MIN_MS = 500;
export const REFUSED_RETRY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

const USAGE = tr('Uso: npm run codex:bridge [-- opções]\n\nEntrega as mensagens do escritório às sessões do Codex quando o Habblaud roda no Docker (deixe rodando no computador).\n\nOpções:\n  --port <n>   porta do Habblaud (padrão: HABBLAUD_PORT ou {0})\n  --once       faz uma rodada só e sai\n  -h, --help   mostra esta ajuda\n\nBinário do Codex: HABBLAUD_CODEX_BIN ou `codex` do PATH.', [DEFAULT_PORT]);

export interface BridgeMessage {
  id: string;
  account: string;
  codexHome: string;
  thread: string;
  text: string;
}

export interface BridgeResult {
  id: string;
  ok: boolean;
  error?: string;
  /** New agent launch modes: running in background (`cli`) or in desktop app window awaiting Enter (`app`). */
  how?: SpawnHow;
  note?: string;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

class FatalError extends Error {}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): { port: number; once: boolean } | 'help' {
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  let port = Number.isInteger(envPort) && envPort > 0 && envPort < 65_536 ? envPort : DEFAULT_PORT;
  let once = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--once') once = true;
    else if (a === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port <= 0 || port >= 65_536) throw new FatalError(tr('--port precisa de um número entre 1 e 65535.'));
    } else throw new FatalError(tr('opção desconhecida: {0}\n\n{1}', [a, USAGE]));
  }
  return { port, once };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Validates message received from Habblaud before command execution: id, text, thread UUID, and an existing
 * Codex folder on this computer (never a Claude Code directory). Returns validated message or rejection reason.
 */
export function checkMessage(raw: unknown): BridgeMessage | { id?: string; error: string } {
  const r = rec(raw);
  const id = typeof r?.id === 'string' && r.id.trim() ? r.id : undefined;
  if (!r || !id) return { error: tr('mensagem sem id') };
  if (typeof r.text !== 'string' || !r.text.trim()) return { id, error: tr('mensagem vazia') };
  if (typeof r.thread !== 'string' || !THREAD_ID.test(r.thread)) return { id, error: tr('id de thread do Codex inválido') };
  const home = typeof r.codexHome === 'string' ? r.codexHome : '';
  if (!home || !isAbsolute(home) || !isDir(home) || isClaudeDir(home)) return { id, error: tr('a pasta do Codex {0} não existe neste computador', [home || tr('(vazia)')]) };
  return { id, account: typeof r.account === 'string' ? r.account : '', codexHome: resolve(home), thread: r.thread, text: r.text };
}

/** POST JSON to local Habblaud; null = offline, timeout, or unparseable response. */
export type Post = (path: string, body: unknown) => Promise<{ status: number; json: unknown } | null>;

export function httpPost(port: number, timeoutMs = REQUEST_TIMEOUT_MS): Post {
  return async (path, body) => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        // Habblaud guard requires valid JSON on every API POST (even empty polling body).
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      return { status: res.status, json };
    } catch {
      return null;
    }
  };
}

export type RoundResult =
  | { state: 'down' }
  | { state: 'refused'; status: number; error?: string }
  | { state: 'ok'; results: BridgeResult[] };

/** Single cycle: polls messages, executes `codex queue` sequentially, and acknowledges results. Never throws. */
export async function round(post: Post, run: CodexQueueRunner, log: (line: string) => void = () => {}): Promise<RoundResult> {
  const polled = await post('/api/codex/bridge/poll', {});
  if (!polled) return { state: 'down' };
  const list = rec(polled.json)?.messages;
  if (polled.status !== 200 || !Array.isArray(list)) {
    const error = rec(polled.json)?.error;
    return { state: 'refused', status: polled.status, ...(typeof error === 'string' ? { error } : {}) };
  }
  const results: BridgeResult[] = [];
  for (const raw of list) {
    const m = checkMessage(raw);
    if ('error' in m) {
      if (m.id) {
        const result = { id: m.id, ok: false, error: m.error };
        results.push(result);
        await post('/api/codex/bridge/ack', { results: [result] });
      }
      log(tr('✗ mensagem recusada: {0}', [m.error]));
      continue;
    }
    let r: CodexQueueResult;
    try {
      r = await run({ codexHome: m.codexHome, thread: m.thread, text: m.text });
    } catch (err) {
      r = { ok: false, error: String(err) };
    }
    const result = r.ok ? { id: m.id, ok: true } : { id: m.id, ok: false, error: r.error };
    results.push(result);
    await post('/api/codex/bridge/ack', { results: [result] });
    log(r.ok ? tr('✓ mensagem na fila do thread {0}… ({1})', [m.thread.slice(0, 8), m.account || 'Codex']) : `✗ thread ${m.thread.slice(0, 8)}…: ${r.error}`);
  }
  return { state: 'ok', results };
}

/** Attachments of request from Habblaud: safe names, valid base64, size and quantity within limits. */
export function checkFiles(raw: unknown): Attachment[] | { error: string } {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > ATTACHMENTS_PER_SPAWN) return { error: tr('anexos inválidos') };
  const out: Attachment[] = [];
  for (const f of raw) {
    const r = rec(f);
    if (!r || typeof r.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(r.data)) return { error: tr('anexo ilegível') };
    const data = Buffer.from(r.data, 'base64');
    if (!data.length || data.length > ATTACHMENT_MAX_BYTES) return { error: tr('anexo vazio ou grande demais') };
    out.push({ name: safeFileName(typeof r.name === 'string' ? r.name : 'arquivo'), type: typeof r.type === 'string' ? r.type : '', data });
  }
  return out;
}

/** Log line for spawned agent: complete sentence per variant (attachments and note), for localization. */
function spawnedLine(folder: string, how: SpawnHow, files: number, note?: string): string {
  if (how === 'cli') {
    if (!files) return tr('✓ agente novo rodando em segundo plano em {0}', [folder]);
    return files > 1
      ? tr('✓ agente novo rodando em segundo plano em {0} com {1} anexos', [folder, files])
      : tr('✓ agente novo rodando em segundo plano em {0} com 1 anexo', [folder]);
  }
  if (note) {
    if (!files) return tr('✓ agente novo aberto no app do Claude em {0} (não rodou sozinho: {1})', [folder, note]);
    return files > 1
      ? tr('✓ agente novo aberto no app do Claude em {0} com {1} anexos (não rodou sozinho: {2})', [folder, files, note])
      : tr('✓ agente novo aberto no app do Claude em {0} com 1 anexo (não rodou sozinho: {1})', [folder, note]);
  }
  if (!files) return tr('✓ agente novo aberto no app do Claude em {0}', [folder]);
  return files > 1
    ? tr('✓ agente novo aberto no app do Claude em {0} com {1} anexos', [folder, files])
    : tr('✓ agente novo aberto no app do Claude em {0} com 1 anexo', [folder]);
}

/**
 * Office agent spawning: polls spawn requests (POST /api/host/spawn/poll), validates working directories,
 * launches in background via `claude --bg` (`cli` mode) or opens claude://code/new deep link in desktop app;
 * acknowledges on /api/host/spawn/ack. Never throws.
 */
export async function spawnRound(
  post: Post,
  open: Opener,
  log: (line: string) => void = () => {},
  problem: (folder: string) => string | undefined = folderProblem,
  write: (id: string, files: readonly Attachment[]) => string[] = (id, files) => writeAttachments(attachmentsRoot(), id, files),
  cli?: CliRunner,
): Promise<RoundResult> {
  const polled = await post('/api/host/spawn/poll', {});
  if (!polled) return { state: 'down' };
  const list = rec(polled.json)?.spawns;
  if (polled.status !== 200 || !Array.isArray(list)) return { state: 'refused', status: polled.status };
  const results: BridgeResult[] = [];
  for (const raw of list) {
    const id = typeof rec(raw)?.id === 'string' ? (rec(raw)!.id as string) : '';
    if (!id) continue;
    const req = parseSpawn(raw);
    const files = checkFiles(rec(raw)?.files);
    const bad = 'error' in req ? req.error : 'error' in files ? files.error : problem(req.folder);
    if (bad || 'error' in req || 'error' in files) {
      results.push({ id, ok: false, error: bad ?? tr('pedido inválido') });
      log(tr('✗ agente novo recusado: {0}', [bad]));
      continue;
    }
    let r: { ok: true; how: SpawnHow; note?: string } | { ok: false; error: string };
    try {
      const paths = write(id, files);
      r = await launch({ folder: req.folder, prompt: promptWithAttachments(req.prompt, paths) }, open, cli);
    } catch (err) {
      r = { ok: false, error: String((err as Error)?.message ?? err) };
    }
    results.push(r.ok ? { id, ok: true, how: r.how, ...(r.note ? { note: r.note } : {}) } : { id, ok: false, error: r.error });
    log(!r.ok ? tr('✗ agente novo em {0}: {1}', [req.folder, r.error]) : spawnedLine(req.folder, r.how, files.length, r.note));
  }
  if (results.length) await post('/api/host/spawn/ack', { results });
  return { state: 'ok', results };
}

/**
 * Dictation handling: polls audio payloads (POST /api/host/dictation/poll), transcribes via local Whisper model,
 * and posts text and detected language to /api/host/dictation/ack. Audio transcript is never logged to stdout. Never throws.
 */
export async function dictationRound(post: Post, transcribe: Transcriber, log: (line: string) => void = () => {}, opts: { wait?: boolean } = {}): Promise<RoundResult> {
  const polled = await post(`/api/host/dictation/poll${opts.wait ? '?wait=1' : ''}`, {});
  if (!polled) return { state: 'down' };
  const list = rec(polled.json)?.dictations;
  if (polled.status !== 200 || !Array.isArray(list)) return { state: 'refused', status: polled.status };
  const results: Array<BridgeResult & { text?: string; lang?: string }> = [];
  for (const raw of list) {
    const r = rec(raw);
    const id = typeof r?.id === 'string' ? r.id : '';
    if (!id) continue;
    if (typeof r?.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(r.data)) {
      results.push({ id, ok: false, error: tr('áudio ilegível') });
      continue;
    }
    const started = Date.now();
    try {
      const t = await transcribe(Buffer.from(r.data, 'base64'), typeof r.type === 'string' ? r.type : '');
      results.push({ id, ok: true, text: t.text, lang: t.lang });
      log(tr('✓ ditado transcrito ({0}, {1} s)', [t.lang || '?', ((Date.now() - started) / 1000).toFixed(1)]));
    } catch (err) {
      const error = (err as Error)?.message || tr('o Whisper falhou');
      results.push({ id, ok: false, error });
      log(tr('✗ ditado: {0}', [error]));
    }
  }
  if (results.length) await post('/api/host/dictation/ack', { results });
  return { state: 'ok', results };
}

/**
 * Deliveries file reader: polls requested paths (POST /api/host/files/poll), validates via checkFile (allowed
 * preview type, no sensitive patterns, up to 25 MB, resolved symlinks) and `inside` boundary checks, returning contents
 * to /api/host/files/ack. Never throws.
 */
export async function filesRound(
  post: Post,
  log: (line: string) => void = () => {},
  read: (p: string) => Buffer = readFileSync,
  check: typeof checkFile = checkFile,
  opts: { inside?: (realPath: string) => boolean; wait?: boolean } = {},
): Promise<RoundResult> {
  const polled = await post(`/api/host/files/poll${opts.wait ? '?wait=1' : ''}`, {});
  if (!polled) return { state: 'down' };
  const list = rec(polled.json)?.files;
  if (polled.status !== 200 || !Array.isArray(list)) return { state: 'refused', status: polled.status };
  const results: Array<BridgeResult & { data?: string }> = [];
  for (const raw of list) {
    const r = rec(raw);
    const id = typeof r?.id === 'string' ? r.id : '';
    if (!id) continue;
    const checked = check(typeof r?.path === 'string' ? r.path : '');
    const c = 'error' in checked || !opts.inside || opts.inside(checked.path) ? checked : { error: tr('fora das pastas de projeto conhecidas') };
    if ('error' in c) {
      results.push({ id, ok: false, error: c.error });
      log(tr('✗ arquivo de entrega recusado: {0}', [c.error]));
      continue;
    }
    try {
      results.push({ id, ok: true, data: read(c.path).toString('base64') });
    } catch {
      results.push({ id, ok: false, error: tr('arquivo ilegível') });
    }
  }
  if (results.length) await post('/api/host/files/ack', { results });
  return { state: 'ok', results: results.map(({ id, ok, error }) => ({ id, ok, ...(error ? { error } : {}) })) };
}

/** Repeats long-poll cycle: when offline, every 2 s; when rejected (feature disabled), once every minute. */
async function waitLoop(roundFn: () => Promise<RoundResult>): Promise<never> {
  for (;;) {
    const started = Date.now();
    const r = await roundFn();
    const pause = r.state === 'down' ? POLL_MS : r.state === 'refused' ? REFUSED_RETRY_MS : Math.max(0, WAIT_ROUND_MIN_MS - (Date.now() - started));
    if (pause) await new Promise((ok) => setTimeout(ok, pause));
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  const bin = findCodexBin(process.env);
  const run = bin ? createCodexQueueRunner(bin) : undefined;
  const open = createOpener();
  const claudeBin = runnableClaudeBin(process.env);
  const cli = claudeBin ? createCliRunner(claudeBin) : undefined;
  const post = httpPost(parsed.port);
  const log = (line: string) => console.log(`[codex-bridge] ${line}`);
  log(
    bin
      ? tr('Entregando as mensagens do Habblaud (http://127.0.0.1:{0}) às sessões do Codex com {1}, e começando os agentes novos pedidos no escritório. Ctrl+C para parar.', [parsed.port, bin])
      : tr('Sem o Codex (codex no PATH ou HABBLAUD_CODEX_BIN): só começo os agentes novos pedidos no Habblaud (http://127.0.0.1:{0}). Ctrl+C para parar.', [parsed.port]),
  );
  log(cli ? tr('Agentes novos rodam em segundo plano com {0} --bg (pasta confiável; senão, no app do Claude).', [claudeBin]) : tr('Sem o claude no PATH (ou HABBLAUD_CLAUDE_BIN): agentes novos abrem no app do Claude e esperam o Enter.'));
  const whisper = findWhisper(process.env);
  let transcribe: Transcriber | undefined;
  if ('missing' in whisper) log(tr('Ditado desligado: falta {0}.', [whisper.missing]));
  else {
    log(tr('Ditado: Whisper local ({0}), idiomas {1} detectados sozinhos.', [whisper.model.split('/').pop(), whisper.langs.join('/')]));
    transcribe = createWhisperTranscriber(whisper);
  }
  // File transfers and dictation (interactive user waiting): long-poll cycles, each in independent loop.
  if (!parsed.once) {
    const waitPost = httpPost(parsed.port, HOST_WAIT_MS + 10_000);
    const accountDirs = discoverClaudeDirs(process.env);
    const roots = [...tempRoots(), attachmentsRoot()];
    const inside = (p: string) => insideKnownFolder(p, { accountDirs, roots });
    void waitLoop(() => filesRound(waitPost, log, undefined, undefined, { inside, wait: true }));
    if (transcribe) {
      const t = transcribe;
      void waitLoop(() => dictationRound(waitPost, t, log, { wait: true }));
    }
  }
  let last = '';
  // Agent spawning disabled in Habblaud (lacks HABBLAUD_PTY=1): re-poll only once per minute.
  let spawnRetryAt = 0;
  let spawned: RoundResult = { state: 'ok', results: [] };
  for (;;) {
    if (Date.now() >= spawnRetryAt) {
      spawned = await spawnRound(post, open, log, undefined, undefined, cli);
      if (spawned.state === 'refused') spawnRetryAt = Date.now() + REFUSED_RETRY_MS;
    }
    const r = run ? await round(post, run, log) : spawned;
    const state =
      r.state === 'down'
        ? tr('Habblaud fora do ar em http://127.0.0.1:{0}; tentando de novo a cada {1} s.', [parsed.port, POLL_MS / 1_000])
        : r.state === 'refused'
          ? tr('o Habblaud recusou ({0}{1}).', [r.status, r.error ? `: ${r.error}` : ''])
          : run
            ? tr('conectado: os agentes do Codex já recebem mensagens pelo escritório.')
            : tr('conectado ao Habblaud.');
    if (state !== last) log(state);
    last = state;
    if (parsed.once) {
      process.exitCode = r.state === 'ok' && r.results.every((x) => x.ok) ? 0 : 1;
      return;
    }
    await new Promise((ok) => setTimeout(ok, POLL_MS));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof FatalError ? tr('[codex-bridge] Erro: {0}', [err.message]) : tr('[codex-bridge] Erro inesperado: {0}', [String(err)]));
    process.exitCode = 1;
  });
}
