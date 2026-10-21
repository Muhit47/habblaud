// Habblaud Server: watches active Claude Code sessions (all accounts),
// maintains office model, and broadcasts via SSE. No runtime dependencies.
//   npm run dev    -> tsx server/index.ts --dev (Vite in middleware mode, HMR on same server)
//   npm start      -> node dist/server/index.js (serves dist/client)
import http from 'node:http';
import { join } from 'node:path';
import { codexDirsRefused, isDefaultDir } from './accounts/detect';
import { AccountsService } from './accounts/service';
import { isTruthy, loadConfig, messagesOffReason, terminalOffReason, worldSocketUrl } from './config';
import { createApiHandler, sendJson } from './http/app';
import { createRequestGuard, isLoopbackHost } from './http/guard';
import { createRemoteGate, isRemoteRequest, loadSecret, RemoteSessions, startRemoteListener, type RemoteListener } from './http/remote';
import { Hub } from './http/sse';
import { createStaticHandler } from './http/static';
import { TerminalStreams } from './http/terminal';
import { createTimelineHandler } from './http/timeline';
import { TIMELINE_DIR, TimelineRecorder } from './history/timeline';
import { DayStatsService } from './history/daystats';
import { describeStateMigration, legacyEnvWarning, migrateLegacyStateDir } from './legacy';
import { errMsg, log } from './log';
import { NameStore } from './model/names';
import { Office } from './model/office';
import { RoomAliases } from './model/room-aliases';
import { createPtyRoutes } from './http/pty';
import { claudeBinFrom, isExecutableFile, loadPty, PtyManager, type ScreenFactory, type SpawnPty } from './pty/manager';
import { loadHeadlessScreen } from './pty/screen';
import { openMainAgent, SessionHistory } from './sources/history';
import { HistorySet, SourceSet } from './sources/source';
import { createPermissionRoutes } from './permissions/http';
import { PermissionRegistry } from './permissions/registry';
import { codexAccountOf } from './codex/http';
import { createCodexQueueRunner, findCodexBin } from './messages/codex';
import { createMessageRoutes } from './messages/http';
import { MessageRegistry } from './messages/registry';
import type { CodexLive } from './sources/codex/live';
import { AntigravitySource } from './sources/antigravity';
import { KiloSource } from './sources/kilo';
import { ClaudeWatcher } from './sources/watcher';
import { discoverCodexDirs } from './sources/codex/accounts';
import { CodexHistory } from './sources/codex/history';
import { CodexSource } from './sources/codex/source';
import { createBuildReader, readBuildInfo } from './build';
import { UpdateChecker } from './updates/checker';
import { getLocale, tr } from '../shared/i18n';
import type { WorldLocale } from '../shared/world/protocol';
import { createCliRunner, createOpener, SpawnService } from './spawn/spawn';
import { runnableClaudeBin } from './claude-bin';
import { AttachmentStore } from './spawn/attachments';
import { recentFolders } from './spawn/folders';
import { isDemoId } from '../shared/timeline';
import { DictationService } from './dictation/dictation';
import { createWhisperTranscriber, findWhisper } from './dictation/whisper';
import { DeliveryIndex } from './deliveries/deliveries';
import { FileFetcher } from './deliveries/fetcher';
import { WorldClient } from './world/client';
import { createWorldRoutes } from './world/http';
import { WorldService } from './world/service';
import { WorldSettingsStore } from './world/settings';
import { OwnerSocial } from './world/social';
import { BuildingTokens } from './world/tokens';
import { BuildingUplink } from './world/uplink';
import { WorldViewer } from './world/viewer';

const config = loadConfig();
const startedAt = Date.now();

// Legacy name (CodeTown, up to 0.3.2): migrates ~/.codetown to ~/.habblaud before reading any state and warns
// about CODETOWN_* variables that are no longer valid. In Docker, docker:up handles migration.
if (!config.inDocker) {
  const r = migrateLegacyStateDir(config.home);
  const msg = describeStateMigration(r);
  if (msg) (r.error ? log.warn : log.info)(msg);
}
const legacyEnv = legacyEnvWarning(Object.keys(process.env));
if (legacyEnv) log.warn(legacyEnv);

