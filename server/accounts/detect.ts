// Claude Code account detection (one config dir per account) and account metadata.
// Pure Node with zero dependencies: also imported by scripts/docker-up.ts (via tsx) on host.
// Codex directories (CODEX_HOME, e.g. ~/.codex) also have `sessions/` and are excluded (isCodexHome):
// Codex accounts are discovered via Codex source and registered in AccountsService with `provider: 'codex'`.
//
// Privacy: from .claude.json we read ONLY the email and organization name of account profile
// (oauthAccount.{emailAddress, organizationName}) and usage cache (cachedUsageUtilization);
// from shell rc files, ONLY `alias X='... claude ...'` lines (and `alias X='... codex ...'` for
// Codex accounts: see sources/codex/accounts.ts). Credentials are never read and never logged.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { Provider } from '../../shared/types';
import { tr } from '../../shared/i18n';

export interface DetectedAccount {
  id: string;
  /** Account tool provider; omitted = 'claude' (detectAccounts returns Claude Code accounts only). */
  provider?: Provider;
  configDir: string;
  short: string;
  name: string;
  email?: string;
  organization?: string;
  plan?: string;
  color: string;
  cachedUsage?: unknown;
}

/** Fixed, distinct color palette assigned in deterministic account order. */
export const ACCOUNT_COLORS = ['#f08a3c', '#4aa8e8', '#5cc97b', '#a77bf3', '#f06fa0'] as const;

const RC_FILES = ['.zshrc', '.bashrc', '.zprofile', '.bash_profile'];

/** Override from HABBLAUD_ACCOUNTS (host passes prepared metadata to container). */
export interface AccountOverride {
  id?: string;
  /** Account provider; omitted = 'claude'. Codex accounts are excluded from Claude Code account discovery. */
  provider?: Provider;
  configDir?: string;
  mountDir?: string;
  short?: string;
  name?: string;
  email?: string;
  organization?: string;
  plan?: string;
  color?: string;
  cachedUsage?: unknown;
}

export interface ClaudeAlias {
  /** Alias name, as typed in shell (e.g. "d"). */
  name: string;
  /**
   * Absolute directory for alias variable (CLAUDE_CONFIG_DIR; in Codex, CODEX_HOME); absent = default account
   * ($HOME/.claude; in Codex, its default folder).
   */
  configDir?: string;
}

