// Starts (or stops) Habblaud in local Docker. Runs on the HOST with tsx:
//
//   npm run docker:up                 # detects accounts, generates override, builds, and starts
//   npm run docker:up -- --no-build   # starts without rebuilding the image
//   npm run docker:down               # stops and removes container
//
// Actions performed on startup:
// 1. Discovers Claude Code config dirs on host (same server discovery rules: ~/.claude*,
//    CLAUDE_CONFIG_DIR or HABBLAUD_CLAUDE_DIRS) and extracts account metadata via detectAccounts.
// 2. Generates docker-compose.override.yml mounting ONLY <account>/projects and <account>/sessions,
//    read-only, at /claude/<account>/... — never the whole account folder, which contains
//    credentials and settings — and the statusline usage directory
//    (~/.habblaud/usage, created if missing) at /usage, also read-only. Passes
//    HABBLAUD_CLAUDE_DIRS, HABBLAUD_ACCOUNTS, HABBLAUD_USAGE_DIR and host timezone (TZ) to container.
//    Codex accounts (~/.codex*, CODEX_HOME or HABBLAUD_CODEX_DIRS; HABBLAUD_CODEX=0 disables): ONLY
//    sessions/, archived_sessions/ and thread-writer-locks/ for each, read-only, at /codex/<account>/... —
//    never auth.json, config.toml, shell_snapshots/, history.jsonl, logs or SQLite databases. Passed in HABBLAUD_CODEX_DIRS
//    and, with `provider: 'codex'` and HOST folder (where `codex queue` runs), in HABBLAUD_ACCOUNTS.
// 3. Migrates legacy CodeTown remnants (up to 0.3.2): ~/.codetown becomes ~/.habblaud, container
//    `codetown` and network codetown_default are removed, and if new volume does not exist yet, data from
//    codetown_codetown-data is copied to it (legacy volume preserved for manual cleanup). Warns about CODETOWN_*
//    variables in environment and .env that are no longer supported.
// 4. Runs `docker compose up -d --build`, waits for /api/health and prints URL.
// 5. Outputs Habblaud World status at conclusion (HABBLAUD_WORLD_URL from environment or .env, validated like
//    server config) and target server; defaults to server.habblaud.com ("(default)"), and
//    HABBLAUD_WORLD=0 disables entirely.
// 6. Updates Habblaud mod on accounts where ALREADY installed with differing version (after updating
//    Habblaud): rereads marketplace from this directory and executes `claude plugin update` with
//    CLAUDE_CONFIG_DIR for each account. Never auto-installs from scratch; missing or failing `claude` is only a warning.
//    Accounts with mod installed but lacking messaging plugin (added later) receive a tip to run npm run mod:install.
//
// Live 5h/weekly usage: Habblaud mod (npm run mod:install; Claude Code 2.1.287+) or, on
// older versions, statusline tap (npm run usage:install). Both record metrics in folder
// mounted at /usage. Without them, cached usage read at startup is used.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AccountInfo, SourceInfo } from '../shared/types';
import { codexDirsRefused, detectAccounts, discoverClaudeDirs, type DetectedAccount } from '../server/accounts/detect';
import { detectCodexAccounts, discoverCodexDirs } from '../server/sources/codex/accounts';
import { describeStateMigration, LEGACY_NAME, legacyEnvWarning, migrateLegacyStateDir } from '../server/legacy';
import { makeClaudeRunner, MIN_CLAUDE_VERSION, readPackageVersion, updateInstalledMods, type ModUpdateResult } from './mod-install';
import { tr } from '../shared/i18n';
import { readEnvValue } from '../server/remote/envfile';
import { parseWorldConfig } from '../server/config';
import { ensureServerCert, remoteTargets, remoteTlsBase, tlsPaths } from '../server/remote/tls';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.HOME || homedir();
const STATE_DIR = join(HOME, '.habblaud');
const OVERRIDE_FILE = join(ROOT, 'docker-compose.override.yml');
/** The .env of this directory, read automatically by Compose. */
const ENV_FILE = join(ROOT, '.env');
/** Usage captured on host by Habblaud mod or statusline tap (scripts/statusline-tap.mjs). */
const USAGE_DIR = process.env.HABBLAUD_USAGE_DIR?.trim() ? resolve(process.env.HABBLAUD_USAGE_DIR.trim()) : join(STATE_DIR, 'usage');
/** Container mount destination for usage directory. */
const CONTAINER_USAGE_DIR = '/usage';
/** Where container reads remote access TLS certificate (server/http/remote.ts). */
const CONTAINER_REMOTE_TLS_DIR = '/remote-tls';
const SERVICE = 'habblaud';
/** Mount root inside container: /claude/<account>/{projects,sessions}. */
const CONTAINER_ROOT = '/claude';
/** Only these subdirectories of each account enter the container. */
const MOUNTED_SUBDIRS = ['projects', 'sessions'] as const;
/** Mount root for Codex inside container: /codex/<account>/{sessions,archived_sessions,thread-writer-locks}. */
const CODEX_CONTAINER_ROOT = '/codex';
/**
 * Only these subdirectories of each Codex folder enter container (conversations and locks of open sessions).
 * auth.json, config.toml, shell_snapshots/, history.jsonl, logs and SQLite files remain on host.
 */
