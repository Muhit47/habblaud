// Installs (or uninstalls) Habblaud statusline tap in each Claude Code account. Runs on the HOST with tsx:
//
//   npm run usage:install     # wraps statusLine.command of each account with the tap (backups first)
//   npm run usage:uninstall   # restores the original command
//   npm run usage:status      # shows, per account, if installed and age of last captured usage
//   (options: --dry-run shows changes without writing; --node <path> selects node executable)
//
// The tap (scripts/statusline-tap.mjs) receives from Claude Code the same JSON that the statusline already receives
// and stores only the 5h/weekly usage percentages in ~/.habblaud/usage/<account>.json, forwarding everything
// to the original statusline. This allows Habblaud to show live usage without reading credentials.
//
// In <account>/settings.json only statusLine.command changes (other fields and keys remain as
// they are); before writing, a copy is saved to settings.json.habblaud-backup-<date>.
//
// Legacy name (CodeTown, up to 0.3.2): install migrates ~/.codetown to ~/.habblaud first, so captured
// usage remains valid.
import { accessSync, chmodSync, constants, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverClaudeDirs } from '../server/accounts/detect';
import { describeStateMigration, LEGACY_NAME, migrateLegacyStateDir } from '../server/legacy';
import { tr } from '../shared/i18n';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TAP_SCRIPT = join(ROOT, 'scripts', 'statusline-tap.mjs');
const TAP_NAME = 'statusline-tap.mjs';

const USAGE = tr(`Uso: npm run usage:<install|uninstall|status> [-- opções]

  install     envolve o statusline de cada conta com o tap do Habblaud (faz backup do settings.json)
  uninstall   restaura o statusline original de cada conta
  status      mostra se o tap está instalado e quando chegou o último uso de cada conta

Opções:
  --dry-run        mostra o que mudaria, sem gravar nada
  --node <cmd>     comando do node usado no statusline (padrão: detectado no PATH)
  -h, --help       mostra esta ajuda

Contas: as mesmas do servidor (~/.claude* com projects/ ou sessions/, CLAUDE_CONFIG_DIR ou
HABBLAUD_CLAUDE_DIRS). Uso capturado em HABBLAUD_USAGE_DIR (padrão ~/.habblaud/usage).`);

// ---------------------------------------------------------------------------------------------
// Pure functions (tested in server/test/statusline-install.test.ts)
// ---------------------------------------------------------------------------------------------

/** Characters that do not require quoting in a shell command. */
const SAFE_WORD = /^[\w@%+=:,./~-]+$/;

/** Shell single quoting (the only special character inside is the single quote itself). */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Inverts shellQuote; returns undefined if `s` is not strictly a single-quoted token. */
export function shellUnquote(s: string): string | undefined {
  const m = /^'((?:[^']|'\\'')*)'$/.exec(s);
  return m ? m[1].replace(/'\\''/g, "'") : undefined;
}

/**
 * Original command formatted as argument to tap. Simple commands (safe tokens only, e.g.
 * `npx -y ccstatusline`) remain unquoted; complex commands are single-quoted so that
 * pipes, `&&`, quotes, and redirections apply strictly to the original command.
 */
export function encodeOriginal(cmd: string): string {
  const words = cmd.trim().split(/\s+/);
  return words.every((w) => SAFE_WORD.test(w)) ? words.join(' ') : shellQuote(cmd.trim());
}

export function decodeOriginal(arg: string): string {
  const t = arg.trim();
  return shellUnquote(t) ?? t;
}

export function isTapCommand(cmd: unknown): cmd is string {
  return typeof cmd === 'string' && cmd.includes(TAP_NAME);
}

/** Path in double quotes (readable); with `$`, backtick, `"` or `\\`, single quotes. */
export function quotePath(p: string): string {
  return /^[^"$`\\]*$/.test(p) ? `"${p}"` : shellQuote(p);
}

function unquotePath(q: string): string {
  if (q.startsWith('"')) return q.slice(1, -1);
  return shellUnquote(q) ?? q;
}

/** `node "<tap>" -- <original>` (or just `node "<tap>"` when there was no statusline). */
export function wrapCommand(nodeCmd: string, tapPath: string, original?: string): string {
  const node = SAFE_WORD.test(nodeCmd) ? nodeCmd : quotePath(nodeCmd);
  const head = `${node} ${quotePath(tapPath)}`;
  return original?.trim() ? `${head} -- ${encodeOriginal(original)}` : head;
}

const WRAPPED =
  /^\s*(?:"[^"]*"|'(?:[^']|'\\'')*'|\S+)\s+("[^"]*statusline-tap\.mjs"|'(?:[^']|'\\'')*statusline-tap\.mjs'|\S*statusline-tap\.mjs)(?:\s+--(?:\s+([\s\S]*))?)?\s*$/;