const names = new NameStore(join(config.dataDir, 'names.json'));
names.load();
// User-assigned room names (right-click > Rename).
const roomAliases = new RoomAliases(join(config.dataDir, 'rooms.json'));
roomAliases.load();

// Office, accounts, and agent sources reference each other (change notifications / sources): late binding.
const late: { office?: Office; agents?: SourceSet; permissions?: PermissionRegistry; messages?: MessageRegistry; ptys?: PtyManager; ptyOff?: string } = {};
// New version: queries latest GitHub release every 6 hours (HABBLAUD_UPDATE_CHECK=0 disables).
const updates = new UpdateChecker({
  current: config.version,
  repo: config.repo,
  enabled: config.updateCheck,
  file: join(config.dataDir, 'updates.json'),
  onChange: () => late.office?.markDirty(),
});
updates.load();
// Habblaud World (server/world/): account and character on this machine. Enabled by default (server.habblaud.com, or
// HABBLAUD_WORLD_URL); nothing leaves machine until account is created and signed in. HABBLAUD_WORLD=0 hides everything
// (404 routes and hidden in UI); rejected HABBLAUD_WORLD_URL leaves feature disabled.
const worldStore = new WorldSettingsStore(join(config.dataDir, 'world.json'));
if (config.world.enabled && config.world.url) worldStore.load();
// Owner lightweight social (world/social.ts): daily likes, "while you were away", knocks, and blocked users.
const worldSocial = config.world.enabled ? new OwnerSocial({ session: () => worldStore.get()?.deviceId, onChange: () => late.office?.markDirty() }) : undefined;
const world = config.world.enabled
  ? new WorldService({
      config: config.world,
      terminal: config.terminal,
      store: worldStore,
      client: config.world.url ? new WorldClient({ baseUrl: config.world.url, version: config.version }) : undefined,
      onChange: () => late.office?.markDirty(),
      social: worldSocial,
    })
  : undefined;
const accounts = new AccountsService({
  dirs: config.claudeDirs,
  home: config.home,
  env: process.env,
  usageDir: config.usageDir,
  onChange: () => late.office?.markDirty(),
});
const office = new Office({
  names,
  roomAlias: (path) => roomAliases.get(path),
  version: config.version,
  // In dev mode Vite serves client directly from source: no build to compare.
  build: config.dev ? undefined : createBuildReader(config.rootDir),
  startedAt,
  accounts: (sessions) => accounts.list(sessions),
  sources: () => late.agents?.sources() ?? [],
  accountName: (id) => accounts.find(id)?.detected.name,
  terminal: config.terminal,
  permissions: () => late.permissions?.snapshot() ?? new Map(),
  messages: config.messages ? () => late.messages?.reachable() ?? new Set() : undefined,
  ptys: () => (late.ptys ? { status: late.ptys.status(), list: late.ptys.list() } : { status: { enabled: false, reason: late.ptyOff ?? tr('desligado') }, list: [] }),
  updates: () => updates.status(),
  world: () => world?.meta() ?? { enabled: false, configured: false, state: 'off' },
});
// Agent sources, one per tool (sources/source.ts): Claude Code source followed by Codex (when Codex
// folders exist; HABBLAUD_CODEX=0 disables), with history in HistorySet below and self-registered accounts
// (accounts.setProviderAccounts). `codex` also receives Codex hook events (CodexLive).
const claude = new ClaudeWatcher({ accounts, office, inDocker: config.inDocker });
const agents = new SourceSet([claude]);

if (config.antigravity) {
  const antigravity = new AntigravitySource({ office, accounts });
  agents.add(antigravity);
}

if (config.kilo) {
  const kilo = new KiloSource({ office, accounts });
  agents.add(kilo);
}

