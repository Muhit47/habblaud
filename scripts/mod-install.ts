// Installs (or uninstalls) Habblaud mod in Claude Code across accounts. Runs on the HOST with tsx:
//
//   npm run mod:install      # marketplace "habblaud" (this folder) + plugins habblaud, habblaud-permissoes and
//                            # habblaud-mensagens
//   npm run mod:uninstall    # uninstalls all three plugins and marketplace from each account
//   npm run mod:status       # per account: marketplace, plugins (and versions), and legacy remnants
//   (options: --sem-permissoes, --sem-mensagens, --conta <folder>, --dry-run, --claude <cmd>)
//
// All operations invoke the official Claude Code CLI (`claude plugin ...`), executed once per account with
// that account's CLAUDE_CONFIG_DIR, matching shell aliases (`alias d='CLAUDE_CONFIG_DIR=... claude'`). This ensures
// registrations (enabledPlugins and extraKnownMarketplaces in settings.json, <account>/plugins/*.json) are written
// by Claude Code in its native schema: this script never directly mutates those entries.
//
// The marketplace is THIS folder (.claude-plugin/marketplace.json at repo root), registered as local directory:
// Claude Code loads plugins in place from mod/, without copying. Following `git pull`, new sessions
// (or /reload-plugins) execute latest code immediately; `claude plugin update` synchronizes registered version (performed
// automatically by `npm run docker:up` for existing installs).
//
// Office messaging (habblaud-mensagens, plugin typing into sessions on user's behalf): included by default;
// omitted via --sem-mensagens, and an existing installation persists (mirrors permissions hook with --sem-permissoes).
// docker:up never auto-installs it: accounts with mod lacking messaging receive a recommendation to run mod:install.
//
// Legacy migration: mod records usage in same file as statusline tap (usage:install), and permissions plugin
// replaces settings hook PermissionRequest (hooks:install). During installation, each is removed from account
// settings.json (with backup) via legacy uninstaller functions, preventing dual usage captures or duplicate
// permission handlers. With --sem-permissoes, legacy hook is preserved.
//
// Legacy naming (CodeTown up to 0.3.2): install removes plugins codetown and codetown-permissoes and marketplace
// codetown (this same folder under old manifest name) BEFORE registering habblaud, and migrates
// ~/.codetown to ~/.habblaud. Uninstall also removes them, status reports them, and docker:up issues a warning.
//
// Status (and account plan): derived from `claude plugin list --json` and `claude plugin marketplace list --json`,
// documented interfaces handling scope, enabled/disabled state, and CLAUDE_CODE_PLUGIN_CACHE_DIR. The files
// <account>/plugins/installed_plugins.json and known_marketplaces.json are internal to Claude Code and subject to
// schema alterations (the former is already on schema v2).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverClaudeDirs, expandHome, isDefaultDir } from '../server/accounts/detect';
import { LEGACY_NAME } from '../server/legacy';
import { DEFAULT_PORT, installedHook, planUninstall as planHookUninstall } from './hooks-install';
import {
  formatAge,
  isTapCommand,
  migrateLegacyState,
  planUninstall as planTapUninstall,
  readSettings,
  tildify,
  usageDirOf,
  writeSettings,
  type Settings,
} from './statusline-install';
import { tr } from '../shared/i18n';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Marketplace name in .claude-plugin/marketplace.json (contract with mod/). */
export const MARKETPLACE = 'habblaud';
/** Habblaud mod: plan usage, terminal "needs you" indicator, and /habblaud command. */
export const MOD_PLUGIN = `habblaud@${MARKETPLACE}`;
/** PermissionRequest settings hook to answer prompts from office, packaged as a plugin. */
export const PERMISSIONS_PLUGIN = `habblaud-permissoes@${MARKETPLACE}`;
/** Office messaging: delivers messages typed in Habblaud into session on user's behalf. */
export const MESSAGES_PLUGIN = `habblaud-mensagens@${MARKETPLACE}`;
/** Habblaud plugins in output display order (status, uninstall, update). */
export const PLUGINS = [MOD_PLUGIN, PERMISSIONS_PLUGIN, MESSAGES_PLUGIN] as const;
/** Legacy marketplace name (CodeTown, up to 0.3.2): same directory registered under old name. */
export const LEGACY_MARKETPLACE = LEGACY_NAME;
/** Legacy plugins from old marketplace (mod and permissions under legacy names). */
export const LEGACY_PLUGINS = [`${LEGACY_NAME}@${LEGACY_MARKETPLACE}`, `${LEGACY_NAME}-permissoes@${LEGACY_MARKETPLACE}`] as const;
/** Minimum Claude Code terminal version that supports mods. */
export const MIN_CLAUDE_VERSION = '2.1.287';
/** Plugins are installed to user scope: active across all projects under the account. */
const SCOPE = 'user';
/** CLI call timeout ceiling (directory add/update operations complete in seconds). */
const CLI_TIMEOUT_MS = 120_000;

const USAGE = tr('Uso: npm run mod:<install|uninstall|status> [-- opções]\n\n  install     instala o mod do Habblaud no Claude Code de cada conta (marketplace desta pasta + plugins)\n              e tira o que ele substitui: o tap de statusline e o hook de permissão antigos e o mod do\n              nome antigo (codetown)\n  uninstall   tira os plugins e o marketplace do Habblaud de cada conta (e os do nome antigo, se sobraram)\n  status      mostra, por conta, o marketplace, os plugins (e versões) e o que sobrou do jeito antigo\n\nOpções:\n  --sem-permissoes   não instala o plugin de responder permissões pelo escritório (e mantém o hook antigo)\n  --sem-mensagens    não instala o plugin de mandar mensagens pelo escritório (um já instalado continua)\n  --conta <pasta>    só esta conta (ex.: --conta ~/.claude-conta2); pode repetir\n  --dry-run          mostra o que faria, sem instalar nem gravar nada\n  --claude <cmd>     comando do Claude Code (padrão: claude, do PATH)\n  -h, --help         mostra esta ajuda\n\nPrecisa do Claude Code {0} ou mais novo. Em versões anteriores, use o jeito antigo:\nnpm run usage:install (uso ao vivo) e npm run hooks:install (responder permissões); mandar mensagens pelo\nescritório só existe com o mod.\n\nContas: as mesmas do servidor (~/.claude* com projects/ ou sessions/, CLAUDE_CONFIG_DIR ou\nHABBLAUD_CLAUDE_DIRS). Uso capturado em HABBLAUD_USAGE_DIR (padrão ~/.habblaud/usage).', [MIN_CLAUDE_VERSION]);