/** Original command preserved inside a wrapped command ('' = no prior statusline existed). */
export function unwrapCommand(cmd: string): { tapPath: string; original: string } | undefined {
  const m = WRAPPED.exec(cmd);
  if (!m) return undefined;
  return { tapPath: unquotePath(m[1]), original: m[2] ? decodeOriginal(m[2]) : '' };
}

export type Settings = Record<string, unknown>;
export type StatusLine = Record<string, unknown> & { type?: unknown; command?: unknown };

export type PlanAction =
  | { action: 'install'; settings: Settings; message: string }
  | { action: 'uninstall'; settings: Settings; message: string }
  | { action: 'none'; message: string }
  | { action: 'skip'; message: string };

function statusLineOf(settings: Settings): StatusLine | undefined {
  const sl = settings.statusLine;
  return sl && typeof sl === 'object' && !Array.isArray(sl) ? (sl as StatusLine) : undefined;
}

/** Installation plan for an already parsed settings.json (performs no disk writes). */
export function planInstall(settings: Settings, nodeCmd: string, tapPath: string): PlanAction {
  const sl = statusLineOf(settings);
  if (settings.statusLine !== undefined && !sl) return { action: 'skip', message: tr('statusLine em formato desconhecido; nada foi alterado') };
  if (!sl) {
    return {
      action: 'install',
      settings: { ...settings, statusLine: { type: 'command', command: wrapCommand(nodeCmd, tapPath) } },
      message: tr('sem statusline antes: criado um que só captura o uso (não imprime nada)'),
    };
  }
  if (sl.type !== undefined && sl.type !== 'command') return { action: 'skip', message: tr('statusLine do tipo "{0}" não é suportado; nada foi alterado', [String(sl.type)]) };
  if (typeof sl.command !== 'string' || !sl.command.trim()) return { action: 'skip', message: tr('statusLine sem comando; nada foi alterado') };
  if (isTapCommand(sl.command)) {
    const cur = unwrapCommand(sl.command);
    if (!cur) return { action: 'skip', message: tr('o comando já menciona o tap, mas não no formato esperado; confira à mão') };
    const next = wrapCommand(nodeCmd, tapPath, cur.original);
    if (next === sl.command) return { action: 'none', message: tr('já instalado') };
    return { action: 'install', settings: { ...settings, statusLine: { ...sl, command: next } }, message: tr('atualizado (novo caminho do Habblaud ou do node)') };
  }
  return {
    action: 'install',
    settings: { ...settings, statusLine: { ...sl, command: wrapCommand(nodeCmd, tapPath, sl.command) } },
    message: tr('instalado na frente de: {0}', [sl.command]),
  };
}

/** Uninstallation plan: restores original command (or removes statusLine created by the tap itself). */
export function planUninstall(settings: Settings): PlanAction {
  const sl = statusLineOf(settings);
  if (!sl || !isTapCommand(sl.command)) return { action: 'none', message: tr('não estava instalado') };
  const cur = unwrapCommand(sl.command);
  if (!cur) return { action: 'skip', message: tr('o comando menciona o tap, mas não no formato esperado; confira à mão') };
  if (!cur.original) {
    const rest = { ...settings };
    delete rest.statusLine;
    return { action: 'uninstall', settings: rest, message: tr('statusline criado pelo Habblaud removido') };
  }
  return { action: 'uninstall', settings: { ...settings, statusLine: { ...sl, command: cur.original } }, message: `restaurado: ${cur.original}` };
}

/** Directories where a system `node` outside version managers remains stable across updates. */
function stableNode(p: string, home: string): boolean {
  const dir = dirname(p);
  const stable = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', join(home, '.volta', 'bin'), join(home, '.asdf', 'shims'), join(home, '.local', 'share', 'mise', 'shims')];
  return stable.includes(dir);
}

/**
 * Node command for statusline: absolute path when PATH `node` resides in a stable location
 * (Homebrew, /usr/local...); otherwise `node` — nvm/fnm paths change across versions, and the
 * original statusline (npx...) already relies on PATH node anyway.
 */
export function detectNodeCommand(env: NodeJS.ProcessEnv, home: string, isExecutable: (p: string) => boolean = canExecute): string {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, 'node');
    if (!isExecutable(p)) continue;
    return stableNode(p, home) ? p : 'node';
  }
  return 'node';
}

function canExecute(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return tr('{0} dias', [Math.round(h / 24)]);
}

// ---------------------------------------------------------------------------------------------
// Effects (file system)
// ---------------------------------------------------------------------------------------------

export interface RunOptions {
  command: 'install' | 'uninstall' | 'status';
  dryRun: boolean;
  nodeCmd?: string;
}