const codexDirs = config.codex ? discoverCodexDirs(process.env, config.home) : [];
const codex = codexDirs.length ? new CodexSource({ accounts, office, dirs: codexDirs, env: process.env, home: config.home }) : undefined;
if (codex) agents.add(codex);
// Codex hook events (POST /api/codex/events, mod/habblaud-codex/hook.mjs): forwarded to Codex live source
// (CodexLive); without it (no Codex folders or HABBLAUD_CODEX=0) route returns {ok: false}.
const codexLive: CodexLive | undefined = codex;
late.office = office;
late.agents = agents;
// Origin allowed to act on behalf of office: local Host on local port; on remote, only with allowed permissions.
const hub = new Hub(office, {
  canAnswer: (req) => (isRemoteRequest(req) ? !!config.remote?.allow.has('permissions') : isLoopbackHost(req.headers.host)),
});
// "My Day": samples office every second and persists to <dataDir>/stats/ (see history/daystats.ts).
const stats = new DayStatsService({ dir: join(config.dataDir, 'stats'), snapshot: () => hub.current() });
stats.load();
// Building in Habblaud World (world/uplink.ts): only with accepted world server. Automatically connects with approved
// account, created character, terminal lock, and unpaused; packet generated strictly from projection (shared/world/projection.ts).
const worldTokens = new BuildingTokens({ stats });
const worldUplink =
  world && config.world.url
    ? new BuildingUplink({
        url: worldSocketUrl(config.world.url),
        version: config.version,
        build: () => {
          const b = readBuildInfo(config.rootDir);
          return { commit: b.commit, dirty: b.dirty };
        },
        locale: () => getLocale() as WorldLocale,
        store: worldStore,
        canAct: () => config.terminal,
        agents: () => office.list(),
        subscribe: (cb) => office.onChange(cb),
        booting: () => office.isBooting(),
        tokens: () => worldTokens.read(),
        lastFile: join(config.dataDir, 'world-last-uplink.json'),
        onGoodbye: (reason) => world.goodbye(reason),
        onLeft: () => world.leftElsewhere(),
        onChange: () => office.markDirty(),
      })
    : undefined;
if (world && worldUplink) world.attachUplink(worldUplink);
// World scene (world/viewer.ts): city through building connection, active only while scene is open in browser.
const worldViewer = worldUplink ? new WorldViewer() : undefined;
if (worldUplink && worldViewer) {
  worldViewer.attach(worldUplink);
  worldUplink.attachCity(worldViewer);
}
if (worldUplink && worldSocial) {
  worldSocial.attach(worldUplink);
  worldUplink.attachOwner(worldSocial);
}
// Terminal: available only with local bind (see terminalOffReason in config.ts).
// Each agent with tool-specific parser (Claude Code parser by default).
const terminals = config.terminal
  ? new TerminalStreams({ office, transcriptPathOf: (id) => agents.transcriptPathOf(id), parserFor: (id) => agents.parserFor(id) })
  : undefined;
// Terminal history (recent sessions, open or closed, across all tools): same security lock.
const history = config.terminal
  ? new HistorySet([new SessionHistory({ accounts: () => accounts.entries(), openAgentOf: (acc, sid) => openMainAgent(office.list(), acc, sid) })])
  : undefined;
if (history && codex) history.add(new CodexHistory({ accounts: () => accounts.entriesOf('codex'), openAgentOf: (acc, sid) => openMainAgent(office.list(), acc, sid) }));
// Deliveries: task completion markers parsed from history transcripts (same terminal lock). Delivered files
// are read locally (Node, or account directory mounted in Docker) or via host helper.
const deliveries = history
  ? new DeliveryIndex({
      sessions: () => history.list(),
      resolve: (account, sessionId) => {
        const r = history.resolve(account, sessionId);
        return 'path' in r ? r : undefined;
      },
      isBusy: (id) => {
        const st = office.list().find((a) => a.id === id)?.status;
        return st === 'working' || st === 'waiting' || st === 'shell';
      },
      agentName: (id) => office.list().find((a) => a.id === id)?.name,
    })
  : undefined;
const deliveryFiles = deliveries
  ? new FileFetcher({
      direct: !config.inDocker,
      mapHostPath: (p) => {
        for (const e of accounts.entries()) {
          const host = e.detected.configDir.replace(/\/+$/, '');
          if (host && p.startsWith(`${host}/`)) return `${e.dir.replace(/\/+$/, '')}${p.slice(host.length)}`;
        }
        return undefined;
      },
    })
  : undefined;
