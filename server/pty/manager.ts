// Interactive terminal: Habblaud opens Claude Code inside pseudo-terminal (node-pty) and browser renders
// and controls terminal (xterm.js). Output streamed via SSE on GET /api/pty/:id/stream; input, resize, and
// termination via POST (routes in http/pty.ts).
//
// Three use cases: new session in folder; "take over" session open in another terminal (remote process is
// terminated and same conversation continues here via `claude --resume`); and stop agent whether here or in
// another terminal (strictly processes verified by Claude Code session registry matching start time and executable: pty/procinfo.ts).
//
// Security: controlling this terminal executes arbitrary commands on host. Feature is opt-in (HABBLAUD_PTY=1),
// routes accept local connections only (see http/pty.ts), and remains disabled in Docker.
import { chmodSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { PtyInfo, PtyStatus } from '../../shared/types';
import { frame } from '../http/sse';
import { errMsg, log } from '../log';
import { pidAlive } from '../sources/registry';
import { readProcInfo, sameProcess, type ProcInfo, type RegisteredProc } from './procinfo';
import { killWithConsoleReset } from './winkill';
import { tr } from '../../shared/i18n';
import { isExecutableFile } from '../claude-bin';

export { claudeBinFrom, findExecutable, isExecutableFile } from '../claude-bin';

/** O que o gerenciador usa do node-pty (permite trocar nos testes). */
export interface PtyProcess {
  readonly pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type SpawnPty = (file: string, args: string[], opts: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv }) => PtyProcess;

export interface PtyAccount {
  id: string;
  /** Account config directory (becomes CLAUDE_CONFIG_DIR, except default). */
  dir: string;
  isDefault: boolean;
}

/** What manager requires from primary agent to stop or take it over. */
export interface PtyAgentRef {
  id: string;
  kind: 'main' | 'sub';
  account: string;
  sessionId: string;
  cwd?: string;
}

/**
 * Server-side terminal screen: consumes output and returns ANSI sequence reconstructing rendered screen with active
 * modes (bracketed paste, application keys, alt screen) for late connections or tab changes.
 * `write` may process asynchronously: callback notifies when slice was processed.
 */
export interface PtyScreen {
  write(data: string, done?: () => void): void;
  resize(cols: number, rows: number): void;
  serialize(): string;
  dispose(): void;
}

export type ScreenFactory = (cols: number, rows: number) => PtyScreen;

export interface PtyManagerOptions {
  spawn: SpawnPty | null;
  /** Why feature is disabled (when `spawn` is null). */
  disabledReason?: string;
  claudeBin: string;
  accounts: () => PtyAccount[];
  agent: (id: string) => PtyAgentRef | undefined;
  onChange: () => void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /**
   * Terminates external process (tests). Default: on Windows, terminates and cleans up terminal modes
   * (pty/winkill.ts, which re-verifies exact start time); elsewhere, SIGTERM (Claude Code exits cleanly).
   */
  killPid?: (pid: number, proc: ProcInfo) => void | Promise<void>;
  /** Forceful termination when process does not exit in time during takeover (default: SIGKILL; on Windows, TerminateProcess). */
  forceKill?: (pid: number) => void;
  /** Start time and executable of living process (default: pty/procinfo.ts). */
  procInfo?: (pid: number) => Promise<ProcInfo | undefined>;
  /** Reads `<account>/sessions/<pid>.json` (tests). */
  readSession?: (accountDir: string, pid: number) => unknown;
  /** Screen instance per terminal rendered for connecting clients (default: raw output; see pty/screen.ts). */
  createScreen?: ScreenFactory;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

/** Buffered raw output per terminal when @xterm/headless unavailable (see rawScreen). */
const MAX_SCROLLBACK = 512 * 1024;
/** Closed terminals retained in list briefly so final screen remains visible. */
const EXITED_KEEP_MS = 10 * 60_000;
export const MAX_PTYS = 12;
/** Grace period waiting for external process to exit before resuming locally (forcefully killed afterwards). */
const TAKEOVER_WAIT_MS = 5_000;
/** Additional wait time after forceful kill. */
const FORCE_WAIT_MS = 3_000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Main agent ID: "<account>:<pid>". */
const MAIN_ID = /^(.+):(\d+)$/;

/**
 * Environment variables injected by Claude Code into its tool sub-processes. If Habblaud was started from
 * within a session, Claude spawned here would misidentify as nested session (disabling transcript).
 */
const INHERITED_SESSION_VARS = [
  'CLAUDECODE',
  'AI_AGENT',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
];

/**
 * Without @xterm/headless: buffers raw output, sliced at line boundary (never mid-escape sequence).
 * Modes initialized during startup may be dropped on replay.
 */
export function rawScreen(): PtyScreen {
  let buffer = '';
  return {
    write(data, done) {
      buffer += data;
      if (buffer.length > MAX_SCROLLBACK) {
        const cut = buffer.indexOf('\n', buffer.length - MAX_SCROLLBACK);
        buffer = cut === -1 ? '' : buffer.slice(cut + 1);
      }
      done?.();
    },
    resize() {},
    serialize: () => buffer,
    dispose() {
      buffer = '';
    },
  };
}

interface Pty {
  info: PtyInfo;
  proc: PtyProcess;
  screen: PtyScreen;
  clients: Set<ServerResponse>;
  /** Connecting: queues incoming output until saved screen buffer is ready. */
  pending: Map<ServerResponse, string[]>;
}

/** Session verified open in another terminal: PID and system process info. */
interface ExternalProc {
  pid: number;
  proc: ProcInfo;
}

/** Validated payload for new session (directory, account, and dimensions). */
interface SpawnPlan {
  cwd: string;
  account: PtyAccount;
  cols: number;
  rows: number;
}

export class PtyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class PtyManager {
  private ptys = new Map<string, Pty>();
  private seq = 0;
  /** Takeover in progress per agent: double-click (or two tabs) shares single result. */
  private takeovers = new Map<string, Promise<PtyInfo>>();
  private readonly now: () => number;
  private readonly killPid: (pid: number, proc: ProcInfo) => void | Promise<void>;
  private readonly forceKill: (pid: number) => void;
  private readonly procInfo: (pid: number) => Promise<ProcInfo | undefined>;
  private readonly readSession: (accountDir: string, pid: number) => unknown;
  private readonly createScreen: ScreenFactory;
  private readonly isAlive: (pid: number) => boolean;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: PtyManagerOptions) {
    this.now = opts.now ?? Date.now;
    this.procInfo = opts.procInfo ?? ((pid) => readProcInfo(pid));
    this.killPid =
      opts.killPid ??
      (process.platform === 'win32'
        ? (pid, proc) => killWithConsoleReset(pid, proc.fileTime ?? '', () => this.stillSame(pid, proc))
        : (pid) => void process.kill(pid, 'SIGTERM'));
    this.forceKill = opts.forceKill ?? ((pid) => void process.kill(pid, 'SIGKILL'));
    this.readSession = opts.readSession ?? ((dir, pid) => JSON.parse(readFileSync(join(dir, 'sessions', `${pid}.json`), 'utf8')));
    this.createScreen = opts.createScreen ?? (() => rawScreen());
    this.isAlive = opts.isAlive ?? pidAlive;
    this.sleep = opts.sleep ?? ((ms) => new Promise((ok) => setTimeout(ok, ms)));
  }

  status(): PtyStatus {
    return this.opts.spawn ? { enabled: true } : { enabled: false, reason: this.opts.disabledReason ?? tr('indisponível') };
  }

  list(): PtyInfo[] {
    const now = this.now();
    for (const [id, t] of this.ptys) {
      if (t.info.exitedAt !== undefined && now - t.info.exitedAt > EXITED_KEEP_MS) this.drop(id);
    }
    return [...this.ptys.values()].map((t) => ({ ...t.info }));
  }

  /** Opens new Claude Code session in directory (absolute `cwd`), with requested or default account. */
  create(p: { cwd: unknown; account?: unknown; cols?: unknown; rows?: unknown }): PtyInfo {
    return this.spawn(this.plan(p, this.takeovers.size));
  }

  /**
   * Terminates primary agent. Spawned here: closes pty. Spawned in another terminal: terminates process, but only
   * if account session registry verifies PID belongs to that Claude Code session (and running process
   * with this PID started when registry recorded and matches Claude Code).
   */
  async stop(agentId: string): Promise<void> {
    const own = this.byAgent(agentId);
    if (own) {
      this.kill(own);
      return;
    }
    const ext = await this.external(agentId);
    try {
      await this.killPid(ext.pid, ext.proc);
    } catch (err) {
      throw new PtyError(500, tr('não consegui encerrar a sessão: {0}', [errMsg(err)]));
    }
    log.info(tr('Agente {0} encerrado pelo escritório.', [agentId]));
  }

  /**
   * Takes over session open in another terminal: terminates external process, waits for exit, and continues same
   * conversation here (`claude --resume <session>`, in original directory and account). Blocking checks
   * (folder, account, limit) verified before killing remote process; repeated requests wait for first.
   */
  takeover(agentId: string, size: { cols?: unknown; rows?: unknown } = {}): Promise<PtyInfo> {
    const pending = this.takeovers.get(agentId);
    if (pending) return pending;
    const run = this.doTakeover(agentId, size).finally(() => this.takeovers.delete(agentId));
    this.takeovers.set(agentId, run);
    return run;
  }

  private async doTakeover(agentId: string, size: { cols?: unknown; rows?: unknown }): Promise<PtyInfo> {
    // One tick: request already registered in this.takeovers (counted in limit below as "this" takeover).
    await Promise.resolve();
    if (!this.opts.spawn) throw new PtyError(503, tr('terminal desligado: {0}', [this.opts.disabledReason ?? tr('indisponível')]));
    const own = this.byAgent(agentId);
    if (own) return { ...own.info };
    const agent = this.mainAgent(agentId);
    if (!SESSION_ID.test(agent.sessionId)) throw new PtyError(409, tr('sessão sem id válido para retomar'));
    if (!agent.cwd) throw new PtyError(409, tr('não sei a pasta desta sessão'));
    // Other pending takeovers already have reserved capacity.
    const plan = this.plan({ cwd: agent.cwd, account: agent.account, cols: size.cols, rows: size.rows }, this.takeovers.size - 1);
    const ext = await this.external(agentId);
    try {
      await this.killPid(ext.pid, ext.proc);
    } catch (err) {
      throw new PtyError(500, tr('não consegui encerrar a sessão no outro terminal: {0}', [errMsg(err)]));
    }
    if (!(await this.waitExit(ext.pid, TAKEOVER_WAIT_MS))) {
      // Did not exit in time: forcefully terminate (if still same process) and wait briefly.
      log.warn(tr('Agente {0} não encerrou em {1} s: encerrando à força.', [agentId, TAKEOVER_WAIT_MS / 1000]));
      try {
        if (await this.stillSame(ext.pid, ext.proc)) this.forceKill(ext.pid);
      } catch (err) {
        log.warn(tr('Falha ao encerrar à força o processo {0}: {1}', [ext.pid, errMsg(err)]));
      }
      if (!(await this.waitExit(ext.pid, FORCE_WAIT_MS))) {
        throw new PtyError(500, tr('a sessão no outro terminal não encerrou nem à força; ela continua aberta lá'));
      }
    }
    let info: PtyInfo;
    try {
      info = this.spawn(plan, { resume: agent.sessionId, from: agentId });
    } catch (err) {
      // Existing session terminated: instructions on how to continue conversation.
      throw new PtyError(500, tr('a sessão foi encerrada no outro terminal, mas não abriu aqui ({0}); para continuar: claude --resume {1}', [errMsg(err), agent.sessionId]));
    }
    log.info(tr('Agente {0} assumido pelo escritório (sessão {1}).', [agentId, agent.sessionId]));
    return info;
  }

  /** Connects SSE client: streams current screen buffer first, then live output. */
  attach(id: string, req: IncomingMessage, res: ServerResponse): void {
    const pty = this.get(id);
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    // Output arriving while screen finishes processing buffered data queues for this client.
    const queue: string[] = [];
    pty.pending.set(res, queue);
    const drop = () => {
      pty.pending.delete(res);
      pty.clients.delete(res);
    };
    req.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
    pty.screen.write('', () => {
      if (!pty.pending.delete(res) || res.writableEnded) return;
      res.write(frame('reset', pty.screen.serialize()));
      for (const data of queue) res.write(frame('data', data));
      if (pty.info.exitedAt !== undefined) res.write(frame('exit', { code: pty.info.exitCode ?? 0 }));
      pty.clients.add(res);
    });
  }

  input(id: string, data: unknown): void {
    if (typeof data !== 'string' || data.length > 64 * 1024) throw new PtyError(400, tr('entrada inválida'));
    this.running(id).proc.write(data);
  }

  resize(id: string, cols: unknown, rows: unknown): void {
    const pty = this.running(id);
    const c = clampInt(cols, 20, 400, 100);
    const r = clampInt(rows, 5, 200, 30);
    pty.proc.resize(c, r);
    pty.screen.resize(c, r);
  }

  /** Terminates process (if active) or unregisters (if exited). */
  close(id: string): void {
    const pty = this.get(id);
    if (pty.info.exitedAt === undefined) this.kill(pty);
    else {
      this.drop(id);
      this.opts.onChange();
    }
  }

  stopAll(): void {
    for (const t of this.ptys.values()) {
      for (const c of t.clients) c.end();
      for (const c of t.pending.keys()) c.end();
      t.screen.dispose();
      if (t.info.exitedAt === undefined) {
        try {
          t.proc.kill();
        } catch {
          // shutting down server: nothing to do
        }
      }
    }
    this.ptys.clear();
  }

  /** Validates new session request (`reserved`: slots promised to active takeovers). */
  private plan(p: { cwd: unknown; account?: unknown; cols?: unknown; rows?: unknown }, reserved = 0): SpawnPlan {
    if (!this.opts.spawn) throw new PtyError(503, tr('terminal desligado: {0}', [this.opts.disabledReason ?? tr('indisponível')]));
    // Preflight check (takeover terminates remote session after this): non-executable claude would open terminal that
    // sai na hora.
    if (!isExecutableFile(this.opts.claudeBin)) throw new PtyError(503, tr('o executável do Claude Code não roda: {0} (confira o HABBLAUD_CLAUDE_BIN)', [this.opts.claudeBin]));
    if (typeof p.cwd !== 'string' || !isAbsolute(p.cwd)) throw new PtyError(400, tr('informe a pasta do projeto (caminho absoluto)'));
    const cwd = resolve(p.cwd);
    let isDir = false;
    try {
      isDir = statSync(cwd).isDirectory();
    } catch {
      // tratado abaixo
    }
    if (!isDir) throw new PtyError(400, tr('pasta não encontrada: {0}', [cwd]));
    const accounts = this.opts.accounts();
    const account = typeof p.account === 'string' ? accounts.find((a) => a.id === p.account) : (accounts.find((a) => a.isDefault) ?? accounts[0]);
    if (!account) throw new PtyError(400, tr('conta desconhecida'));
    const running = [...this.ptys.values()].filter((t) => t.info.exitedAt === undefined).length;
    if (running + Math.max(0, reserved) >= MAX_PTYS) throw new PtyError(429, tr('limite de {0} terminais abertos', [MAX_PTYS]));
    return { cwd, account, cols: clampInt(p.cols, 20, 400, 100), rows: clampInt(p.rows, 5, 200, 30) };
  }

  private spawn(plan: SpawnPlan, p: { resume?: string; from?: string } = {}): PtyInfo {
    const spawn = this.opts.spawn;
    if (!spawn) throw new PtyError(503, tr('terminal desligado: {0}', [this.opts.disabledReason ?? tr('indisponível')]));
    const { cwd, account, cols, rows } = plan;
    const env: NodeJS.ProcessEnv = { ...(this.opts.env ?? process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    for (const k of INHERITED_SESSION_VARS) delete env[k];
    if (account.isDefault) delete env.CLAUDE_CONFIG_DIR;
    else env.CLAUDE_CONFIG_DIR = account.dir;

    let proc: PtyProcess;
    try {
      const args = p.resume ? ['--resume', p.resume] : [];
      proc = spawn(this.opts.claudeBin, args, { cwd, cols, rows, env });
    } catch (err) {
      throw new PtyError(500, tr('não consegui abrir o Claude Code: {0}', [errMsg(err)]));
    }
    const id = `p${++this.seq}-${proc.pid}`;
    const info: PtyInfo = { id, pid: proc.pid, cwd, account: account.id, agentId: `${account.id}:${proc.pid}`, startedAt: this.now() };
    if (p.resume) info.resumed = p.resume;
    if (p.from) info.fromAgent = p.from;
    const pty: Pty = { info, proc, screen: this.createScreen(cols, rows), clients: new Set(), pending: new Map() };
    this.ptys.set(id, pty);
    proc.onData((data) => {
      pty.screen.write(data);
      for (const queue of pty.pending.values()) queue.push(data);
      this.broadcast(pty, 'data', data);
    });
    proc.onExit(({ exitCode }) => {
      pty.info.exitedAt = this.now();
      pty.info.exitCode = exitCode;
      this.broadcast(pty, 'exit', { code: exitCode });
      this.opts.onChange();
    });
    log.info(p.resume ? tr('Terminal {0} aberto em {1} (conta {2}, retomando {3}).', [id, cwd, account.id, p.resume]) : tr('Terminal {0} aberto em {1} (conta {2}).', [id, cwd, account.id]));
    this.opts.onChange();
    return { ...info };
  }

  private byAgent(agentId: string): Pty | undefined {
    for (const t of this.ptys.values()) if (t.info.agentId === agentId && t.info.exitedAt === undefined) return t;
    return undefined;
  }

  private mainAgent(agentId: string): PtyAgentRef {
    const agent = this.opts.agent(agentId);
    if (!agent) throw new PtyError(404, tr('agente não encontrado'));
    if (agent.kind !== 'main') throw new PtyError(400, tr('só dá para encerrar ou assumir o agente principal de uma sessão'));
    return agent;
  }

  /**
   * Primary agent opened outside Habblaud, verified by account session registry (same session) and
   * system (process with this PID started when registry recorded and matches Claude Code).
   */
  private async external(agentId: string): Promise<ExternalProc> {
    const agent = this.mainAgent(agentId);
    const m = MAIN_ID.exec(agent.id);
    const pid = m ? Number(m[2]) : NaN;
    if (!m || m[1] !== agent.account || !Number.isSafeInteger(pid) || pid <= 0) throw new PtyError(400, tr('agente sem processo conhecido'));
    const account = this.opts.accounts().find((a) => a.id === agent.account);
    if (!account) throw new PtyError(400, tr('conta desconhecida'));
    let registered: unknown;
    try {
      registered = this.readSession(account.dir, pid);
    } catch {
      throw new PtyError(409, tr('a sessão não está mais aberta'));
    }
    const r = (registered ?? {}) as { sessionId?: unknown; startedAt?: unknown; procStart?: unknown };
    if (r.sessionId !== agent.sessionId) throw new PtyError(409, tr('o processo não é mais desta sessão'));
    if (!this.isAlive(pid)) throw new PtyError(409, tr('a sessão não está mais aberta'));
    const reg: RegisteredProc = {
      startedAt: typeof r.startedAt === 'number' ? r.startedAt : undefined,
      procStart: typeof r.procStart === 'string' ? r.procStart : undefined,
    };
    const proc = await this.procInfo(pid);
    if (!proc) throw new PtyError(409, tr('não consegui conferir o processo desta sessão (talvez já tenha encerrado)'));
    if (!sameProcess(reg, proc)) throw new PtyError(409, tr('o processo {0} não é mais esta sessão do Claude Code (registro antigo?)', [pid]));
    return { pid, proc };
  }

  /** Is process `pid` still matching `proc` (alive, same executable, same start time)? */
  private async stillSame(pid: number, proc: ProcInfo): Promise<boolean> {
    if (!this.isAlive(pid)) return false;
    const now = await this.procInfo(pid);
    if (!now || now.name !== proc.name) return false;
    return proc.fileTime && now.fileTime ? now.fileTime === proc.fileTime : Math.abs(now.startMs - proc.startMs) < 1_000;
  }

  /** Waits for `pid` to exit (true) or timeout to expire (false). */
  private async waitExit(pid: number, ms: number): Promise<boolean> {
    for (let waited = 0; this.isAlive(pid) && waited < ms; waited += 100) await this.sleep(100);
    return !this.isAlive(pid);
  }

  private kill(pty: Pty): void {
    try {
      pty.proc.kill();
    } catch (err) {
      log.warn(tr('Falha ao encerrar o terminal {0}: {1}', [pty.info.id, errMsg(err)]));
    }
  }

  private get(id: string): Pty {
    const pty = this.ptys.get(id);
    if (!pty) throw new PtyError(404, tr('terminal não encontrado'));
    return pty;
  }

  private running(id: string): Pty {
    const pty = this.get(id);
    if (pty.info.exitedAt !== undefined) throw new PtyError(409, tr('o terminal já foi encerrado'));
    return pty;
  }

  private drop(id: string): void {
    const t = this.ptys.get(id);
    if (!t) return;
    for (const c of t.clients) c.end();
    for (const c of t.pending.keys()) c.end();
    t.screen.dispose();
    this.ptys.delete(id);
  }

  private broadcast(pty: Pty, event: string, data: unknown): void {
    const f = frame(event, data);
    for (const c of pty.clients) c.write(f);
  }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Loads node-pty (optional dependency) and verifies it can spawn a terminal. Returns null + reason on failure:
 * prevents takeover from killing remote session before discovering local node-pty cannot spawn.
 */
export async function loadPty(): Promise<{ spawn: SpawnPty | null; reason?: string }> {
  let ptySpawn: ((file: string, args: string[], o: Record<string, unknown>) => PtyProcess) | undefined;
  try {
    const mod = (await import('node-pty')) as unknown as {
      spawn?: (file: string, args: string[], o: Record<string, unknown>) => PtyProcess;
      default?: { spawn: (file: string, args: string[], o: Record<string, unknown>) => PtyProcess };
    };
    ptySpawn = mod.spawn ?? mod.default?.spawn;
  } catch (err) {
    return { spawn: null, reason: tr('node-pty não instalado ({0})', [errMsg(err)]) };
  }
  if (!ptySpawn) return { spawn: null, reason: tr('node-pty sem spawn()') };
  const nativeSpawn = ptySpawn;
  const spawn: SpawnPty = (file, args, o) => nativeSpawn(file, args, { name: 'xterm-256color', cwd: o.cwd, cols: o.cols, rows: o.rows, env: o.env });
  // On Windows there is no spawn-helper; spawn probe is designed for macOS and Linux.
  if (process.platform === 'win32') return { spawn };
  const dir = nodePtyDir();
  if (dir) fixSpawnHelper(dir);
  const problem = await spawnProblem(spawn);
  return problem ? { spawn: null, reason: problem } : { spawn };
}

/** Path to node-pty package directory (undefined if not found). */
function nodePtyDir(): string | undefined {
  try {
    return dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  } catch {
    return undefined;
  }
}

/**
 * node-pty 1.1.0 ships macOS `spawn-helper` (prebuilds/darwin-*) without executable permissions, and no install script
 * restores it: without it, terminals fail with "posix_spawnp failed". Restores permission across directories
 * where node-pty searches for native binary (active spawn-helper is co-located with it).
 */
export function fixSpawnHelper(ptyDir: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): void {
  for (const sub of ['build/Release', 'build/Debug', `prebuilds/${platform}-${arch}`]) {
    const file = join(ptyDir, sub, 'spawn-helper');
    try {
      const mode = statSync(file).mode;
      if (!(mode & 0o100)) chmodSync(file, (mode & 0o777) | 0o111);
    } catch {
      // does not exist (or chmod failed): spawn probe determines if terminal opens
    }
  }
}

/** Spawns test terminal (Node process that exits immediately): null on success, otherwise failure reason. */
export function spawnProblem(spawn: SpawnPty, timeoutMs = 5_000): Promise<string | null> {
  let proc: PtyProcess;
  try {
    proc = spawn(process.execPath, ['-e', ''], { cwd: process.cwd(), cols: 80, rows: 24, env: process.env });
  } catch (err) {
    return Promise.resolve(tr('node-pty não consegue abrir terminais ({0})', [errMsg(err)]));
  }
  return new Promise((ok) => {
    // Spawned and did not exit immediately: spawn works, which is what matters here.
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // already exited
      }
      ok(null);
    }, timeoutMs);
    proc.onExit(({ exitCode }) => {
      clearTimeout(timer);
      ok(exitCode === 0 ? null : tr('node-pty abriu o terminal de teste, mas ele saiu com o código {0}', [exitCode]));
    });
  });
}