export interface RunContext {
  env: NodeJS.ProcessEnv;
  home: string;
  now: Date;
  tapPath: string;
  out: (line: string) => void;
}

class FatalError extends Error {}

export function parseArgs(argv: string[]): RunOptions | 'help' {
  let command: RunOptions['command'] | undefined;
  let dryRun = false;
  let nodeCmd: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--dry-run') dryRun = true;
    else if (a === '--node') {
      nodeCmd = argv[++i];
      if (!nodeCmd) throw new FatalError(tr('--node precisa de um caminho.'));
    } else if ((a === 'install' || a === 'uninstall' || a === 'status') && !command) command = a;
    else throw new FatalError(tr('opção desconhecida: {0}\n\n{1}', [a, USAGE]));
  }
  if (!command) throw new FatalError(tr('diga o que fazer: install, uninstall ou status.\n\n{0}', [USAGE]));
  return { command, dryRun, nodeCmd };
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** `~/...` for paths inside HOME; on Windows handles `\` (remainder outputs with `/` as Git Bash expects). */
export function tildify(p: string, home: string): string {
  if (p !== home && !p.startsWith(`${home}/`) && !p.startsWith(`${home}${sep}`)) return p;
  return `~${p.slice(home.length).split(sep).join('/')}`;
}

export function readSettings(file: string): { settings: Settings; raw?: string } | { error: string } {
  if (!existsSync(file)) return { settings: {} };
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    return { error: tr('não consegui ler ({0})', [(err as Error).message]) };
  }
  if (!raw.trim()) return { settings: {}, raw };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: tr('não é um objeto JSON; nada foi alterado') };
    return { settings: parsed as Settings, raw };
  } catch {
    return { error: tr('JSON inválido; nada foi alterado') };
  }
}

/** Backup + atomic write preserving file permissions. Returns backup path. */
export function writeSettings(file: string, settings: Settings, raw: string | undefined, now: Date): string | undefined {
  let mode = 0o600;
  if (raw !== undefined) mode = statSync(file).mode & 0o777;
  const tmp = `${file}.habblaud-tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode });
  chmodSync(tmp, mode);
  // Re-read now: backup is what rename replaces. If changed since read, abort (no merge).
  let current: string | undefined;
  try {
    current = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      unlinkSync(tmp);
      throw err;
    }
  }
  if (current !== raw) {
    unlinkSync(tmp);
    throw new Error(tr('o arquivo mudou desde a leitura; nada foi alterado, rode o comando de novo'));
  }
  let backup: string | undefined;
  if (current !== undefined) {
    backup = `${file}.habblaud-backup-${stamp(now)}`;
    for (let i = 2; existsSync(backup); i++) backup = `${file}.habblaud-backup-${stamp(now)}-${i}`;
    writeFileSync(backup, current, { mode: 0o600 });
  }
  renameSync(tmp, file);
  return backup;
}

/** Directory for captured usage (HABBLAUD_USAGE_DIR or ~/.habblaud/usage); also used by mod-install. */
export function usageDirOf(env: NodeJS.ProcessEnv, home: string): string {
  const d = env.HABBLAUD_USAGE_DIR?.trim();
  return d ? resolve(d.replace(/^~(?=\/|$)/, home)) : join(home, '.habblaud', 'usage');
}

/**
 * Migrates legacy ~/.codetown to ~/.habblaud before creating or using usage directory; also used by
 * mod-install. Applies even if HABBLAUD_USAGE_DIR is customized (names and statistics also reside there, outside
 * Docker). Returns console output line (undefined = no-op); in dry-run mode, logs planned action.
 */
export function migrateLegacyState(home: string, dryRun: boolean): string | undefined {
  if (dryRun) {
    let legacy = false;
    try {
      legacy = statSync(join(home, `.${LEGACY_NAME}`)).isDirectory();
    } catch {
      legacy = false;
    }
    return legacy ? tr('~ ~/.{0} (nome antigo) vai para ~/.habblaud (simulação: nada movido)', [LEGACY_NAME]) : undefined;
  }
  const r = migrateLegacyStateDir(home);
  const msg = describeStateMigration(r);
  return msg && `${r.error ? '!' : '✓'} ${msg}`;
}

/** Age of last captured usage for an account (tap file), or undefined. */
function lastCapture(dir: string, env: NodeJS.ProcessEnv, home: string): { at: number; five?: number; week?: number } | undefined {
  const file = join(usageDirOf(env, home), `${basename(dir)}.json`);
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { utilization?: unknown } | unknown>;
    const at = typeof j.fetchedAt === 'number' ? j.fetchedAt : statSync(file).mtimeMs;
    const pct = (w: unknown) => (w && typeof w === 'object' && typeof (w as { utilization?: unknown }).utilization === 'number' ? ((w as { utilization: number }).utilization) : undefined);
    return { at, five: pct(j.five_hour), week: pct(j.seven_day) };
  } catch {
    return undefined;
  }
}