// Timelapse timeline: records each new snapshot (throttled) to <dataDir>/timeline.
const timelineDir = join(config.dataDir, TIMELINE_DIR);
const timeline = config.timeline ? new TimelineRecorder({ dir: timelineDir }) : undefined;
if (timeline) hub.onSnapshot((snap) => timeline.ingest(snap));
// Office response actions (PermissionRequest hook): acts on sessions, adhering to terminal lock.
const permissions = config.terminal
  ? new PermissionRegistry({
      office,
      viewers: () => hub.localSize,
      answerLater: () => !!config.remote?.allow.has('permissions'),
      // Claude Code only: reading reply given in terminal parses its transcript format.
      transcriptPathOf: (id) => claude.transcriptPathOf(id),
      // Codex hook requests: account determined by CODEX_HOME directory provided.
      codexAccount: (account, codexHome) => codexAccountOf(accounts.entriesOf('codex'), account, codexHome),
      demoDecide: (id, d) => office.decideDemoPermission(id, d),
      demoDetail: (id) => office.demoPermission(id),
    })
  : undefined;
late.permissions = permissions;
// Office messaging (habblaud-mensagens plugin): enters session as if typed directly, adhering
// to same lock (HABBLAUD_MENSAGENS=0 disables messaging only). Sent to Codex via `codex queue` (messages/codex.ts):
// outside Docker server executes command directly (HABBLAUD_CODEX_BIN or `codex` from PATH); in Docker, host helper
// handles it (npm run codex:bridge).
const codexBin = config.messages && !config.inDocker ? findCodexBin(process.env) : undefined;
// Interactive terminal and New Agent: both execute Claude Code locally, requiring same authorization:
// HABBLAUD_PTY=1 (accepts same values as HABBLAUD_TERMINAL).
const ptyFlag = process.env.HABBLAUD_PTY?.trim();
const ptyOptIn = isTruthy(ptyFlag);
// New Agent via office (background Claude Code session, or pre-filled Claude desktop app): requires
// authorization above plus messaging lock. In Docker, executed by host helper (npm run codex:bridge).
const spawnOn = config.messages && ptyOptIn;
const attachments = spawnOn ? new AttachmentStore() : undefined;
const spawnBin = config.inDocker ? undefined : runnableClaudeBin(process.env);
const spawn = spawnOn
  ? new SpawnService(config.inDocker ? { attachments } : { opener: createOpener(), cli: spawnBin ? createCliRunner(spawnBin) : undefined, attachments })
  : undefined;
// Dictation: in Docker transcribed by host helper; in Node, by server if local Whisper found.
const whisper = config.messages && !config.inDocker ? findWhisper() : undefined;
const dictation = config.messages
  ? new DictationService(whisper && !('missing' in whisper) ? { transcriber: createWhisperTranscriber(whisper) } : {})
  : undefined;
const messages = config.messages
  ? new MessageRegistry({
      office,
      demoAgent: (id) => office.demoAgent(id),
      demoDeliver: (id, text) => office.deliverDemoMessage(id, text),
      codex: {
        run: codexBin ? createCodexQueueRunner(codexBin) : undefined,
        homeOf: (account) => accounts.entriesOf('codex').find((e) => e.id === account)?.detected.configDir,
      },
    })
  : undefined;
late.messages = messages;