// ---------------------------------------------------------------------------------------------
// Claude Code CLI runner (injectable: test suites mock this interface)
// ---------------------------------------------------------------------------------------------

export interface ClaudeResult {
  /** Exit code (null if execution failed to start or process was killed). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Process spawn failure (e.g. `claude` not found in PATH). */
  error?: string;
}

/** Runs `claude <args>` with provided environment (includes account CLAUDE_CONFIG_DIR). */
export type ClaudeRunner = (args: string[], env: NodeJS.ProcessEnv) => ClaudeResult;

/** Concrete runner implementation. Closed stdin: prevents hanging on interactive terminal prompts. */
export function makeClaudeRunner(cmd = 'claude'): ClaudeRunner {
  return (args, env) => {
    const r = spawnSync(cmd, args, { env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.error) {
      const code = (r.error as NodeJS.ErrnoException).code;
      const error = code === 'ENOENT' ? tr('o comando "{0}" não foi encontrado no PATH', [cmd]) : code === 'ETIMEDOUT' ? tr('"{0} {1}" não terminou em {2} s', [cmd, args.join(' '), CLI_TIMEOUT_MS / 1000]) : r.error.message;
      return { code: null, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error };
    }
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

/**
 * CLI environment for an account. Default account (~/.claude) runs WITHOUT CLAUDE_CONFIG_DIR, matching bare `claude`:
 * pointing variable to ~/.claude causes Claude Code to search ~/.claude/.claude.json instead of
 * ~/.claude.json. Inherited environment variables (e.g. running inside another account's session) never leak.
 */
export function accountEnv(env: NodeJS.ProcessEnv, dir: string, home: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (isDefaultDir(dir, home)) delete out.CLAUDE_CONFIG_DIR;
  else out.CLAUDE_CONFIG_DIR = dir;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Pure functions (tested in server/test/mod-install.test.ts)
// ---------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

/** "2.1.293 (Claude Code)" → [2, 1, 293]. */
export function parseVersion(text: string): [number, number, number] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function versionAtLeast(version: string, min: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/** Strips terminal ANSI color codes. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

/**
 * Parses JSON from CLI output with tolerance: entire output, substring starting from first JSON opener
 * (preceding warnings ignored), or last line (action `--json` result format). Returns undefined on failure.
 */
export function parseJsonOutput(stdout: string): unknown {
  const text = stripAnsi(stdout).trim();
  if (!text) return undefined;
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return undefined;
    }
  };
  const whole = tryParse(text);
  if (whole !== undefined) return whole;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*[[{]/.test(l));
  if (start > 0) {
    const fromStart = tryParse(lines.slice(start).join('\n'));
    if (fromStart !== undefined) return fromStart;
  }
  return tryParse(lines[lines.length - 1]);
}

/** Plugin installation record as returned by `claude plugin list --json` (retained fields only). */
export interface PluginInfo {
  id: string;
  version?: string;
  scope?: string;
  enabled: boolean;
  /** Directory loaded from when read in place from local marketplace (Claude Code 2.1.289+). */
  readFromFolder?: string;
  /** Manifest version in that directory (may be newer than registered version). */
  folderVersion?: string;
  errors: string[];
}

/** Installed plugins list; accepts array or `--available` envelope ({installed: [...]}). */
export function parsePluginList(stdout: string): PluginInfo[] | undefined {
  const raw = parseJsonOutput(stdout);
  const list = Array.isArray(raw) ? raw : rec(raw) && Array.isArray(rec(raw)!.installed) ? (rec(raw)!.installed as unknown[]) : undefined;
  if (!list) return undefined;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const out: PluginInfo[] = [];
  for (const item of list) {
    const r = rec(item);
    const id = str(r?.id);
    if (!r || !id) continue;
    out.push({
      id,
      version: str(r.version),
      scope: str(r.scope),
      enabled: r.enabled !== false,
      readFromFolder: str(r.readFromFolder),
      folderVersion: str(r.folderVersion),
      errors: Array.isArray(r.errors) ? r.errors.filter((e): e is string => typeof e === 'string') : [],
    });
  }
  return out;
}

export interface MarketplaceInfo {
  name: string;
  source?: string;
  /** Path (local directory or file marketplaces). */
  path?: string;
}

export function parseMarketplaceList(stdout: string): MarketplaceInfo[] | undefined {
  const raw = parseJsonOutput(stdout);
  if (!Array.isArray(raw)) return undefined;
  const out: MarketplaceInfo[] = [];
  for (const item of raw) {
    const r = rec(item);
    if (!r || typeof r.name !== 'string') continue;
    const m: MarketplaceInfo = { name: r.name };
    if (typeof r.source === 'string') m.source = r.source;
    const path = typeof r.path === 'string' ? r.path : typeof r.installLocation === 'string' && r.source === 'directory' ? r.installLocation : undefined;
    if (path) m.path = path;
    out.push(m);
  }
  return out;
}

/** Installed Habblaud state for an account in Claude Code. */
export interface AccountState {
  marketplace?: MarketplaceInfo;
  /** Legacy marketplace (codetown) if still registered. */
  legacyMarketplace?: MarketplaceInfo;
  plugins: PluginInfo[];
}

/** Plugin installation of `id` in user scope (the only scope managed by this script). */
export function userInstall(state: AccountState, id: string): PluginInfo | undefined {
  return state.plugins.find((p) => p.id === id && (p.scope === SCOPE || p.scope === undefined));
}

/** Legacy plugins in user scope (where 0.3 mod:install placed them). */
export function legacyPlugins(state: AccountState): PluginInfo[] {
  return LEGACY_PLUGINS.map((id) => userInstall(state, id)).filter((p): p is PluginInfo => !!p);
}

/**
 * Legacy naming remnants in a phrase ("marketplace codetown, codetown@codetown 0.3.2"), or undefined if
 * none remain. `where` describes marketplace directory (status confirms whether it matches repo).
 */
export function legacySummary(state: AccountState, where?: (m: MarketplaceInfo) => string): string | undefined {
  const parts = legacyPlugins(state).map((p) => `${p.id}${p.version ? ` ${p.version}` : ''}`);
  const m = state.legacyMarketplace;
  if (m) parts.unshift(`marketplace ${LEGACY_MARKETPLACE}${where ? ` (${where(m)})` : ''}`);
  return parts.length ? parts.join(', ') : undefined;
}

/** CLI execution step with a descriptive progress summary. */
export interface CliStep {
  args: string[];
  /** "habblaud: installed" (displayed with ✓, ~ or ✗ in output). */
  message: string;
  /** Plugin depending on this step (failure marks plugin uninstalled). */
  plugin?: string;
  /** On failure, subsequent installation steps continue executing (failure recorded at end). */
  keepGoing?: boolean;
}

/** Plan item in execution order: CLI execution step or no-op state (displayed with "="). */
export type PlanItem = CliStep | { unchanged: string };

export interface InstallPlan {
  items: PlanItem[];
  /** Non-fatal advisory notices. */
  notes: string[];
  /** Plugins installed upon successful execution of all steps. */
  plugins: string[];
}

/** Extracts only CLI execution steps from an installation plan. */
export function cliSteps(plan: InstallPlan): CliStep[] {
  return plan.items.filter((i): i is CliStep => 'args' in i);
}

export interface PlanOptions {
  /** Repository root (contains .claude-plugin/marketplace.json). */
  root: string;
  /** package.json version (= plugin version). */
  version: string;
  /** Whether to install permissions plugin. */
  permissions: boolean;
  /** Whether to install messaging plugin. */
  messages: boolean;
  /** Directory comparison helper (default: resolved realpath). */
  sameDir?: (a: string, b: string) => boolean;
}

/** Checks if paths refer to same folder, resolving symlinks when available. */
export function sameDir(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
}

const shortName = (id: string) => id.split('@')[0];

/**
 * Steps to remove legacy naming remnants: user scope plugins first, then marketplace. A plugin
 * removal failure does not block subsequent steps: removing marketplace prunes its plugins.
 */
function legacySteps(state: AccountState): CliStep[] {
  const steps: CliStep[] = legacyPlugins(state).map((p) => ({
    args: ['plugin', 'uninstall', p.id, '--scope', SCOPE],
    message: tr('{0} (nome antigo): removido', [shortName(p.id)]),
    keepGoing: true,
  }));
  if (state.legacyMarketplace) {
    steps.push({ args: ['plugin', 'marketplace', 'remove', LEGACY_MARKETPLACE], message: tr('marketplace {0} (nome antigo): removido', [LEGACY_MARKETPLACE]) });
  }
  return steps;
}

/**
 * Installation plan for an account based on current state. Legacy remnants are pruned first. The
 * marketplace is added (or updated if catalog already present; if pointing to another directory, repointed
 * here). Each plugin is installed, re-enabled (if disabled), or updated (if registered version differs
 * from package.json).
 */
export function planInstall(state: AccountState, o: PlanOptions): InstallPlan {
  const same = o.sameDir ?? sameDir;
  const plan: InstallPlan = { items: [], notes: [], plugins: [] };
  // Legacy marketplace codetown points to this directory: removed before registering habblaud to prevent
  // duplicate registrations for the same folder (one carrying an obsolete manifest name).
  plan.items.push(...legacySteps(state));
  const m = state.marketplace;
  if (!m) {
    plan.items.push({ args: ['plugin', 'marketplace', 'add', o.root], message: tr('marketplace {0}: adicionado (esta pasta)', [MARKETPLACE]) });
  } else if (m.path && same(m.path, o.root)) {
    plan.items.push({ args: ['plugin', 'marketplace', 'update', MARKETPLACE], message: tr('marketplace {0}: catálogo relido desta pasta', [MARKETPLACE]) });
  } else {
    // Different folder (moved repository) or source: adding with same name updates source location while
    // preserving installed plugins.
    plan.items.push({
      args: ['plugin', 'marketplace', 'add', o.root],
      message: tr('marketplace {0}: passou a apontar para esta pasta (antes: {1})', [MARKETPLACE, m.path ?? m.source ?? tr('outra origem')]),
    });
  }
  const wanted = [MOD_PLUGIN, ...(o.permissions ? [PERMISSIONS_PLUGIN] : []), ...(o.messages ? [MESSAGES_PLUGIN] : [])];
  for (const id of wanted) {
    const name = shortName(id);
    const cur = userInstall(state, id);
    if (!cur) {
      plan.items.push({ args: ['plugin', 'install', id, '--scope', SCOPE], message: tr('{0}: instalado', [name]), plugin: id });
      plan.plugins.push(id);
      continue;
    }
    plan.plugins.push(id);
    let touched = false;
    if (!cur.enabled) {
      plan.items.push({ args: ['plugin', 'enable', id, '--scope', SCOPE], message: tr('{0}: religado (estava desligado)', [name]), plugin: id });
      touched = true;
    }
    if (cur.version !== o.version) {
      plan.items.push({ args: ['plugin', 'update', id, '--scope', SCOPE], message: tr('{0}: atualizado de {1} para {2}', [name, cur.version ?? '?', o.version]), plugin: id });
      touched = true;
    }
    if (!touched) plan.items.push({ unchanged: tr('{0}: já instalado na versão {1}', [name, o.version]) });
  }
  // With --sem-permissoes (or --sem-mensagens), existing plugin install is preserved (and updated to match mod version).
  const left: Array<[id: string, flag: string]> = [];
  if (!o.permissions) left.push([PERMISSIONS_PLUGIN, '--sem-permissoes']);
  if (!o.messages) left.push([MESSAGES_PLUGIN, '--sem-mensagens']);
  for (const [id, flag] of left) {
    const cur = userInstall(state, id);
    if (!cur) continue;
    if (cur.version !== o.version) {
      plan.items.push({ args: ['plugin', 'update', id, '--scope', SCOPE], message: tr('{0}: atualizado de {1} para {2}', [shortName(id), cur.version ?? '?', o.version]), plugin: id });
    }
    plan.plugins.push(id);
    plan.notes.push(tr('{0} já estava instalado e continua ({1} não o remove; para tirar: claude plugin uninstall {2})', [shortName(id), flag, id]));
  }
  return plan;
}

/**
 * Uninstallation steps: legacy remnants (if any), user-scope plugins, and marketplace, for installed items
 * only. (Removing marketplace implicitly removes child plugins, but explicit plugin steps produce clear output.)
 */
export function planUninstall(state: AccountState): InstallPlan {
  const plan: InstallPlan = { items: [...legacySteps(state)], notes: [], plugins: [] };
  for (const id of PLUGINS) {
    const name = shortName(id);
    if (userInstall(state, id)) plan.items.push({ args: ['plugin', 'uninstall', id, '--scope', SCOPE], message: tr('{0}: removido', [name]), plugin: id });
    else plan.items.push({ unchanged: tr('{0}: não estava instalado', [name]) });
  }
  if (state.marketplace) plan.items.push({ args: ['plugin', 'marketplace', 'remove', MARKETPLACE], message: tr('marketplace {0}: removido', [MARKETPLACE]) });
  else plan.items.push({ unchanged: tr('marketplace {0}: não estava adicionado', [MARKETPLACE]) });
  return plan;
}

export interface MigrationPlan {
  /** Updated settings.json if modified. */
  settings?: Settings;
  /** Removed items (displayed with ✓). */
  done: string[];
  /** Preserved items and reasoning (displayed with "="). */
  kept: string[];
  /** Unknown structures that cannot be safely edited (displayed with "!"). */
  warnings: string[];
}

/**
 * Cleans up replaced hooks from settings.json: statusline tap (if mod remained installed) and legacy
 * permission hook (if permissions plugin remained installed). Performs single write and single backup.
 */
export function planMigration(settings: Settings, o: { modInstalled: boolean; permissionsInstalled: boolean; permissions: boolean }): MigrationPlan {
  const out: MigrationPlan = { done: [], kept: [], warnings: [] };
  let next = settings;
  const sl = rec(settings.statusLine);
  if (sl && isTapCommand(sl.command)) {
    if (!o.modInstalled) out.kept.push(tr('tap de statusline antigo mantido (o mod não ficou instalado)'));
    else {
      const p = planTapUninstall(next);
      if (p.action === 'uninstall') {
        next = p.settings;
        out.done.push(tr('tap de statusline antigo removido: o mod grava o uso no lugar dele ({0})', [p.message]));
      } else if (p.action === 'skip') out.warnings.push(tr('tap de statusline antigo: {0} (rode npm run usage:uninstall depois de conferir)', [p.message]));
    }
  }
  if (installedHook(next)) {
    if (!o.permissions) out.kept.push(tr('hook de permissão antigo mantido (--sem-permissoes)'));
    else if (!o.permissionsInstalled) out.kept.push(tr('hook de permissão antigo mantido (o plugin de permissões não ficou instalado)'));
    else {
      const p = planHookUninstall(next);
      if (p.action === 'uninstall') {
        next = p.settings;
        out.done.push(tr('hook de permissão antigo removido: o plugin {0} responde no lugar dele', [shortName(PERMISSIONS_PLUGIN)]));
      } else if (p.action === 'skip') out.warnings.push(tr('hook de permissão antigo: {0} (rode npm run hooks:uninstall depois de conferir)', [p.message]));
    }
  }
  if (next !== settings) out.settings = next;
  return out;
}

/** Discrepancies between expected installation state and Claude Code reported state post-execution. */
export function verifyInstall(after: AccountState, plugins: string[], version: string): string[] {
  const out: string[] = [];
  for (const id of plugins) {
    const p = userInstall(after, id);
    const name = shortName(id);
    if (!p) out.push(tr('{0}: não aparece instalado na lista do Claude Code', [name]));
    else if (!p.enabled) out.push(tr('{0}: instalado, mas desligado (claude plugin enable {1})', [name, id]));
    else if (p.version !== version) out.push(tr('{0}: o Claude Code registra a versão {1}, não a {2} (o manifesto em mod/ está com outra versão?)', [name, p.version ?? '?', version]));
    if (p?.errors.length) out.push(`${name}: ${p.errors.join('; ')}`);
  }
  return out;
}

/**
 * For docker:up: updates only currently installed plugins, never installs fresh. `hint` advises accounts
 * with mod installed that lack messaging plugin (added later): docker:up never auto-installs it.
 */
export type UpdatePlan =
  | { action: 'none'; installed: boolean; hint?: string }
  | { action: 'update'; steps: CliStep[]; hint?: string }
  | { action: 'warn'; message: string };

/** Messaging plugin advice when account has mod installed without messaging plugin. */
export const MESSAGES_HINT = tr('rode npm run mod:install para mandar mensagens pelo escritório (plugin {0})', [shortName(MESSAGES_PLUGIN)]);

export function planUpdate(state: AccountState, o: { root: string; version: string; sameDir?: (a: string, b: string) => boolean }): UpdatePlan {
  const same = o.sameDir ?? sameDir;
  // Legacy name: replacement (removing codetown, installing habblaud) belongs to mod:install; here only a notice.
  // Warning counts as "installed", suppressing fresh install tip for previous mod users.
  const legacy = legacySummary(state);
  if (legacy) return { action: 'warn', message: tr('ainda com o nome antigo ({0}); o docker:up não troca sozinho: rode npm run mod:install', [legacy]) };
  const installed = PLUGINS.map((id) => userInstall(state, id)).filter((p): p is PluginInfo => !!p);
  if (!installed.length) return { action: 'none', installed: false };
  const hint = userInstall(state, MOD_PLUGIN) && !userInstall(state, MESSAGES_PLUGIN) ? { hint: MESSAGES_HINT } : {};
  const stale = installed.filter((p) => p.version !== o.version);
  if (!stale.length) return { action: 'none', installed: true, ...hint };
  // Marketplace pointing to different directory (other clone or moved folder): updating would not bring this version.
  const m = state.marketplace;
  if (!m) return { action: 'warn', message: tr('o mod está instalado, mas o marketplace {0} sumiu; rode npm run mod:install', [MARKETPLACE]) };
  if (!m.path || !same(m.path, o.root)) {
    return { action: 'warn', message: tr('o mod vem de outra pasta ({0}), então não foi atualizado; para usar esta: npm run mod:install', [m.path ?? m.source ?? '?']) };
  }
  return {
    action: 'update',
    steps: [
      { args: ['plugin', 'marketplace', 'update', MARKETPLACE], message: tr('marketplace {0}: catálogo relido', [MARKETPLACE]) },
      ...stale.map((p) => ({ args: ['plugin', 'update', p.id, '--scope', SCOPE], message: `${shortName(p.id)}: ${p.version ?? '?'} → ${o.version}`, plugin: p.id })),
    ],
    ...hint,
  };
}

/** Extracts trailing useful lines from CLI stderr/stdout to describe failures. */
export function cliMessage(r: ClaudeResult): string {
  if (r.error) return r.error;
  const lines = stripAnsi(`${r.stdout}\n${r.stderr}`)
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s✘✔✗✓×]+/, '').trim())
    .filter(Boolean);
  return lines.slice(-2).join(' · ') || tr('saiu com código {0}', [r.code ?? '?']);
}

/** Account status output lines (excluding account header). */
export function describeStatus(state: AccountState, settings: Settings, o: { root: string; version: string; home: string; sameDir?: (a: string, b: string) => boolean }): string[] {
  const same = o.sameDir ?? sameDir;
  const lines: string[] = [];
  const m = state.marketplace;
  if (!m) lines.push(tr('marketplace {0}: não adicionado', [MARKETPLACE]));
  else if (m.path && same(m.path, o.root)) lines.push(tr('marketplace {0}: esta pasta', [MARKETPLACE]));
  else lines.push(tr('marketplace {0}: outra origem ({1}); npm run mod:install aponta para esta pasta', [MARKETPLACE, m.path ? tildify(m.path, o.home) : (m.source ?? '?')]));
  for (const id of PLUGINS) {
    const name = shortName(id);
    const all = state.plugins.filter((p) => p.id === id);
    if (!all.length) {
      lines.push(tr('{0}: não instalado', [name]));
      continue;
    }
    for (const p of all) {
      const parts = [tr('instalado{0}', [p.scope && p.scope !== SCOPE ? tr(' (escopo {0})', [p.scope]) : '']), p.enabled ? tr('ligado') : tr('desligado')];
      parts.push(tr('versão {0}{1}', [p.version ?? '?', p.version === o.version ? '' : tr(' (esta pasta: {0}; npm run mod:install ou npm run docker:up atualiza)', [o.version])]));
      if (p.folderVersion && p.folderVersion !== p.version) parts.push(tr('carrega {0} de {1}', [p.folderVersion, tildify(p.readFromFolder ?? '?', o.home)]));
      if (p.errors.length) parts.push(`erro: ${p.errors.join('; ')}`);
      lines.push(`${name}: ${parts.join(', ')}`);
    }
  }
  const legacy = legacySummary(state, (lm) => (lm.path && same(lm.path, o.root) ? tr('esta pasta') : lm.path ? tildify(lm.path, o.home) : (lm.source ?? '?')));
  if (legacy) lines.push(tr('! nome antigo ainda registrado: {0}; npm run mod:install troca pelo habblaud', [legacy]));
  const sl = rec(settings.statusLine);
  const hook = installedHook(settings);
  const modOn = !!userInstall(state, MOD_PLUGIN);
  const permOn = !!userInstall(state, PERMISSIONS_PLUGIN);
  if (sl && isTapCommand(sl.command)) {
    lines.push(
      modOn
        ? tr('! tap de statusline antigo ainda instalado junto com o mod: npm run mod:install tira (ou npm run usage:uninstall)')
        : tr('tap de statusline antigo instalado (jeito antigo; o mod o substitui)'),
    );
  }
  if (hook) {
    lines.push(
      permOn
        ? tr('! hook de permissão antigo ainda no settings.json junto com o plugin: os dois respondem; npm run mod:install tira (ou npm run hooks:uninstall)')
        : tr('hook de permissão antigo instalado (jeito antigo; o plugin de permissões o substitui)'),
    );
  }
  if (settings.disableAllHooks === true) lines.push(tr('! disableAllHooks está ligado no settings.json desta conta: nenhum mod (nem hook) roda'));
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Effects (Claude Code CLI and settings.json)
// ---------------------------------------------------------------------------------------------

export interface RunOptions {
  command: 'install' | 'uninstall' | 'status';
  dryRun: boolean;
  /** false with --sem-permissoes. */
  permissions: boolean;
  /** false with --sem-mensagens. */
  messages: boolean;
  /** --conta filter (empty = all detected). */
  accounts: string[];
  claudeCmd?: string;
}

export interface RunContext {
  env: NodeJS.ProcessEnv;
  home: string;
  now: Date;
  /** Repository root (marketplace directory). */
  root: string;
  /** package.json version string. */
  version: string;
  claude: ClaudeRunner;
  out: (line: string) => void;
  /** Queries Habblaud /api/health for status command (test suites inject mock). */
  health?: (port: number) => Promise<HealthInfo | undefined>;
}

/** Fields used from /api/health by status (`messages` present on Habblaud instances with office messaging). */
export interface HealthInfo {
  permissions?: boolean;
  messages?: boolean;
}

class FatalError extends Error {}

async function fetchHealth(port: number): Promise<HealthInfo | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_500) });
    if (!res.ok) return undefined;
    return (await res.json()) as HealthInfo;
  } catch {
    return undefined;
  }
}