export const CODEX_MOUNTED_SUBDIRS = ['sessions', 'archived_sessions', 'thread-writer-locks'] as const;
const DEFAULT_PORT = 4747;
const HEALTH_TIMEOUT_MS = 120_000;
/** Image and data volume names assigned by Compose (`name: habblaud` in docker-compose.yml). */
const IMAGE = 'habblaud:local';
const DATA_VOLUME = 'habblaud_habblaud-data';
/** Legacy CodeTown naming (up to 0.3.2) for migration: fixed container_name, default network, volume, image. */
const LEGACY_DOCKER = {
  container: LEGACY_NAME,
  network: `${LEGACY_NAME}_default`,
  volume: `${LEGACY_NAME}_${LEGACY_NAME}-data`,
  image: `${LEGACY_NAME}:local`,
} as const;

const USAGE = tr('Uso: npm run docker:up [-- opções]\n\nOpções:\n  --no-build   sobe sem reconstruir a imagem\n  --down       derruba o container (o mesmo que npm run docker:down)\n  -h, --help   mostra esta ajuda\n\nVariáveis: HABBLAUD_PORT (porta no host, padrão {0}), HABBLAUD_CLAUDE_DIRS\n(config dirs separados por vírgula, se as contas não estiverem em ~/.claude*), HABBLAUD_CODEX_DIRS\n(pastas do Codex, se não estiverem em ~/.codex* nem em CODEX_HOME) e HABBLAUD_CODEX=0 (sem o Codex).', [DEFAULT_PORT]);

// ---------------------------------------------------------------------------------------------
// Terminal output
// ---------------------------------------------------------------------------------------------

const say = (msg: string) => console.log(`[docker-up] ${msg}`);
const warn = (msg: string) => console.warn(tr('[docker-up] Atenção: {0}', [msg]));

class FatalError extends Error {}

