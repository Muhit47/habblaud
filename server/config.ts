// Server configuration from environment variables (documented in server/README.md).
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverClaudeDirs } from './accounts/detect';
import { parseAllowedHosts } from './http/guard';
import { parseRemoteConfig, type RemoteConfig } from './http/remote';
import { parseGithubRepo } from './updates/checker';
import { tr } from '../shared/i18n';

export interface ServerConfig {
  port: number;
  host: string;
  /** `--dev`: Vite in middleware mode (HMR) within the same server. */
  dev: boolean;
  /** Starts demonstration simulator on boot. */
  demo: boolean;
  /** Running inside a container (registry PIDs belong to host: cannot be inspected). */
  inDocker: boolean;
  home: string;
  /** Watched Claude Code config directories (one per account). */
  claudeDirs: string[];
  /** Where Habblaud persists its own state (persisted names). */
  dataDir: string;
  /**
   * Directory with usage captured by Claude Code statusline (scripts/statusline-tap.mjs):
   * HABBLAUD_USAGE_DIR or ~/.habblaud/usage. In Docker, docker-up mounts this directory at /usage.
   */
  usageDir: string;
  /** Additional hostnames allowed in Host/Origin headers (HABBLAUD_ALLOWED_HOSTS); localhost and IPs are always valid. */
  allowedHosts: Set<string>;
  /**
   * Terminal (GET /api/agents/:id/terminal) enabled: only with local bind, i.e., Habblaud accessible only
   * from this computer (see terminalOffReason). Security lock for everything that displays or acts on sessions.
   */
  terminal: boolean;
  /**
   * Office messaging (POST /api/messages and habblaud-mensagens plugin inbox) enabled: terminal
   * lock and HABBLAUD_MENSAGENS not disabled (see messagesOffReason).
   */
  messages: boolean;
  /** Records office timeline for timelapse (<dataDir>/timeline); HABBLAUD_TIMELINE=0 disables. */
  timeline: boolean;
  /** Project root (where package.json resides); serves dist/client from here. */
  rootDir: string;
  version: string;
  /** GitHub repository ("owner/repo", from package.json `repository` field) where new releases are published. */
  repo?: string;
  /** Checks GitHub for new releases (server/updates/checker.ts); HABBLAUD_UPDATE_CHECK=0 disables. */
  updateCheck: boolean;
  /** Watches Codex sessions (sources/codex/); HABBLAUD_CODEX=0 disables. */
  codex: boolean;
  antigravity?: boolean;
  kilo?: boolean;
  /** Secondary port with authentication for mobile on local network (http/remote.ts); absent = disabled. */
  remote?: RemoteConfig;
  /** Reason why remote access was disabled when configuration is incomplete. */
  remoteWarning?: string;
  /** Habblaud World (server/world/): account, character, and future phases of building in the world. */
  world: WorldConfig;
}

export interface WorldConfig {
  /** HABBLAUD_WORLD other than 0 (false, off, no): /api/world/* routes exist and UI shows world section. */
  enabled: boolean;
  /**
   * HTTP(S) base URL of world server without trailing slash (from HABBLAUD_WORLD_URL or DEFAULT_WORLD_URL;
   * `wss://` converts to `https://`). Absent = HABBLAUD_WORLD_URL rejected (`warning` explains why): feature disabled
   * and nothing leaves this computer. WebSocket uses same origin with /v1/socket.
   */
  url?: string;
  /** URL originated from default (HABBLAUD_WORLD_URL absent or empty). */
  defaultUrl?: true;
  /**
   * `--dev` or HABBLAUD_WORLD_DEV=1: also accepts `http://` and `ws://` for 127.0.0.1 and host.docker.internal (local world
   * server; from Habblaud container, host is host.docker.internal).
   */
  dev: boolean;
  /** Reason why HABBLAUD_WORLD_URL was rejected (logged on startup). */
  warning?: string;
}

export function isTruthy(v: string | undefined): boolean {
  return !!v && /^(1|true|yes|sim|on)$/i.test(v.trim());
}