/** Habblaud port (HABBLAUD_PORT or default). */
function habblaudPort(env: NodeJS.ProcessEnv): number {
  const p = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  return Number.isInteger(p) && p > 0 && p < 65_536 ? p : DEFAULT_PORT;
}

export function parseArgs(argv: string[]): RunOptions | 'help' {
  let command: RunOptions['command'] | undefined;
  let dryRun = false;
  let permissions = true;
  let messages = true;
  let claudeCmd: string | undefined;
  const accounts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--dry-run') dryRun = true;
    else if (a === '--sem-permissoes') permissions = false;
    else if (a === '--sem-mensagens') messages = false;
    else if (a === '--conta') {
      const dir = argv[++i];
      if (!dir) throw new FatalError(tr('--conta precisa da pasta da conta (ex.: --conta ~/.claude-conta2).'));
      accounts.push(dir);
    } else if (a === '--claude') {
      claudeCmd = argv[++i];
      if (!claudeCmd) throw new FatalError(tr('--claude precisa de um comando ou caminho.'));
    } else if ((a === 'install' || a === 'uninstall' || a === 'status') && !command) command = a;
    else throw new FatalError(tr('opção desconhecida: {0}\n\n{1}', [a, USAGE]));
  }
  if (!command) throw new FatalError(tr('diga o que fazer: install, uninstall ou status.\n\n{0}', [USAGE]));
  return { command, dryRun, permissions, messages, accounts, claudeCmd };
}