// Interactive terminal (open/attach sessions and terminate agents): opt-in with HABBLAUD_PTY=1, local bind only,
// outside Docker, with node-pty and claude executable in PATH.
const claudeBinSetting = process.env.HABBLAUD_CLAUDE_BIN?.trim();
const claudeBin = claudeBinFrom();
let spawnPty: SpawnPty | null = null;
let ptyScreen: ScreenFactory | undefined;
let ptyOff: string | undefined;
if (!ptyOptIn) ptyOff = ptyFlag ? tr('desligado por HABBLAUD_PTY={0}', [ptyFlag]) : tr('desligado (ligue com HABBLAUD_PTY=1)');
else if (config.inDocker) ptyOff = tr('indisponível no Docker (rode com npm start)');
else if (!config.terminal) ptyOff = tr('mesma trava do terminal ({0})', [terminalOffReason(process.env, config.host, config.inDocker)]);
else if (!claudeBin) ptyOff = claudeBinSetting ? tr('HABBLAUD_CLAUDE_BIN não encontrado no PATH ({0})', [claudeBinSetting]) : tr('executável "claude" não encontrado no PATH (defina HABBLAUD_CLAUDE_BIN)');
else if (!isExecutableFile(claudeBin)) ptyOff = tr('o executável do Claude Code não roda: {0} (confira o HABBLAUD_CLAUDE_BIN)', [claudeBin]);
else {
  const loaded = await loadPty();
  spawnPty = loaded.spawn;
  ptyOff = loaded.reason;
  if (spawnPty) {
    const screen = await loadHeadlessScreen();
    ptyScreen = screen.create ?? undefined;
    if (screen.reason) log.warn(tr('Terminal interativo sem a tela completa ({0}): ao reconectar, modos como a colagem entre colchetes podem se perder.', [screen.reason]));
  }
}
const ptys = spawnPty
  ? new PtyManager({
      spawn: spawnPty,
      claudeBin: claudeBin ?? 'claude',
      accounts: () => accounts.entries().map((a) => ({ id: a.id, dir: a.dir, isDefault: isDefaultDir(a.dir, config.home) })),
      agent: (id) => {
        const a = office.get(id);
        return a && { id: a.id, kind: a.kind, account: a.account, sessionId: a.sessionId, cwd: office.roomPath(a.roomId) };
      },
      onChange: () => office.markDirty(),
      createScreen: ptyScreen,
    })
  : undefined;
late.ptys = ptys;
late.ptyOff = ptyOff;

if (config.demo) office.setDemo(true);
// Synchronous sources (Claude Code) complete boot here before hub begins broadcasting.
void agents.start();
accounts.start();
hub.start();
if (timeline) {
  timeline.start();
  timeline.ingest(hub.current());
}
permissions?.start();
messages?.start();
stats.start();
updates.start();
worldUplink?.start();
const ticker = setInterval(() => {
  try {
    office.tick();
  } catch (err) {
    log.warnOnce(`tick:${errMsg(err)}`, tr('Falha no relógio do escritório: {0}', [errMsg(err)]));
  }
}, 250);

const api = createApiHandler({
  renameRoom: (id, name) => {
    const path = office.roomPath(id);
    if (!path) return undefined;
    roomAliases.set(path, name);
    office.refreshRoomNames();
    return office.roomName(id);
  },
  office,
  hub,
  accounts,
  sources: () => agents.sources(),
  version: config.version,
  inDocker: config.inDocker,
  terminal: config.terminal,
  terminals,
  sessions: history,
  timeline: createTimelineHandler({ dir: timelineDir, recording: !!timeline }),
  permissions: permissions ? createPermissionRoutes(permissions) : undefined,
  messages: messages ? createMessageRoutes(messages) : undefined,
  pty: ptys ? createPtyRoutes(ptys) : undefined,
  spawn,
  attachments,
  dictation,
  deliveries,
  files: deliveryFiles,
  spawnFolders: async () => {
    const snap = hub.current();
    const last = new Map<string, number>();
    for (const a of snap.agents) last.set(a.roomId, Math.max(last.get(a.roomId) ?? 0, a.lastEventAt ?? 0));
    const rooms = snap.rooms.filter((r) => !isDemoId(r.id)).map((r) => ({ path: r.path, lastAt: last.get(r.id) ?? 0 }));
    return recentFolders(history ? await history.list().catch(() => []) : [], rooms);
  },
  codexLive,
  stats,
  updates,
  remote: config.remote ? { is: isRemoteRequest, allows: (f) => config.remote!.allow.has(f) } : undefined,
  world: world ? createWorldRoutes(world, worldViewer, worldSocial) : undefined,
});

const server = http.createServer();
let closeVite: (() => Promise<void>) | undefined;

function parseUrl(req: http.IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return new URL('/', 'http://localhost');
  }
}

/** Handles non-API requests: Vite (dev) or dist/client static files (production). */
let fallback: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void;
if (config.dev) {
  // Dynamic import: production bundle never loads Vite.
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: join(config.rootDir, 'vite.config.ts'),
    server: { middlewareMode: true, ws: { server } },
    appType: 'spa',
  });
  closeVite = () => vite.close();
  fallback = (req, res) => vite.middlewares(req, res);
} else {
  const serveStatic = createStaticHandler(join(config.rootDir, 'dist', 'client'));
  fallback = (req, res, url) => serveStatic(req, res, url.pathname);
}