/** Traverses up from `from` until finding project package.json. */
export function findRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const name = (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: unknown }).name;
        if (name === 'habblaud') return dir;
      } catch {
        // unreadable package.json: continue ascending
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(from, '..');
}

/** Version and repository from package.json. */
function readPackage(rootDir: string): { version: string; repo?: string } {
  try {
    const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as { version?: unknown; repository?: unknown };
    return { version: typeof pkg.version === 'string' ? pkg.version : '0.0.0', repo: parseGithubRepo(pkg.repository) };
  } catch {
    return { version: '0.0.0' };
  }
}

export function detectDocker(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.HABBLAUD_IN_DOCKER !== undefined) return isTruthy(env.HABBLAUD_IN_DOCKER);
  return existsSync('/.dockerenv');
}

/**
 * Listen address reachable only by local machine: 127.0.0.0/8, `::1` (with or without brackets),
 * or `localhost`. `0.0.0.0`, `::`, network IPs, and arbitrary hostnames do not qualify.
 */
export function isLoopbackBind(value: string | undefined): boolean {
  let v = value?.trim().toLowerCase() ?? '';
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
  if (v === 'localhost') return true;
  const family = isIP(v);
  if (family === 4) return v.startsWith('127.');
  if (family !== 6) return false;
  try {
    // Canonical form (0:0:0:0:0:0:0:1 -> [::1]).
    return new URL(`http://[${v}]/`).hostname === '[::1]';
  } catch {
    return false;
  }
}

/**
 * Why terminal is disabled (undefined = enabled). Transcripts contain full conversation history, so
 * it only enables when Habblaud is not exposed beyond the local machine:
 * - Node: HABBLAUD_HOST must be loopback;
 * - Docker: process always listens on 0.0.0.0 inside container and exposure is determined by port
 *   published on host, HABBLAUD_BIND (docker-compose.yml forwards the same value to container). Absent
 *   or empty = disabled: without it port exposure cannot be determined.
 * HABBLAUD_TERMINAL with any value other than truthy (0, false, off...) disables; cannot enable with exposed port.
 */
export function terminalOffReason(env: NodeJS.ProcessEnv, host: string, inDocker: boolean): string | undefined {
  const flag = env.HABBLAUD_TERMINAL?.trim();
  if (flag && !isTruthy(flag)) return `HABBLAUD_TERMINAL=${flag}`;
  if (inDocker) {
    const bind = env.HABBLAUD_BIND?.trim();
    if (!bind) return tr('HABBLAUD_BIND não chegou ao container, então a porta pode estar exposta na rede');
    return isLoopbackBind(bind) ? undefined : tr('a porta está exposta na rede: HABBLAUD_BIND={0}', [bind]);
  }
  return isLoopbackBind(host) ? undefined : tr('a porta está exposta na rede: HABBLAUD_HOST={0}', [host]);
}

/**
 * Why office messaging is disabled (undefined = enabled). Messages enter the session as if typed directly,
 * so they adhere to terminal lock; HABBLAUD_MENSAGENS with any falsy value (0, false, off, no...) disables messaging only.
 */
export function messagesOffReason(env: NodeJS.ProcessEnv, host: string, inDocker: boolean): string | undefined {
  const flag = env.HABBLAUD_MENSAGENS?.trim();
  if (flag && !isTruthy(flag)) return `HABBLAUD_MENSAGENS=${flag}`;
  const terminal = terminalOffReason(env, host, inDocker);
  return terminal ? tr('mesma trava do terminal: {0}', [terminal]) : undefined;
}

/**
 * Habblaud World server when HABBLAUD_WORLD_URL is absent or empty: World is enabled by default, but nothing leaves
 * the machine until user creates an account and signs in (server/world/service.ts). HABBLAUD_WORLD=0 disables everything.
 */
export const DEFAULT_WORLD_URL = 'https://server.habblaud.com';

/** Hosts accepted without TLS in dev mode: local machine and host.docker.internal from inside Docker. */
const LOCAL_WORLD_HOSTS: readonly string[] = ['127.0.0.1', 'host.docker.internal'];