/** Extracts version from root package.json. */
export function readPackageVersion(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string' || !pkg.version) throw new FatalError(tr('package.json sem "version" em {0}', [root]));
  return pkg.version;
}

/** Reads marketplace and plugin status for account via CLI (or error message on failure). */
export function readAccountState(claude: ClaudeRunner, env: NodeJS.ProcessEnv): AccountState | { error: string } {
  const mr = claude(['plugin', 'marketplace', 'list', '--json'], env);
  if (mr.error || mr.code !== 0) return { error: tr('não consegui listar os marketplaces ({0})', [cliMessage(mr)]) };
  const markets = parseMarketplaceList(mr.stdout);
  if (!markets) return { error: tr('não entendi a lista de marketplaces do Claude Code') };
  const pr = claude(['plugin', 'list', '--json'], env);
  if (pr.error || pr.code !== 0) return { error: tr('não consegui listar os plugins ({0})', [cliMessage(pr)]) };
  const plugins = parsePluginList(pr.stdout);
  if (!plugins) return { error: tr('não entendi a lista de plugins do Claude Code') };
  return { marketplace: markets.find((m) => m.name === MARKETPLACE), legacyMarketplace: markets.find((m) => m.name === LEGACY_MARKETPLACE), plugins };
}

/** Account directories: --conta filters (must exist) or detected accounts. */
function accountDirs(opts: RunOptions, env: NodeJS.ProcessEnv, home: string): string[] {
  if (!opts.accounts.length) return discoverClaudeDirs(env, home);
  return [...new Set(opts.accounts.map((a) => expandHome(a, home)))].map((dir) => {
    let ok = false;
    try {
      ok = statSync(dir).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) throw new FatalError(tr('--conta {0}: pasta não encontrada.', [dir]));
    return dir;
  });
}