/** Executes command across all accounts. Returns exit code. */
export function run(opts: RunOptions, ctx: RunContext): number {
  const { env, home, out } = ctx;
  const dirs = discoverClaudeDirs(env, home);
  if (!dirs.length) {
    out(tr('Nenhuma conta do Claude Code encontrada (~/.claude* com projects/ ou sessions/). Use HABBLAUD_CLAUDE_DIRS se estiverem em outro lugar.'));
    return 1;
  }
  const nodeCmd = opts.nodeCmd ?? detectNodeCommand(env, home);
  // Legacy name: tap now writes to ~/.habblaud/usage; existing files in ~/.codetown are migrated.
  if (opts.command === 'install') {
    const moved = migrateLegacyState(home, opts.dryRun);
    if (moved) out(moved);
  }
  let failures = 0;
  let changed = 0;
  for (const dir of dirs) {
    const file = join(dir, 'settings.json');
    const label = `${basename(dir)} (${tildify(file, home)})`;
    const read = readSettings(file);
    if ('error' in read) {
      out(`✗ ${label}: ${read.error}`);
      failures++;
      continue;
    }
    if (opts.command === 'status') {
      const sl = statusLineOf(read.settings);
      const wrapped = sl && isTapCommand(sl.command) ? unwrapCommand(sl.command) : undefined;
      const state = wrapped
        ? tr('instalado{0}', [wrapped.original ? tr(' (na frente de: {0})', [wrapped.original]) : tr(' (sem statusline original)')])
        : sl && typeof sl.command === 'string'
          ? tr('não instalado (statusline atual: {0})', [sl.command])
          : tr('não instalado (sem statusline)');
      if (wrapped?.tapPath && resolve(wrapped.tapPath) !== resolve(ctx.tapPath)) out(tr('! {0}: o tap aponta para {1}; rode npm run usage:install para atualizar', [label, wrapped.tapPath]));
      const cap = lastCapture(dir, env, home);
      const capText = cap
        ? tr('último uso capturado há {0}{1}{2}', [formatAge(ctx.now.getTime() - cap.at), cap.five !== undefined ? ` · 5h ${Math.round(cap.five)}%` : '', cap.week !== undefined ? tr(' · semana {0}%', [Math.round(cap.week)]) : ''])
        : wrapped
          ? tr('nenhum uso capturado ainda (o Claude Code envia os limites depois da primeira resposta numa sessão aberta)')
          : tr('nenhum uso capturado');
      out(`• ${label}: ${state}; ${capText}`);
      continue;
    }
    const plan = opts.command === 'install' ? planInstall(read.settings, nodeCmd, ctx.tapPath) : planUninstall(read.settings);
    if (plan.action === 'none') {
      out(`= ${label}: ${plan.message}`);
      continue;
    }
    if (plan.action === 'skip') {
      out(`✗ ${label}: ${plan.message}`);
      failures++;
      continue;
    }
    if (opts.dryRun) {
      out(tr('~ {0}: {1} (simulação: nada gravado)', [label, plan.message]));
      out(`    statusLine → ${JSON.stringify(plan.settings.statusLine ?? null)}`);
      continue;
    }
    try {
      const backup = writeSettings(file, plan.settings, read.raw, ctx.now);
      out(`✓ ${label}: ${plan.message}${backup ? tr(' · backup em {0}', [tildify(backup, home)]) : ''}`);
      changed++;
    } catch (err) {
      out(tr('✗ {0}: não consegui gravar ({1})', [label, (err as Error).message]));
      failures++;
    }
  }
  if (opts.command === 'install' && changed) {
    out('');
    out(tr('Pronto. Os números aparecem no Habblaud depois da próxima resposta de cada sessão. Sessões já'));
    out(tr('abertas costumam recarregar o settings.json sozinhas; se o uso não aparecer, reabra a sessão.'));
    out(tr('Uso capturado em {0}. Para desfazer: npm run usage:uninstall', [tildify(usageDirOf(env, home), home)]));
  }
  return failures ? 1 : 0;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  const home = process.env.HOME || homedir();
  process.exitCode = run(parsed, { env: process.env, home, now: new Date(), tapPath: TAP_SCRIPT, out: (l) => console.log(l) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof FatalError ? tr('[usage] Erro: {0}', [err.message]) : tr('[usage] Erro inesperado: {0}', [String(err)]));
    process.exitCode = 1;
  });
}