// Host/Origin/Content-Type: guards against DNS rebinding and CSRF before any route (including Vite).
const guard = createRequestGuard({ allowedHosts: config.allowedHosts });

server.on('request', (req, res) => {
  const url = parseUrl(req);
  try {
    if (guard(req, res)) return;
    if (!api(req, res, url)) fallback(req, res, url);
  } catch (err) {
    log.warn(tr('Erro ao responder {0} {1}: {2}', [req.method, url.pathname, errMsg(err)]));
    if (!res.headersSent) sendJson(res, 500, { error: tr('erro interno') });
    else res.destroy();
  }
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') log.error(tr('A porta {0} já está em uso (defina HABBLAUD_PORT para usar outra).', [config.port]));
  else log.error(tr('Erro no servidor HTTP: {0}', [errMsg(err)]));
  process.exit(1);
});

/**
 * Remote port (mobile on local network): identical app, but all requests require authentication (http/remote.ts)
 * prior to API. Primary port remains strictly local; distinction determined by incoming socket port.
 */
let remoteListener: RemoteListener | undefined;
if (config.remote) {
  const remote = config.remote;
  const gate = createRemoteGate({
    config: remote,
    sessions: new RemoteSessions(loadSecret(join(config.dataDir, 'remote-secret')), remote, Date.now, join(config.dataDir, 'remote-revoked.json')),
    secure: !!remote.tls,
    caFile: remote.tls?.caFile,
  });
  remoteListener = startRemoteListener(
    remote,
    (req, res) => {
      const url = parseUrl(req);
      try {
        if (guard(req, res)) return;
        if (gate(req, res, url)) return;
        if (!api(req, res, url)) fallback(req, res, url);
      } catch (err) {
        log.warn(tr('Erro ao responder (remoto) {0} {1}: {2}', [req.method, url.pathname, errMsg(err)]));
        if (!res.headersSent) sendJson(res, 500, { error: tr('erro interno') });
        else res.destroy();
      }
    },
    log,
    config.allowedHosts,
  );
  remoteListener.server.once('listening', () => {
    const allow = [...remote.allow].join(', ') || tr('só ver');
    const where = config.inDocker ? tr('publicada pelo HABBLAUD_REMOTE_BIND') : remote.host;
    const scheme = remote.tls ? 'HTTPS' : tr('HTTP SEM criptografia (HABBLAUD_REMOTE_INSECURE_HTTP)');
    log.info(tr('   Acesso remoto: ligado na porta {0} ({1}), {2}, com login; libera: {3}.', [remote.port, where, scheme, allow]));
    if (remote.allow.has('spawn') && !spawn) log.warn(tr('   Acesso remoto: "spawn" liberado, mas o Novo agente está desligado (ligue com HABBLAUD_PTY=1).'));
  });
} else if (config.remoteWarning) {
  log.warn(`   ${config.remoteWarning}.`);
}