function fail(msg: string): never {
  throw new FatalError(msg);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const USAGE_STATUS: Record<AccountInfo['usageStatus'], string> = {
  ok: tr('uso atualizado'),
  stale: tr('uso desatualizado'),
  disabled: tr('sem dados de uso'),
};

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

export interface Options {
  down: boolean;
  build: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Options {
  const opts: Options = { down: false, build: true, help: false };
  for (const arg of argv) {
    if (arg === '--down') opts.down = true;
    else if (arg === '--no-build') opts.build = false;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else fail(tr('opção desconhecida: {0}\n\n{1}', [arg, USAGE]));
  }
  return opts;
}

export function hostPort(env: NodeJS.ProcessEnv): number {
  const raw = env.HABBLAUD_PORT?.trim();
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) fail(tr('HABBLAUD_PORT inválida: "{0}" (use um número de 1 a 65535).', [raw]));
  return port;
}

// ---------------------------------------------------------------------------------------------
// Mount plan and Compose override (pure functions, no side effects)
// ---------------------------------------------------------------------------------------------

export interface BindMount {
  /** Real path on host (symlinks resolved: Docker Desktop does not follow them). */
  source: string;
  /** Path inside container. */
  target: string;
}

export interface AccountMount {
  account: DetectedAccount;
  /** Account config dir on host. */
  hostDir: string;
  /** Container path where account appears: /claude/<id>. */
  mountDir: string;
  binds: BindMount[];
}

/** Usage windows displayed by server (other cache keys are ignored). */
const USAGE_WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'] as const;

type CachedWindow = { utilization: unknown; resets_at?: unknown };
type CachedUsage = { fetchedAtMs: unknown; utilization: Partial<Record<(typeof USAGE_WINDOWS)[number], CachedWindow>> };

export interface AccountPayload {
  id: string;
  /** Only in Codex accounts (absent = Claude Code). */
  provider?: 'codex';
  configDir: string;
  mountDir: string;
  short: string;
  name: string;
  email?: string;
  organization?: string;
  plan?: string;
  color: string;
  cachedUsage?: CachedUsage;
}

/** Real path of an existing directory, or undefined. */
function realDir(p: string): string | undefined {
  try {
    const real = realpathSync(p);
    return statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Mounts only projects/ and sessions/ of each account (those that exist). `accounts` comes from
 * detectAccounts(dirs) in the same order as `dirs`; the id (disambiguated basename) becomes the
 * folder name inside container, so server inside derives the exact same id.
 */
export function planMounts(dirs: string[], accounts: DetectedAccount[], resolveDir: (p: string) => string | undefined = realDir): AccountMount[] {
  const out: AccountMount[] = [];
  dirs.forEach((hostDir, i) => {
    const account = accounts[i];
    const mountDir = posix.join(CONTAINER_ROOT, account.id);
    const binds: BindMount[] = [];
    for (const sub of MOUNTED_SUBDIRS) {
      const source = resolveDir(join(hostDir, sub));
      if (source) binds.push({ source, target: posix.join(mountDir, sub) });
    }
    if (binds.length) out.push({ account, hostDir, mountDir, binds });
  });
  return out;
}

/**
 * Mounts only sessions/, archived_sessions/ and thread-writer-locks/ of each Codex folder (those that exist)
 * under /codex/<id>. `accounts` comes from detectCodexAccounts(dirs) in same order as `dirs`; id becomes
 * folder name inside container so server inside derives same id.
 */
export function planCodexMounts(dirs: string[], accounts: DetectedAccount[], resolveDir: (p: string) => string | undefined = realDir): AccountMount[] {
  const out: AccountMount[] = [];
  dirs.forEach((hostDir, i) => {
    const account = accounts[i];
    const mountDir = posix.join(CODEX_CONTAINER_ROOT, account.id);
    const binds: BindMount[] = [];
    for (const sub of CODEX_MOUNTED_SUBDIRS) {
      const source = resolveDir(join(hostDir, sub));
      if (source) binds.push({ source, target: posix.join(mountDir, sub) });
    }
    if (binds.length) out.push({ account, hostDir, mountDir, binds });
  });
  return out;
}

/** Codex account metadata for HABBLAUD_ACCOUNTS: `provider: 'codex'` and HOST directory in `configDir`. */
export function codexAccountsPayload(mounts: AccountMount[]): AccountPayload[] {
  return mounts.map(({ account: a, hostDir, mountDir }) => {
    const p: AccountPayload = { id: a.id, provider: 'codex', configDir: hostDir, mountDir, short: a.short, name: a.name, color: a.color };
    if (a.plan) p.plan = a.plan;
    return p;
  });
}

/** HABBLAUD_CODEX disabled (0, false, off, no) in docker:up runner environment. */
export function codexDisabled(env: NodeJS.ProcessEnv): boolean {
  const v = env.HABBLAUD_CODEX?.trim();
  return !!v && !/^(1|true|yes|sim|on)$/i.test(v);
}

/**
 * From Claude Code usage cache (`cachedUsageUtilization`), only collection timestamp and, for
 * each displayed window, percentage and reset time are forwarded. Account identifiers, billing, and
 * other fields are excluded (container environment is visible via `docker inspect`).
 */
export function sanitizeCachedUsage(raw: unknown): CachedUsage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  const fetchedAtMs = c.fetchedAtMs ?? c.fetchedAt;
  if (fetchedAtMs === undefined || !c.utilization || typeof c.utilization !== 'object') return undefined;
  const util = c.utilization as Record<string, unknown>;
  const out: CachedUsage = { fetchedAtMs, utilization: {} };
  for (const key of USAGE_WINDOWS) {
    const w = util[key];
    if (!w || typeof w !== 'object') continue;
    const { utilization, resets_at } = w as Record<string, unknown>;
    if (utilization === undefined || utilization === null) continue;
    out.utilization[key] = resets_at === undefined || resets_at === null ? { utilization } : { utilization, resets_at };
  }
  return Object.keys(out.utilization).length ? out : undefined;
}

/** Account metadata for HABBLAUD_ACCOUNTS (container cannot see host .claude.json). */
export function accountsPayload(mounts: AccountMount[]): AccountPayload[] {
  return mounts.map(({ account: a, mountDir }) => {
    const p: AccountPayload = { id: a.id, configDir: a.configDir, mountDir, short: a.short, name: a.name, color: a.color };
    if (a.email) p.email = a.email;
    if (a.organization) p.organization = a.organization;
    if (a.plan) p.plan = a.plan;
    const cached = sanitizeCachedUsage(a.cachedUsage);
    if (cached) p.cachedUsage = cached;
    return p;
  });
}

/**
 * Safe YAML scalar: JSON string (valid as YAML double-quoted string) with doubled `$`
 * so Compose does not attempt variable interpolation inside values.
 */
export function yamlString(value: string): string {
  return JSON.stringify(value.replaceAll('$', '$$$$'));
}

/**
 * Host timezone (TZ or system timezone) for container: without it Node in container defaults to UTC and
 * "day" for timelapse and daily dashboard would roll over at 21h in Brasília time. Undefined if invalid.
 */
export function hostTimeZone(env: NodeJS.ProcessEnv = process.env): string | undefined {
  let tz = env.TZ?.trim().replace(/^:/, '');
  if (!tz) {
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return undefined;
    }
  }
  return tz && /^[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(tz) ? tz : undefined;
}

/**
 * `usageDir`: host folder with usage captured by statusline tap (already existing; real path),
 * mounted read-only at /usage. `timeZone`: host timezone passed as TZ. `codex`: Codex account mounts
 * (planCodexMounts).
 */
export function renderOverride(
  mounts: AccountMount[],
  generatedAt: Date = new Date(),
  usageDir?: string,
  timeZone?: string,
  codex: AccountMount[] = [],
  remoteTlsDir?: string,
  extraPorts: string[] = [],
): string {
  const env: Array<[string, string]> = [
    ['HABBLAUD_CLAUDE_DIRS', mounts.map((m) => m.mountDir).join(',')],
    ['HABBLAUD_ACCOUNTS', JSON.stringify([...accountsPayload(mounts), ...codexAccountsPayload(codex)])],
  ];
  if (codex.length) env.push(['HABBLAUD_CODEX_DIRS', codex.map((m) => m.mountDir).join(',')]);
  if (usageDir) env.push(['HABBLAUD_USAGE_DIR', CONTAINER_USAGE_DIR]);
  if (timeZone) env.push(['TZ', timeZone]);
  const lines = [
    `# Gerado por scripts/docker-up.ts em ${generatedAt.toISOString()} — não edite: é recriado a cada \`npm run docker:up\`.`,
    '# Contém caminhos do host e e-mails das contas: fica fora do git e com permissão 600.',
    '# Montagens: SOMENTE <conta>/projects, <conta>/sessions e a pasta do uso do statusline, todas somente leitura.',
    ...(codex.length ? ['# Codex: SOMENTE <pasta>/sessions, <pasta>/archived_sessions e <pasta>/thread-writer-locks, somente leitura.'] : []),
    'services:',
    `  ${SERVICE}:`,
    '    environment:',
    ...env.map(([k, v]) => `      ${k}: ${yamlString(v)}`),
  ];
  // Compose merges these ports with docker-compose.yml.
  if (extraPorts.length) lines.push('    ports:', ...extraPorts.map((p) => `      - ${yamlString(p)}`));
  const binds = [...mounts, ...codex].flatMap((m) => m.binds);
  if (usageDir) binds.push({ source: usageDir, target: CONTAINER_USAGE_DIR });
  // Remote access: ONLY server certificate directory (CA private key remains on host).
  if (remoteTlsDir) binds.push({ source: remoteTlsDir, target: CONTAINER_REMOTE_TLS_DIR });
  if (binds.length) {
    lines.push('    volumes:');
    for (const b of binds) {
      lines.push(
        '      - type: bind',
        `        source: ${yamlString(b.source)}`,
        `        target: ${yamlString(b.target)}`,
        '        read_only: true',
        '        bind:',
        '          create_host_path: false',
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Footer hint in docker:up regarding mod: only displayed when no account has mod installed (those who
 * already installed receive automatic updates or a warning). Without Claude Code CLI, indeterminate: stays silent.
 */
export function modHint(mod: Pick<ModUpdateResult, 'installed' | 'unavailable'>): string[] {
  if (mod.installed || mod.unavailable) return [];
  return [
    tr('  Uso de 5h/semanal ao vivo, responder e mandar mensagens pelo escritório: npm run mod:install (uma vez; Claude Code {0}+).', [MIN_CLAUDE_VERSION]),
    tr('  Em versões anteriores do Claude Code: npm run usage:install e npm run hooks:install. Sem eles, vale o cache do /usage.'),
  ];
}

// ---------------------------------------------------------------------------------------------
// Legacy naming (CodeTown, up to 0.3.2): Docker startup plan and .env names (pure functions)
// ---------------------------------------------------------------------------------------------

/** Existing Docker state before startup. */
export interface DockerState {
  /** Legacy CodeTown container `codetown` (fixed container_name: binds name and port). */
  legacyContainer: boolean;
  /** Rede codetown_default. */
  legacyNetwork: boolean;
  /** Volume codetown_codetown-data (character names, timeline, statistics). */
  legacyVolume: boolean;
  /** Image codetown:local. */
  legacyImage: boolean;
  /** Habblaud data volume (habblaud_habblaud-data). */
  dataVolume: boolean;
}

export type UpStep =
  | { kind: 'remove-container'; name: string }
  | { kind: 'remove-network'; name: string }
  | { kind: 'compose'; args: string[] }
  | { kind: 'copy-volume'; from: string; to: string };

export interface UpPlan {
  steps: UpStep[];
  /** Commands to delete remnants of CodeTown, shown at end if migration occurred. */
  cleanup: string[];
}

/**
 * Startup steps for Habblaud. First cleans up legacy CodeTown container and network. If legacy volume
 * exists and new volume does not, data is copied: Compose creates volume (with Compose labels; manually created
 * volume yields warning and recreation prompt) and container in stopped state; copy runs and then starts up.
 * Legacy volume is never deleted here.
 */
export function planUp(state: DockerState, build: boolean): UpPlan {
  const steps: UpStep[] = [];
  if (state.legacyContainer) steps.push({ kind: 'remove-container', name: LEGACY_DOCKER.container });
  if (state.legacyNetwork) steps.push({ kind: 'remove-network', name: LEGACY_DOCKER.network });
  const copy = state.legacyVolume && !state.dataVolume;
  if (copy) {
    steps.push(
      { kind: 'compose', args: build ? ['up', '--no-start', '--build'] : ['up', '--no-start'] },
      { kind: 'copy-volume', from: LEGACY_DOCKER.volume, to: DATA_VOLUME },
      { kind: 'compose', args: ['up', '-d'] },
    );
  } else steps.push({ kind: 'compose', args: build ? ['up', '-d', '--build'] : ['up', '-d'] });

  const cleanup: string[] = [];
  if (state.legacyContainer || copy) {
    if (state.legacyVolume) cleanup.push(`docker volume rm ${LEGACY_DOCKER.volume}`);
    if (state.legacyImage) cleanup.push(`docker image rm ${LEGACY_DOCKER.image}`);
  }
  return { steps, cleanup };
}

/**
 * Disposable `docker run` copying volume `from` (read-only) to `to` using Habblaud image itself,
 * as root (image runs as `node`) and without network; root of `to` receives owner and permissions of `from`.
 * `--rm` automatically removes anonymous volume of VOLUME /data from image.
 */
export function copyVolumeArgs(from: string, to: string, image: string = IMAGE): string[] {
  const script = 'set -e; cp -a /from/. /to/; chown "$(stat -c %u:%g /from)" /to; chmod "$(stat -c %a /from)" /to';
  const flags = ['--rm', '--pull', 'never', '--network', 'none', '--no-healthcheck', '--user', '0:0', '--entrypoint', 'sh'];
  return ['run', ...flags, '-v', `${from}:/from:ro`, '-v', `${to}:/to`, image, '-c', script];
}

/** Variable names from a .env file (`NAME=value` lines, with or without `export`). Values excluded. */
export function envFileKeys(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

/** Habblaud World variables passed by docker-compose.yml to container. */
const WORLD_ENV_KEYS = ['HABBLAUD_WORLD', 'HABBLAUD_WORLD_URL', 'HABBLAUD_WORLD_DEV'] as const;

/**
 * Habblaud World summary line at conclusion of docker:up: what container will read (environment overrides .env,
 * as in Compose), validated via same parseWorldConfig as server (inside container there is no `--dev`: only HABBLAUD_WORLD_DEV).
 * Displays only normalized address, never raw value (which could contain username and password).
 */
export function worldLine(env: NodeJS.ProcessEnv, envFile = ''): string {
  const vars: NodeJS.ProcessEnv = {};
  for (const key of WORLD_ENV_KEYS) {
    const value = key in env ? env[key] : readEnvValue(envFile, key);
    if (value !== undefined) vars[key] = value;
  }
  const world = parseWorldConfig(vars, []);
  if (!world.enabled) return tr('Habblaud World: desligado (HABBLAUD_WORLD={0}).', [vars.HABBLAUD_WORLD?.trim() ?? '0']);
  if (world.url) return world.defaultUrl ? tr('Habblaud World: ligado: {0} (padrão)', [world.url]) : tr('Habblaud World: ligado: {0}', [world.url]);
  return tr('Habblaud World: desligado ({0}).', [world.warning ?? tr('HABBLAUD_WORLD_URL recusada')]);
}

// ---------------------------------------------------------------------------------------------
// Host state (~/.habblaud)
// ---------------------------------------------------------------------------------------------

/** The .env of this directory ('' if absent). */
function readEnvFile(): string {
  try {
    return readFileSync(ENV_FILE, 'utf8');
  } catch {
    return '';
  }
}

/** Warns about legacy CODETOWN_* variables (ignored) in environment and project .env. */
function warnLegacyEnv(): void {
  let fileKeys: string[] = [];
  try {
    fileKeys = envFileKeys(readFileSync(ENV_FILE, 'utf8'));
  } catch {
    // no .env (normal) or unreadable: nothing to warn
  }
  for (const msg of [legacyEnvWarning(Object.keys(process.env)), legacyEnvWarning(fileKeys, tr('no .env'))]) {
    if (msg) warn(msg);
  }
}

/** Migrates ~/.codetown (legacy name) to ~/.habblaud; runs prior to creating usage folder so it acts as rename. */
function migrateStateDir(): void {
  const result = migrateLegacyStateDir(HOME);
  const msg = describeStateMigration(result);
  if (msg) (result.error ? warn : say)(msg);
}

/** Creates statusline usage folder if absent and returns real path (or undefined on failure). */
function ensureUsageDir(): string | undefined {
  try {
    mkdirSync(USAGE_DIR, { recursive: true, mode: 0o700 });
    return realDir(USAGE_DIR);
  } catch (err) {
    warn(tr('não consegui criar {0} ({1}); o uso do statusline não vai aparecer no container.', [tildify(USAGE_DIR), (err as Error).message]));
    return undefined;
  }
}

function tildify(p: string): string {
  return p === HOME || p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p;
}

// ---------------------------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------------------------

function checkDocker(): void {
  const info = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' });
  if (info.error) fail(tr('o comando "docker" não foi encontrado. Instale o Docker Desktop: https://www.docker.com/products/docker-desktop/'));
  if (info.status !== 0) fail(tr('o Docker não está respondendo. Abra o Docker Desktop, espere ele terminar de iniciar e tente de novo.'));
  const compose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  if (compose.status !== 0) fail(tr('o Docker Compose v2 ("docker compose") não está disponível. Atualize o Docker Desktop.'));
}

function compose(args: string[], port: number): void {
  // Explicit HABBLAUD_PORT: takes precedence over possible .env in project folder.
  const res = spawnSync('docker', ['compose', ...args], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, HABBLAUD_PORT: String(port) } });
  if (res.error) fail(tr('não consegui rodar "docker compose {0}": {1}', [args.join(' '), res.error.message]));
  if (res.status !== 0) fail(tr('"docker compose {0}" falhou (código {1}).', [args.join(' '), res.status ?? res.signal]));
}

/** `docker <args>` without terminal output: on success, output and last stderr line. */
function dockerQuiet(args: string[]): { ok: boolean; out: string; error: string } {
  const res = spawnSync('docker', args, { encoding: 'utf8' });
  // Last docker line is usually just "Run 'docker run --help' for more information".
  const lines = (res.stderr ?? '').split('\n').filter((l) => l.trim() && !/^Run '.*--help'/.test(l));
  const error = res.error?.message || lines.pop()?.trim() || tr('código {0}', [res.status ?? res.signal]);
  return { ok: res.status === 0, out: res.stdout ?? '', error };
}

/** Existing Docker resources for CodeTown and Habblaud (input to planUp). */
function inspectDocker(): DockerState {
  const exists = (kind: 'network' | 'volume' | 'image', name: string) => dockerQuiet([kind, 'inspect', name]).ok;
  // Only removes container `codetown` if it actually belongs to CodeTown: old image or old Compose project.
  const { container, image } = LEGACY_DOCKER;
  const c = dockerQuiet(['container', 'inspect', '--format', '{{.Config.Image}} {{index .Config.Labels "com.docker.compose.project"}}', container]);
  const [cImage = '', cProject = ''] = c.out.trim().split(' ');
  const legacyContainer = c.ok && (cImage === image || cProject === LEGACY_NAME);
  if (c.ok && !legacyContainer) warn(tr('existe um container {0} que não é do CodeTown (imagem {1}); ele fica como está.', [container, cImage || '?']));
  return {
    legacyContainer,
    legacyNetwork: exists('network', LEGACY_DOCKER.network),
    legacyVolume: exists('volume', LEGACY_DOCKER.volume),
    legacyImage: exists('image', image),
    dataVolume: exists('volume', DATA_VOLUME),
  };
}

/** Copies data from CodeTown volume to Habblaud volume. Failure is only a warning: office starts without them. */
function copyVolume(from: string, to: string): boolean {
  // New volume must come from Compose: `docker run -v` would create one without Compose labels.
  if (!dockerQuiet(['volume', 'inspect', to]).ok) {
    warn(tr('o Compose não criou o volume {0}; os dados do CodeTown não foram copiados e continuam em {1}.', [to, from]));
    return false;
  }
  say(tr('Copiando os dados do CodeTown (nomes dos personagens, linha do tempo e estatísticas) de {0} para {1}…', [from, to]));
  const res = dockerQuiet(copyVolumeArgs(from, to));
  if (!res.ok) {
    warn(
      tr('não consegui copiar os dados do CodeTown ({0}). O escritório sobe sem eles; os dados continuam em {1}.\n', [res.error, from]) +
        tr('  Para tentar de novo: npm run docker:down && docker volume rm {0} && npm run docker:up', [to]),
    );
    return false;
  }
  say(tr('Dados copiados; o volume {0} ficou intacto.', [from]));
  return true;
}

/** Executes planUp steps. Only Compose failure or unremovable legacy container abort docker:up. */
function runPlan(plan: UpPlan, port: number, build: boolean): { copyFailed: boolean } {
  let copyFailed = false;
  let created = false;
  for (const step of plan.steps) {
    switch (step.kind) {
      case 'remove-container': {
        say(tr('Removendo o container {0} (CodeTown, o nome antigo)…', [step.name]));
        const res = dockerQuiet(['rm', '-f', step.name]);
        if (!res.ok) fail(tr('não consegui remover o container antigo {0} ({1}). Remova com docker rm -f {2} e rode de novo.', [step.name, res.error, step.name]));
        break;
      }
      case 'remove-network': {
        const res = dockerQuiet(['network', 'rm', step.name]);
        if (!res.ok) warn(tr('não consegui remover a rede antiga {0} ({1}); apague depois com docker network rm {2}.', [step.name, res.error, step.name]));
        break;
      }
      case 'copy-volume':
        copyFailed = !copyVolume(step.from, step.to);
        break;
      case 'compose':
        if (step.args.includes('--no-start')) {
          say(tr('{0} o container, ainda parado, para receber os dados do CodeTown…', [build ? tr('Construindo a imagem e criando') : tr('Criando')]));
          created = true;
        } else if (created) say(tr('Subindo o container…'));
        else say(build ? tr('Construindo a imagem e subindo o container…') : tr('Subindo o container (sem reconstruir a imagem)…'));
        compose(step.args, port);
        break;
    }
  }
  return { copyFailed };
}

interface Health {
  ok: boolean;
  version?: string;
  demo?: boolean;
  docker?: boolean;
  sources?: SourceInfo[];
  accounts?: Array<{ id: string; usageStatus: AccountInfo['usageStatus'] }>;
}

async function fetchHealth(baseUrl: string, timeoutMs: number): Promise<Health | undefined> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as Health;
    return body?.ok ? body : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

async function waitHealthy(baseUrl: string): Promise<Health | undefined> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const health = await fetchHealth(baseUrl, 3_000);
    if (health) return health;
    await sleep(1_000);
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

function down(port: number): void {
  checkDocker();
  say(tr('Derrubando o container…'));
  compose(['down'], port);
  say(tr('Pronto. Os nomes dos personagens continuam guardados no volume habblaud-data.'));
}

async function up(opts: Options, port: number): Promise<void> {
  checkDocker();
  warnLegacyEnv();
  const baseUrl = `http://127.0.0.1:${port}`;
  const publicUrl = `http://localhost:${port}`;

  // Port occupied by Habblaud outside Docker (npm run dev / npm start)?
  const existing = await fetchHealth(baseUrl, 1_500);
  if (existing && !existing.docker) {
    fail(
      tr('já existe um Habblaud rodando fora do Docker em {0} (npm run dev ou npm start?).\n', [publicUrl]) +
        tr(`Pare-o antes, ou use outra porta: HABBLAUD_PORT=4848 npm run docker:up`),
    );
  }

  const dirs = discoverClaudeDirs(process.env, HOME);
  const accounts = detectAccounts(dirs, { home: HOME, env: process.env });
  const mounts = planMounts(dirs, accounts);
  if (!mounts.length) {
    warn(
      tr('nenhuma pasta do Claude Code (com projects/ ou sessions/) foi encontrada em ~/.claude*.\n') +
        tr('  O escritório vai abrir vazio (dá para ligar o modo demonstração na interface).\n') +
        tr('  Se as contas estiverem em outro lugar: HABBLAUD_CLAUDE_DIRS=/caminho/conta1,/caminho/conta2 npm run docker:up'),
    );
  }
  for (const m of mounts) {
    const subdirs = m.binds.map((b) => posix.basename(b.target)).join(' e ');
    say(tr('Conta {0} ({1}): monta {2} de {3}, somente leitura.', [m.account.short, m.account.id, subdirs, tildify(m.hostDir)]));
  }
  for (const dir of dirs) {
    if (!mounts.some((m) => m.hostDir === dir)) warn(tr('{0} não tem projects/ nem sessions/; conta ignorada.', [tildify(dir)]));
  }
  // Codex folder (CODEX_HOME) listed or discovered as if Claude Code: not mounted as Claude account.
  // It is mounted (only conversations and locks) as Codex account below.
  const claudeRefused = codexDirsRefused(process.env, HOME);
  const codexDirs = codexDisabled(process.env) ? [] : discoverCodexDirs(process.env, HOME);
  for (const dir of claudeRefused) if (!codexDirs.includes(dir)) warn(tr('{0} é uma pasta do Codex, não do Claude Code; conta ignorada.', [tildify(dir)]));
  const codexAccounts = detectCodexAccounts(codexDirs, {
    home: HOME,
    env: process.env,
    taken: { shorts: accounts.map((a) => a.short), colors: accounts.map((a) => a.color) },
  });
  const codexMounts = planCodexMounts(codexDirs, codexAccounts);
  for (const m of codexMounts) {
    const subdirs = m.binds.map((b) => posix.basename(b.target)).join(', ');
    say(tr('Codex {0} ({1}): monta {2} de {3}, somente leitura.', [m.account.short, m.account.id, subdirs, tildify(m.hostDir)]));
    if (!m.binds.some((b) => b.target.endsWith('/thread-writer-locks'))) {
      warn(tr('{0} ainda não tem thread-writer-locks/: no container, sessão aberta = conversa modificada nos últimos 30 min (rode o docker:up de novo depois de usar o Codex).', [tildify(m.hostDir)]));
    }
  }

  migrateStateDir();
  const usageDir = ensureUsageDir();
  if (usageDir) say(tr('Uso ao vivo (mod ou tap de statusline): monta {0} em {1}, somente leitura.', [tildify(USAGE_DIR), CONTAINER_USAGE_DIR]));
  const remoteTlsDir = prepareRemoteTls();
  const remotePorts = remoteTlsDir || remoteInsecure() ? remotePortsToPublish() : [];
  const tmp = `${OVERRIDE_FILE}.tmp`;
  writeFileSync(tmp, renderOverride(mounts, new Date(), usageDir, hostTimeZone(), codexMounts, remoteTlsDir, remotePorts), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, OVERRIDE_FILE);
  say(tr('docker-compose.override.yml gerado.'));

  const plan = planUp(inspectDocker(), opts.build);
  const { copyFailed } = runPlan(plan, port, opts.build);

  say(tr('Aguardando o Habblaud responder em {0}…', [publicUrl]));
  const health = await waitHealthy(baseUrl);
  if (!health) fail(tr('o Habblaud não respondeu em {0} s. Veja o que aconteceu com: npm run docker:logs', [HEALTH_TIMEOUT_MS / 1000]));

  console.log('');
  say(tr('Habblaud{0} no ar: {1}', [health.version ? ` ${health.version}` : '', publicUrl]));
  for (const acc of accounts) {
    const src = health.sources?.find((s) => s.label === acc.id);
    if (!src) continue;
    const usage = health.accounts?.find((a) => a.id === acc.id)?.usageStatus;
    const state = src.ok ? plural(src.sessions, tr('sessão aberta'), tr('sessões abertas')) : tr('erro ao ler ({0})', [src.error ?? tr('desconhecido')]);
    say(tr('  Conta {0} ({1}): {2}{3}', [acc.short, acc.id, state, usage ? ` · ${USAGE_STATUS[usage]}` : '']));
  }
  for (const m of codexMounts) {
    const src = health.sources?.find((s) => s.label === m.account.id && s.provider === 'codex');
    if (!src) continue;
    const usage = health.accounts?.find((a) => a.id === m.account.id)?.usageStatus;
    const state = src.ok ? plural(src.sessions, tr('sessão aberta'), tr('sessões abertas')) : tr('erro ao ler ({0})', [src.error ?? tr('desconhecido')]);
    say(`  Codex ${m.account.short} (${m.account.id}): ${state}${usage ? ` · ${USAGE_STATUS[usage]}` : ''}`);
  }
  for (const line of modHint(updateMods(dirs, accounts))) say(line);
  // If copy failed, data only exists in legacy volume: do not suggest deleting it.
  if (plan.cleanup.length && !copyFailed) say(tr('  Sobrou do CodeTown; depois de conferir o escritório, apague com: {0}', [plan.cleanup.join(' · ')]));
  say(`  ${worldLine(process.env, readEnvFile())}`);
  say(tr('  Logs: npm run docker:logs · Parar: npm run docker:down'));
}

/**
 * Remote access enabled in .env (npm run remote:setup): checks server certificate and renews when Wi-Fi IP
 * changes or certificate nears expiration (CA remains unchanged, so phone continues trusting). Returns mount folder.
 */
function prepareRemoteTls(): string | undefined {
  let env = '';
  try {
    env = readFileSync(ENV_FILE, 'utf8');
  } catch {
    return undefined;
  }
  if (!readEnvValue(env, 'HABBLAUD_REMOTE_USER')) return undefined;
  const paths = tlsPaths(remoteTlsBase(HOME));
  if (!statOk(paths.caCert)) {
    warn(tr('acesso remoto configurado, mas sem a CA local: rode npm run remote:setup.'));
    return undefined;
  }
  try {
    const targets = remoteTargets({ name: readEnvValue(env, 'HABBLAUD_REMOTE_NAME'), domain: readEnvValue(env, 'HABBLAUD_REMOTE_DOMAIN') });
    const r = ensureServerCert(paths, targets);
    if (r.issued) say(tr('Acesso remoto: certificado do servidor renovado ({0}).', [r.reason]));
    say(tr('Acesso remoto: monta {0} em {1}, somente leitura.', [tildify(paths.serverDir), CONTAINER_REMOTE_TLS_DIR]));
    return paths.serverDir;
  } catch (err) {
    warn(tr('acesso remoto: não consegui conferir o certificado ({0}).', [(err as Error).message]));
    return statOk(paths.serverCert) ? paths.serverDir : undefined;
  }
}

/**
 * Ports for mobile access, only when configured (HABBLAUD_REMOTE_USER in .env): remote (HABBLAUD_REMOTE_PORT,
 * default 4748) and, if set, HABBLAUD_REMOTE_HTTP_PORT (setup writes 80 when remote is 443), hitting container port
 * and responding with HTTP 308 redirect to https:// — typing "meuclaude.local" redirects to HTTPS. Without
 * setup, only 4747 is published.
 */
export function remotePortsFrom(env: string): string[] {
  if (!readEnvValue(env, 'HABBLAUD_REMOTE_USER')) return [];
  const bind = readEnvValue(env, 'HABBLAUD_REMOTE_BIND') || '127.0.0.1';
  const valid = (n: number) => Number.isInteger(n) && n > 0 && n < 65536;
  const raw = readEnvValue(env, 'HABBLAUD_REMOTE_PORT');
  const port = raw ? Number(raw) : 4748;
  const out = valid(port) ? [`${bind}:${port}:4748`] : [];
  const http = Number(readEnvValue(env, 'HABBLAUD_REMOTE_HTTP_PORT'));
  if (valid(http) && http !== port) out.push(`${bind}:${http}:4748`);
  return out;
}

function remoteInsecure(): boolean {
  try {
    const env = readFileSync(ENV_FILE, 'utf8');
    return !!readEnvValue(env, 'HABBLAUD_REMOTE_USER') && /^(1|true|yes|sim|on)$/i.test(readEnvValue(env, 'HABBLAUD_REMOTE_INSECURE_HTTP') ?? '');
  } catch {
    return false;
  }
}

function remotePortsToPublish(): string[] {
  try {
    const ports = remotePortsFrom(readFileSync(ENV_FILE, 'utf8'));
    for (const p of ports) say(tr('Acesso remoto: publica {0} (porta {1} do container).', [p.split(':').slice(0, 2).join(':'), 4748]));
    return ports;
  } catch {
    return [];
  }
}

function statOk(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Updates mod for existing installations (see mod-install.ts). Nothing here aborts docker:up. */
function updateMods(dirs: string[], accounts: DetectedAccount[]): Pick<ModUpdateResult, 'installed' | 'unavailable'> {
  try {
    const labels = dirs.map((dir, i) => ({ dir, label: tr('Conta {0}', [accounts[i]?.short ?? tildify(dir)]) }));
    const mod = updateInstalledMods(labels, { env: process.env, home: HOME, root: ROOT, version: readPackageVersion(ROOT), claude: makeClaudeRunner() });
    for (const l of mod.lines) {
      if (l.level === 'warn') warn(l.text);
      else say(`  ${l.text}`);
    }
    return mod;
  } catch (err) {
    warn(tr('não consegui conferir o mod do Habblaud ({0}).', [(err as Error).message]));
    return { installed: false, unavailable: true };
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const port = hostPort(process.env);
  if (opts.down) down(port);
  else await up(opts, port);
}

// Executes only when called directly (importing module, e.g. in tests, performs no action).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    if (err instanceof FatalError) console.error(tr('[docker-up] Erro: {0}', [err.message]));
    else console.error(tr('[docker-up] Erro inesperado:'), err);
    process.exitCode = 1;
  });
}