/**
 * Habblaud World configuration from environment. Without HABBLAUD_WORLD_URL, uses DEFAULT_WORLD_URL. URL requires
 * `https://` or `wss://` (device token never travels without TLS); `http://` and `ws://` allowed only in dev mode for
 * 127.0.0.1 or host.docker.internal (local world server, viewed from outside or inside Docker). No path, user, password,
 * or query params allowed: server origin only. A configured but rejected URL does not fall back to default: feature
 * remains disabled, with reason in `warning`.
 */
export function parseWorldConfig(env: NodeJS.ProcessEnv, argv: string[]): WorldConfig {
  const flag = env.HABBLAUD_WORLD?.trim();
  const enabled = !flag || isTruthy(flag);
  const dev = argv.includes('--dev') || isTruthy(env.HABBLAUD_WORLD_DEV);
  if (!enabled) return { enabled, dev };
  const raw = env.HABBLAUD_WORLD_URL?.trim();
  if (!raw) return { enabled, dev, url: DEFAULT_WORLD_URL, defaultUrl: true };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { enabled, dev, warning: tr('HABBLAUD_WORLD_URL não é um endereço válido') };
  }
  const secure = u.protocol === 'https:' || u.protocol === 'wss:';
  const local = (u.protocol === 'http:' || u.protocol === 'ws:') && LOCAL_WORLD_HOSTS.includes(u.hostname);
  if (!secure && !(local && dev)) {
    return {
      enabled,
      dev,
      warning: local
        ? tr('HABBLAUD_WORLD_URL com http:// (127.0.0.1 ou host.docker.internal) só vale no modo de desenvolvimento (--dev ou HABBLAUD_WORLD_DEV=1)')
        : tr('HABBLAUD_WORLD_URL precisa começar com https:// ou wss://'),
    };
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    return { enabled, dev, warning: tr('HABBLAUD_WORLD_URL deve ter só o endereço do servidor (sem caminho, usuário, senha ou parâmetros)') };
  }
  return { enabled, dev, url: `${secure ? 'https:' : 'http:'}//${u.host}` };
}

/** World WebSocket address derived from HTTP(S) base URL (ServerConfig.world.url). */
export function worldSocketUrl(base: string): string {
  return `${base.replace(/^http/, 'ws').replace(/\/+$/, '')}/v1/socket`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): ServerConfig {
  const home = env.HOME || homedir();
  const inDocker = detectDocker(env);
  const port = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  const rootDir = findRoot(dirname(fileURLToPath(import.meta.url)));
  const host = env.HABBLAUD_HOST?.trim() || '127.0.0.1';
  const pkg = readPackage(rootDir);
  const remote = parseRemoteConfig(env, inDocker);
  return {
    port: Number.isFinite(port) && port > 0 && port < 65536 ? port : 4747,
    host,
    dev: argv.includes('--dev'),
    demo: isTruthy(env.HABBLAUD_DEMO),
    inDocker,
    home,
    claudeDirs: discoverClaudeDirs(env, home),
    dataDir: resolve(env.HABBLAUD_DATA_DIR?.trim() || (inDocker ? '/data' : join(home, '.habblaud'))),
    usageDir: resolve(env.HABBLAUD_USAGE_DIR?.trim() || join(home, '.habblaud', 'usage')),
    allowedHosts: parseAllowedHosts(env.HABBLAUD_ALLOWED_HOSTS),
    terminal: terminalOffReason(env, host, inDocker) === undefined,
    messages: messagesOffReason(env, host, inDocker) === undefined,
    timeline: !env.HABBLAUD_TIMELINE?.trim() || isTruthy(env.HABBLAUD_TIMELINE),
    rootDir,
    version: pkg.version,
    repo: pkg.repo,
    updateCheck: !env.HABBLAUD_UPDATE_CHECK?.trim() || isTruthy(env.HABBLAUD_UPDATE_CHECK),
    codex: !env.HABBLAUD_CODEX?.trim() || isTruthy(env.HABBLAUD_CODEX),
    antigravity: env.HABBLAUD_ANTIGRAVITY !== '0',
    kilo: env.HABBLAUD_KILO !== '0',
    remote: remote.config,
    remoteWarning: remote.warning,
    world: parseWorldConfig(env, argv),
  };
}