server.listen(config.port, config.host, () => {
  const host = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  log.info(tr('🏢 Habblaud {0}{1}{2} em http://{3}:{4}', [config.version, config.dev ? ' (dev)' : '', config.inDocker ? ' (docker)' : '', host, config.port]));
  const list = accounts.entries();
  if (!list.length) log.warn(tr('Nenhuma pasta do Claude Code encontrada (defina HABBLAUD_CLAUDE_DIRS).'));
  for (const dir of codexDirsRefused(process.env, config.home)) {
    log.warn(tr('{0} é uma pasta do Codex, não do Claude Code: fica fora das contas do Claude Code.', [dir]));
  }
  for (const a of list) {
    const src = agents.sources().find((s) => s.label === a.id);
    const usage = accounts.usageView(a.id).status;
    log.info(tr('   Conta {0} ({1}): {2} sessão(ões) aberta(s) · uso: {3} · {4}', [a.detected.short, a.id, src?.sessions ?? 0, usage, a.dir]));
  }
  if (codex) {
    const codexAccounts = codex.accountEntries();
    const open = codex.sources().reduce((n, s) => n + s.sessions, 0);
    log.info(tr('   Codex: {0} conta(s), {1} sessão(ões) aberta(s).', [codexAccounts.length, open]));
    for (const a of codexAccounts) {
      log.info(tr('   Conta {0} do Codex ({1}): uso: {2} · {3}', [a.detected.short, a.id, accounts.usageView(a.id).status, a.detected.configDir]));
    }
  } else {
    log.info(tr('   Codex: {0}.', [config.codex ? tr('nenhuma pasta do Codex encontrada (defina HABBLAUD_CODEX_DIRS)') : tr('desligado (HABBLAUD_CODEX=0)')]));
  }
  if (office.isDemo()) log.info(tr('   Modo demonstração ligado (agentes simulados misturados aos reais).'));
  if (config.terminal) log.info(tr('   Terminal: ligado (acesso só local).'));
  else log.info(tr('   Terminal: desligado ({0}).', [terminalOffReason(process.env, config.host, config.inDocker)]));
  log.info(ptys ? tr('   Terminal interativo: ligado ({0}).', [claudeBin]) : tr('   Terminal interativo: {0}.', [ptyOff ?? tr('desligado')]));
  log.info(
    !spawn
      ? tr('   Novo agente: desligado ({0}).', [!ptyOptIn ? tr('ligue com HABBLAUD_PTY=1') : tr('mesma trava das mensagens')])
      : config.inDocker
        ? tr('   Novo agente: ligado, pelo auxiliar do host (deixe npm run codex:bridge rodando no computador).')
        : spawnBin
          ? tr('   Novo agente: ligado ({0} --bg; pasta ainda não confiável abre no app do Claude).', [spawnBin])
          : tr('   Novo agente: ligado, só pelo app do Claude (claude não encontrado no PATH).'),
  );
  log.info(timeline ? tr('   Linha do tempo (timelapse): gravando em {0}.', [timelineDir]) : tr('   Linha do tempo (timelapse): gravação desligada (HABBLAUD_TIMELINE).'));
  log.info(tr('   Responder pelo escritório: {0}.', [config.terminal ? tr('ligado (precisa do mod: npm run mod:install; ou do hook antigo: npm run hooks:install)') : tr('desligado (mesma trava do terminal)')]));
  log.info(
    config.messages
      ? tr('   Mensagens pelo escritório: ligadas (precisa do plugin habblaud-mensagens: npm run mod:install).')
      : tr('   Mensagens pelo escritório: desligadas ({0}).', [messagesOffReason(process.env, config.host, config.inDocker)]),
  );
  if (config.messages) {
    log.info(
      codexBin
        ? tr('   Mensagens ao Codex: pelo codex queue ({0}).', [codexBin])
        : config.inDocker
          ? tr('   Mensagens ao Codex: pelo auxiliar do host (deixe npm run codex:bridge rodando no Mac).')
          : tr('   Mensagens ao Codex: sem o binário do Codex (codex no PATH ou HABBLAUD_CODEX_BIN); o auxiliar npm run codex:bridge também serve.'),
    );
  }
  if (config.world.warning) log.warn(`   ${config.world.warning}.`);
  log.info(
    !world
      ? tr('   Habblaud World: escondido (HABBLAUD_WORLD=0).')
      : !config.world.url
        ? tr('   Habblaud World: desligado (HABBLAUD_WORLD_URL recusada).')
        : tr('   Habblaud World: {0}, conta neste computador: {1}{2}.', [
            config.world.defaultUrl ? tr('{0} (padrão)', [config.world.url]) : config.world.url,
            world.state(),
            config.terminal ? '' : tr(' (só leitura: a trava do terminal está desligada)'),
          ]),
  );
  log.info(
    updates.enabled
      ? tr('   Versão nova: verificando as releases de github.com/{0} a cada 6 h.', [config.repo])
      : tr('   Versão nova: verificação desligada ({0}).', [config.repo ? 'HABBLAUD_UPDATE_CHECK' : tr('package.json sem repositório no GitHub')]),
  );
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(tr('Encerrando ({0})…', [signal]));
  clearInterval(ticker);
  stats.stop();
  agents.stop();
  accounts.stop();
  hub.stop();
  terminals?.stop();
  timeline?.stop();
  permissions?.stop();
  messages?.stop();
  ptys?.stopAll();
  updates.stop();
  worldViewer?.stop();
  worldUplink?.stop();
  world?.stop();
  names.flush();
  void closeVite?.();
  remoteListener?.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