/** Age of last captured usage (via mod or tap) for an account, formatted for status output. */
function lastCapture(dir: string, env: NodeJS.ProcessEnv, home: string, now: Date): string {
  const file = join(usageDirOf(env, home), `${basename(dir)}.json`);
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Rec;
    const at = typeof j.fetchedAt === 'number' ? j.fetchedAt : statSync(file).mtimeMs;
    return tr('último uso capturado há {0} ({1})', [formatAge(now.getTime() - at), j.source === 'mod' ? tr('pelo mod') : tr('pelo tap de statusline')]);
  } catch {
    return tr('nenhum uso capturado ainda (chega depois da próxima resposta numa sessão aberta desta conta)');
  }
}

/** Executes command across all accounts. Returns exit code. */
export async function run(opts: RunOptions, ctx: RunContext): Promise<number> {
  const { env, home, out } = ctx;
  const dirs = accountDirs(opts, env, home);
  if (!dirs.length) {
    out(tr('Nenhuma conta do Claude Code encontrada (~/.claude* com projects/ ou sessions/). Use --conta <pasta> ou HABBLAUD_CLAUDE_DIRS.'));
    return 1;
  }
  const manifest = join(ctx.root, '.claude-plugin', 'marketplace.json');
  if (opts.command === 'install' && !existsSync(manifest)) {
    out(tr('Não achei {0}: esta pasta não tem o mod (versão antiga do Habblaud? rode git pull).', [tildify(manifest, home)]));
    return 1;
  }

  // Single binary: all accounts share the same executable, varying only CLAUDE_CONFIG_DIR.
  const vr = ctx.claude(['--version'], env);
  if (vr.error) {
    out(tr('Não consegui rodar o Claude Code: {0}.', [vr.error]));
    out(tr('Instale o Claude Code (https://code.claude.com) ou diga onde ele está: npm run mod:<comando> -- --claude <caminho>'));
    return 1;
  }
  const cliVersion = parseVersion(vr.stdout) ? parseVersion(vr.stdout)!.join('.') : undefined;
  if (opts.command === 'install') {
    if (!cliVersion) out(tr('! Não entendi a versão do Claude Code ("{0}"); sigo assim mesmo.', [cliMessage(vr)]));
    else if (!versionAtLeast(cliVersion, MIN_CLAUDE_VERSION)) {
      out(tr('O mod precisa do Claude Code {0} ou mais novo, e este é o {1}.', [MIN_CLAUDE_VERSION, cliVersion]));
      out(tr('Atualize o Claude Code (claude update) e rode de novo. Ou use o jeito antigo, que funciona em versões anteriores:'));
      out(tr('  npm run usage:install    # uso de 5h/semanal ao vivo (tap de statusline)'));
      out(tr('  npm run hooks:install    # responder pedidos de permissão pelo escritório'));
      return 1;
    }
  }
  if (opts.command === 'status') {
    out(tr('Claude Code {0}{1} · Habblaud {2} em {3}', [cliVersion ?? tr('(versão desconhecida)'), cliVersion && !versionAtLeast(cliVersion, MIN_CLAUDE_VERSION) ? tr(' — o mod precisa do {0}+', [MIN_CLAUDE_VERSION]) : '', ctx.version, tildify(ctx.root, home)]));
  }

  // Legacy name: ~/.codetown migrated to ~/.habblaud before creating or reading usage folder.
  if (opts.command === 'install') {
    const moved = migrateLegacyState(home, opts.dryRun);
    if (moved) out(moved);
  }
  // Mod records usage in ~/.habblaud/usage without creating folder (docker:up also mounts it into container).
  if (opts.command === 'install' && !opts.dryRun) {
    const usageDir = usageDirOf(env, home);
    try {
      if (!existsSync(usageDir)) {
        mkdirSync(usageDir, { recursive: true, mode: 0o700 });
        out(tr('✓ pasta do uso criada: {0}', [tildify(usageDir, home)]));
      }
    } catch (err) {
      out(tr('! não consegui criar {0} ({1}); o uso ao vivo não vai ser gravado', [tildify(usageDir, home), (err as Error).message]));
    }
  }

  let failures = 0;
  let changed = 0;
  for (const dir of dirs) {
    const label = `${basename(dir)} (${tildify(dir, home)})`;
    const cenv = accountEnv(env, dir, home);
    const state = readAccountState(ctx.claude, cenv);
    const file = join(dir, 'settings.json');
    if (opts.command === 'status') {
      out(`• ${label}`);
      const read = readSettings(file);
      const settings = 'error' in read ? {} : read.settings;
      if ('error' in read) out(tr('    ✗ settings.json: {0}', [read.error]));
      if ('error' in state) {
        out(`    ✗ ${state.error}`);
        failures++;
      } else for (const l of describeStatus(state, settings, { root: ctx.root, version: ctx.version, home })) out(`    ${l}`);
      out(`    ${lastCapture(dir, env, home, ctx.now)}`);
      continue;
    }

    out(`${label}:`);
    if ('error' in state) {
      out(`  ✗ ${state.error}`);
      failures++;
      continue;
    }
    const plan =
      opts.command === 'install' ? planInstall(state, { root: ctx.root, version: ctx.version, permissions: opts.permissions, messages: opts.messages }) : planUninstall(state);
    const failed = new Set<string>();
    let broken = false;
    let stepFailed = false;
    for (const item of plan.items) {
      if (!('args' in item)) {
        out(`  = ${item.unchanged}`);
        continue;
      }
      if (opts.dryRun) {
        out(tr('  ~ {0} (simulação: claude {1})', [item.message, item.args.join(' ')]));
        continue;
      }
      // On install, subsequent steps for account halt on failure (without marketplace plugins cannot install),
      // except legacy plugin uninstallation failures (marketplace removal prunes them). On uninstall, execution continues.
      if (broken && opts.command === 'install') {
        if (item.plugin) failed.add(item.plugin);
        continue;
      }
      const r = ctx.claude(item.args, cenv);
      if (!r.error && r.code === 0) {
        out(`  ✓ ${item.message}`);
        changed++;
      } else {
        out(tr('  ✗ {0}: falhou ({1})', [item.message.split(':')[0], cliMessage(r)]));
        if (item.plugin) failed.add(item.plugin);
        stepFailed = true;
        if (!item.keepGoing) broken = true;
      }
    }
    if (stepFailed) failures++;
    for (const n of plan.notes) out(`  ! ${n}`);
    if (opts.command !== 'install') continue;

    // Verifies with Claude Code what remained installed (no-op update also returns 0) and computes migration accordingly.
    // In dry-run mode (or if listing fails), expected plan minus failed steps is used.
    let ok = (id: string) => plan.plugins.includes(id) && !failed.has(id);
    if (!opts.dryRun) {
      const after = readAccountState(ctx.claude, cenv);
      if (!('error' in after)) {
        for (const w of verifyInstall(after, plan.plugins, ctx.version)) out(`  ! ${w}`);
        const legacy = legacySummary(after);
        if (legacy) out(tr('  ! nome antigo ainda registrado: {0}; rode npm run mod:install de novo (ou confira com npm run mod:status)', [legacy]));
        ok = (id: string) => userInstall(after, id)?.enabled === true;
      }
    }

    // Migration: reads settings.json AFTER CLI execution (CLI also updates enabledPlugins, marketplaces).
    const read = readSettings(file);
    if ('error' in read) {
      out(tr('  ✗ settings.json: {0}; o tap e o hook antigos não foram conferidos', [read.error]));
      failures++;
      continue;
    }
    const mig = planMigration(read.settings, { modInstalled: ok(MOD_PLUGIN), permissionsInstalled: ok(PERMISSIONS_PLUGIN), permissions: opts.permissions });
    for (const k of mig.kept) out(`  = ${k}`);
    for (const w of mig.warnings) out(`  ! ${w}`);
    if (read.settings.disableAllHooks === true) out(tr('  ! disableAllHooks está ligado no settings.json desta conta: o mod não roda até você desligar'));
    if (!mig.settings) continue;
    if (opts.dryRun) {
      for (const d of mig.done) out(tr('  ~ {0} (simulação: nada gravado)', [d]));
      continue;
    }
    try {
      const backup = writeSettings(file, mig.settings, read.raw, ctx.now);
      for (const d of mig.done) out(`  ✓ ${d}`);
      if (backup) out(tr('    backup do settings.json em {0}', [tildify(backup, home)]));
      changed++;
    } catch (err) {
      out(tr('  ✗ não consegui gravar o settings.json ({0}); o tap e o hook antigos continuam', [(err as Error).message]));
      failures++;
    }
  }

  if (opts.command === 'install' && !opts.dryRun && !failures) {
    out('');
    out(tr('Pronto. Sessões novas do Claude Code já carregam o mod; nas que já estão abertas, rode /reload-plugins (ou'));
    out(tr('reabra a sessão). O uso de 5h/semanal chega ao Habblaud depois da próxima resposta de cada sessão.'));
    out(tr('Para conferir: npm run mod:status · Para desfazer: npm run mod:uninstall'));
  }
  if (opts.command === 'uninstall' && !opts.dryRun && changed) {
    out('');
    out(tr('Pronto. Sessões já abertas continuam com o mod até /reload-plugins (ou até reabrir a sessão).'));
    out(tr('Para voltar ao jeito antigo (Claude Code anterior ao 2.1.287): npm run usage:install e npm run hooks:install'));
  }
  if (opts.command === 'status') {
    // Mod and plugins communicate only with local Habblaud: checks whether instance is online.
    const port = habblaudPort(env);
    const health = await (ctx.health ?? fetchHealth)(port);
    const at = tr('Habblaud em http://127.0.0.1:{0}', [port]);
    if (!health) out(tr('{0}: fora do ar (o mod segue gravando o uso; os pedidos de permissão ficam só no terminal).', [at]));
    else if (health.permissions) out(tr('{0}: no ar e respondendo pedidos de permissão (com alguma página aberta).', [at]));
    else out(tr('{0}: no ar, mas responder pelo escritório está desligado (porta exposta na rede ou HABBLAUD_TERMINAL=0).', [at]));
    // Legacy Habblaud instances prior to messaging feature omit messaging status.
    if (health && typeof health.messages === 'boolean') {
      out(
        health.messages
          ? tr('Mensagens pelo escritório: ligadas (chegam às sessões abertas com o plugin {0}).', [shortName(MESSAGES_PLUGIN)])
          : tr('Mensagens pelo escritório: desligadas no Habblaud (porta exposta na rede, HABBLAUD_TERMINAL=0 ou HABBLAUD_MENSAGENS=0).'),
      );
    }
  }
  return failures ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// For docker:up: updates mod for existing installations
// ---------------------------------------------------------------------------------------------

export interface ModUpdateContext {
  env: NodeJS.ProcessEnv;
  home: string;
  root: string;
  version: string;
  claude: ClaudeRunner;
}

export interface ModUpdateResult {
  /** True if any account has mod (or companion plugin) installed, even under legacy naming. */
  installed: boolean;
  /** Failed to invoke Claude Code CLI across all accounts (e.g. `claude` not found in PATH). */
  unavailable: boolean;
  lines: Array<{ level: 'info' | 'warn'; text: string }>;
}

/**
 * For each account with mod installed on a version differing from package.json: updates catalog and refreshes
 * installed plugins. With legacy naming remnants, logs warning (migration belongs to mod:install). With mod
 * lacking messaging plugin, provides advisory tip. Never installs from scratch and never throws: failures become warnings.
 */
export function updateInstalledMods(accounts: Array<{ dir: string; label: string }>, ctx: ModUpdateContext): ModUpdateResult {
  const res: ModUpdateResult = { installed: false, unavailable: false, lines: [] };
  if (!accounts.length) return res;
  // Safe runner that never throws: exceptions are converted to failure results (docker:up must not abort).
  const claude: ClaudeRunner = (args, env) => {
    try {
      return ctx.claude(args, env);
    } catch (err) {
      return { code: null, stdout: '', stderr: '', error: (err as Error).message };
    }
  };
  // Without CLI, error would repeat across every account: probe once and log single warning.
  const probe = claude(['--version'], ctx.env);
  if (probe.error || probe.code !== 0) {
    res.unavailable = true;
    res.lines.push({ level: 'warn', text: tr('não consegui consultar o Claude Code ({0}); o mod não foi conferido.', [cliMessage(probe)]) });
    return res;
  }
  for (const { dir, label } of accounts) {
    const env = accountEnv(ctx.env, dir, ctx.home);
    const state = readAccountState(claude, env);
    if ('error' in state) {
      res.lines.push({ level: 'warn', text: tr('mod na {0}: {1}', [label, state.error]) });
      continue;
    }
    const plan = planUpdate(state, { root: ctx.root, version: ctx.version });
    if (plan.action !== 'none' || plan.installed) res.installed = true;
    if (plan.action === 'warn') {
      res.lines.push({ level: 'warn', text: tr('mod na {0}: {1}', [label, plan.message]) });
      continue;
    }
    if (plan.action === 'update') res.lines.push(applyUpdate(plan.steps, { claude, env, version: ctx.version, label }));
    // Has mod but lacks messaging plugin (added later): docker:up does not auto-install, only provides tip.
    if (plan.hint) res.lines.push({ level: 'info', text: tr('Dica para a {0}: {1}', [label, plan.hint]) });
  }
  return res;
}

/** Executes update steps for an account and returns a single summary line. */
function applyUpdate(steps: CliStep[], o: { claude: ClaudeRunner; env: NodeJS.ProcessEnv; version: string; label: string }): ModUpdateResult['lines'][number] {
  for (const step of steps) {
    const r = o.claude(step.args, o.env);
    if (r.error || r.code !== 0) {
      return { level: 'warn', text: tr('não consegui atualizar o mod na {0}: {1} ({2}). Tente: npm run mod:install', [o.label, step.message.split(':')[0], cliMessage(r)]) };
    }
  }
  // Only reports "updated" if Claude Code confirmed registered version updated.
  const after = readAccountState(o.claude, o.env);
  const ids = steps.flatMap((s) => (s.plugin ? [s.plugin] : []));
  const issues = 'error' in after ? [after.error] : verifyInstall(after, ids, o.version);
  if (issues.length) return { level: 'warn', text: tr('mod na {0}: {1}', [o.label, issues.join('; ')]) };
  return { level: 'info', text: tr('Mod atualizado para {0} na {1}; sessões abertas: /reload-plugins', [o.version, o.label]) };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  const home = process.env.HOME || homedir();
  process.exitCode = await run(parsed, {
    env: process.env,
    home,
    now: new Date(),
    root: ROOT,
    version: readPackageVersion(ROOT),
    claude: makeClaudeRunner(parsed.claudeCmd),
    out: (l) => console.log(l),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof FatalError ? tr('[mod] Erro: {0}', [err.message]) : tr('[mod] Erro inesperado: {0}', [String(err)]));
    process.exitCode = 1;
  });
}