function splitList(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Expande `~`, `$HOME` e `${HOME}` e devolve o caminho absoluto sem barra final. */
export function expandHome(p: string, home: string): string {
  const expanded = p
    .trim()
    .replace(/^~(?=\/|$)/, home)
    .replace(/\$\{HOME\}|\$HOME\b/g, home);
  const abs = resolve(expanded);
  return abs.length > 1 ? abs.replace(/\/+$/, '') : abs;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Year directory (YYYY) inside sessions/: Codex stores rollouts in sessions/YYYY/MM/DD/. */
const YEAR_DIR = /^\d{4}$/;

/**
 * Is this directory Codex (a CODEX_HOME, e.g. ~/.codex)? It also contains `sessions/`; without this check it would become an
 * empty Claude Code account and the watcher would parse `sessions/` as a session registry. Strictly signatures that Claude Code
 * never writes, verified by EXISTENCE (nothing is parsed, neither `auth.json` nor `config.toml`):
 * - `sessions/YYYY/` (rollouts partitioned by date; Claude Code writes `sessions/<pid>.json` directly there);
 * - `thread-writer-locks/` or `archived_sessions/`;
 * - `config.toml` or `auth.json`.
 * With `projects/` (which Codex never creates) it is always Claude Code: existing accounts remain valid.
 * Non-existent or empty directory is not Codex.
 */
export function isCodexHome(p: string): boolean {
  if (isDir(join(p, 'projects'))) return false;
  if (isDir(join(p, 'thread-writer-locks')) || isDir(join(p, 'archived_sessions'))) return true;
  if (isFile(join(p, 'config.toml')) || isFile(join(p, 'auth.json'))) return true;
  try {
    return readdirSync(join(p, 'sessions'), { withFileTypes: true }).some((e) => e.isDirectory() && YEAR_DIR.test(e.name));
  } catch {
    return false;
  }
}

/** Looks like a Claude Code config dir (`projects/` or `sessions/`), without checking if it is Codex. */
function hasClaudeLayout(p: string): boolean {
  return isDir(join(p, 'projects')) || isDir(join(p, 'sessions'));
}

/** Claude Code config dir: has `projects/` or `sessions/`, and is not a Codex folder. */
export function isClaudeDir(p: string): boolean {
  return hasClaudeLayout(p) && !isCodexHome(p);
}

export function isDefaultDir(dir: string, home: string): boolean {
  return resolve(dir) === resolve(home, '.claude');
}

export function parseAccountOverrides(raw: string | undefined): AccountOverride[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((o): o is AccountOverride => !!o && typeof o === 'object' && !Array.isArray(o));
  } catch {
    return [];
  }
}

/** Claude Code account overrides (without `provider` or with 'claude'); Codex overrides belong to its source. */
function claudeOverrides(raw: string | undefined): AccountOverride[] {
  return parseAccountOverrides(raw).filter((o) => o.provider === undefined || o.provider === 'claude');
}

/**
 * Watched config directories. HABBLAUD_CLAUDE_DIRS (comma-separated list) overrides everything;
 * otherwise: `$HOME/.claude*` directories containing `projects/` or `sessions/`, plus CLAUDE_CONFIG_DIR
 * (also accepts list) and existing `mountDir` from HABBLAUD_ACCOUNTS.
 * In all paths, Codex directories are excluded (isCodexHome; see codexDirsRefused).
 * Stable ordering: default account first, then alphabetical.
 */
export function discoverClaudeDirs(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  return scanClaudeDirs(env, home).dirs;
}

/**
 * Directories found by Claude Code account discovery (or passed via HABBLAUD_CLAUDE_DIRS,
 * CLAUDE_CONFIG_DIR, or HABBLAUD_ACCOUNTS) and rejected because they are Codex: logs notification to user.
 */
export function codexDirsRefused(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  return scanClaudeDirs(env, home).codex;
}

function scanClaudeDirs(env: NodeJS.ProcessEnv, home: string): { dirs: string[]; codex: string[] } {
  const codex: string[] = [];
  /** Excluded if from Codex (annotated in `codex`). */
  const notCodex = (p: string) => {
    if (!isCodexHome(p)) return true;
    codex.push(p);
    return false;
  };
  const unique = (list: string[]) => [...new Set(list)];

  const override = splitList(env.HABBLAUD_CLAUDE_DIRS);
  if (override.length) {
    const dirs = unique(override.map((p) => expandHome(p, home)));
    return { dirs: dirs.filter(notCodex), codex };
  }

  const found: string[] = [];
  try {
    for (const ent of readdirSync(home, { withFileTypes: true })) {
      if (!ent.name.startsWith('.claude')) continue;
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const p = join(home, ent.name);
      if (hasClaudeLayout(p) && notCodex(p)) found.push(p);
    }
  } catch {
    // $HOME unreadable (e.g. container without home): continue with other sources
  }
  for (const p of splitList(env.CLAUDE_CONFIG_DIR)) {
    const abs = expandHome(p, home);
    if (isDir(abs) && notCodex(abs)) found.push(abs);
  }
  for (const o of claudeOverrides(env.HABBLAUD_ACCOUNTS)) {
    if (typeof o.mountDir !== 'string') continue;
    if (hasClaudeLayout(o.mountDir) && notCodex(o.mountDir)) found.push(expandHome(o.mountDir, home));
  }
  const dirs = unique(found.map((p) => expandHome(p, home)));
  dirs.sort((a, b) => {
    const da = isDefaultDir(a, home) ? 0 : 1;
    const db = isDefaultDir(b, home) ? 0 : 1;
    return da - db || a.localeCompare(b);
  });
  return { dirs, codex: unique(codex.map((p) => expandHome(p, home))) };
}

const ALIAS_RE = /^\s*alias\s+([A-Za-z0-9_][A-Za-z0-9_.-]*)=(?:'([^']*)'|"((?:[^"\\]|\\.)*)")\s*(?:#.*)?$/;
const ALIAS_TOOLS: Partial<Record<Provider, { invokes: RegExp; dir: RegExp }>> = {
  claude: {
    invokes: /(?:^|[\s;&|(])(?:[\w.~/-]*\/)?claude(?=$|[\s;&|)])/,
    dir: /\bCLAUDE_CONFIG_DIR=(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/,
  },
  codex: {
    invokes: /(?:^|[\s;&|(])(?:[\w.~/-]*\/)?codex(?=$|[\s;&|)])/,
    dir: /\bCODEX_HOME=(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/,
  },
};

/**
 * Extracts shell aliases invoking the tool (`claude` or `codex`), with account directory (CLAUDE_CONFIG_DIR
 * or CODEX_HOME). Only considers lines matching `alias NAME='...'` (or double quotes); any other line is ignored.
 */
export function parseToolAliases(text: string, home: string, tool: Provider): ClaudeAlias[] {
  const target = ALIAS_TOOLS[tool];
  if (!target) return [];
  const { invokes, dir: dirRe } = target;
  const out: ClaudeAlias[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = ALIAS_RE.exec(line);
    if (!m) continue;
    const body = m[2] ?? m[3]?.replace(/\\(.)/g, '$1') ?? '';
    if (!invokes.test(body)) continue;
    const dir = dirRe.exec(body);
    const raw = dir ? (dir[1] ?? dir[2] ?? dir[3]) : undefined;
    out.push(raw ? { name: m[1], configDir: expandHome(raw, home) } : { name: m[1] });
  }
  return out;
}

/** Aliases de shell que invocam o `claude` (ver parseToolAliases). */
export function parseClaudeAliases(text: string, home: string): ClaudeAlias[] {
  return parseToolAliases(text, home, 'claude');
}

/** Reads tool aliases (default: `claude`) from user's shell startup files. */
export function readShellAliases(home: string, tool: Provider = 'claude'): ClaudeAlias[] {
  const out: ClaudeAlias[] = [];
  for (const f of RC_FILES) {
    try {
      out.push(...parseToolAliases(readFileSync(join(home, f), 'utf8'), home, tool));
    } catch {
      // non-existent/unreadable file
    }
  }
  return out;
}

/**
 * Determines account badge: shortest alias (up to 3 characters); ties broken by first declared. Alias without
 * folder belongs to default account (`defaultDir`; default $HOME/.claude).
 */
export function shortcutsByDir(aliases: ClaudeAlias[], home: string, defaultDir: string = resolve(home, '.claude')): Map<string, string> {
  const best = new Map<string, string>();
  for (const a of aliases) {
    if (a.name.length > 3) continue;
    const dir = a.configDir ?? defaultDir;
    const cur = best.get(dir);
    if (cur === undefined || a.name.length < cur.length) best.set(dir, a.name);
  }
  return new Map([...best].map(([dir, name]) => [dir, name.toUpperCase()]));
}

interface GlobalConfigInfo {
  email?: string;
  organization?: string;
  cachedUsage?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Organization name worthy of display. Personal accounts receive automatically generated names
 * ("<email>'s Organization"), which are uninformative: excluded.
 */
export function meaningfulOrganization(organization: string | undefined, email: string | undefined): string | undefined {
  if (!organization) return undefined;
  const generic = /^(.+?)['’]s organi[sz]ation$/i.exec(organization.trim());
  if (generic && (!email || generic[1].trim().toLowerCase() === email.trim().toLowerCase() || generic[1].includes('@'))) return undefined;
  return organization;
}

/**
 * Reads from global Claude Code config ($HOME/.claude.json for default account, <dir>/.claude.json
 * for others) only account identity and usage cache.
 */
export function readGlobalConfig(dir: string, home: string): GlobalConfigInfo {
  const candidates = isDefaultDir(dir, home) ? [join(home, '.claude.json'), join(dir, '.claude.json')] : [join(dir, '.claude.json')];
  let fallback: GlobalConfigInfo | undefined;
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      const profile = j.oauthAccount && typeof j.oauthAccount === 'object' ? (j.oauthAccount as Record<string, unknown>) : undefined;
      const cache = j.cachedUsageUtilization && typeof j.cachedUsageUtilization === 'object' ? j.cachedUsageUtilization : undefined;
      const email = str(profile?.emailAddress);
      const info: GlobalConfigInfo = {
        email,
        organization: meaningfulOrganization(str(profile?.organizationName), email),
        cachedUsage: cache,
      };
      if (profile) return info;
      fallback ??= info;
    } catch {
      // invalid JSON (mid-write?): try next candidate
    }
  }
  return fallback ?? {};
}

function matchOverride(overrides: AccountOverride[], id: string, dir: string, home: string): AccountOverride | undefined {
  const norm = (p: unknown) => (typeof p === 'string' && p.trim() ? expandHome(p, home) : undefined);
  return (
    overrides.find((o) => o.id === id) ??
    overrides.find((o) => norm(o.mountDir) === dir) ??
    overrides.find((o) => norm(o.configDir) === dir)
  );
}

/** Account IDs (directory basename), disambiguated if two directories share the same name. */
export function accountIds(dirs: string[]): string[] {
  const seen = new Map<string, number>();
  return dirs.map((d) => {
    const base = basename(d) || d;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}~${n}`;
  });
}

/**
 * One account per config dir, IN IDENTICAL ORDER as `dirs`.
 * `configDir` is display path (in Docker, host path from HABBLAUD_ACCOUNTS).
 */
export function detectAccounts(dirs: string[], opts: { home?: string; env?: NodeJS.ProcessEnv } = {}): DetectedAccount[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? (env.HOME || homedir());
  const overrides = claudeOverrides(env.HABBLAUD_ACCOUNTS);
  const shortcuts = shortcutsByDir(readShellAliases(home), home);
  const ids = accountIds(dirs);

  const partial = dirs.map((dir, i) => {
    const id = ids[i];
    const ov = matchOverride(overrides, id, resolve(dir), home);
    const cfg = readGlobalConfig(dir, home);
    return { dir, id, ov, cfg, short: str(ov?.short)?.slice(0, 3) ?? shortcuts.get(resolve(dir)) };
  });

  // Accounts without detected badge receive A, B, C... (avoiding collision with used badges).
  const used = new Set(partial.map((p) => p.short).filter((s): s is string => !!s));
  let next = 0;
  const fallbackShort = () => {
    for (; next < 26; next++) {
      const letter = String.fromCharCode(65 + next);
      if (!used.has(letter)) {
        used.add(letter);
        return letter;
      }
    }
    return '?';
  };

  return partial.map((p, i) => {
    const short = p.short ?? fallbackShort();
    const acc: DetectedAccount = {
      id: p.id,
      configDir: str(p.ov?.configDir) ?? p.dir,
      short,
      name: str(p.ov?.name) ?? tr('Conta {0}', [short]),
      color: str(p.ov?.color) ?? ACCOUNT_COLORS[i % ACCOUNT_COLORS.length],
    };
    const email = str(p.ov?.email) ?? p.cfg.email;
    const organization = meaningfulOrganization(str(p.ov?.organization) ?? p.cfg.organization, email);
    const plan = str(p.ov?.plan);
    const cachedUsage = p.ov?.cachedUsage ?? p.cfg.cachedUsage;
    if (email) acc.email = email;
    if (organization) acc.organization = organization;
    if (plan) acc.plan = plan;
    if (cachedUsage !== undefined) acc.cachedUsage = cachedUsage;
    return acc;
  });
}
