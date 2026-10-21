// API routes (/api/*). JSON responses; unknown routes -> 404 JSON.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NAME_MAX, parseAppearanceParts, parseCharacterName, parseSeed } from '../../shared/appearance';
import type { AccessInfo, AgentInfo, ModSummary, OfficeSnapshot, SourceInfo, UpdateStatus } from '../../shared/types';
import type { AccountsService } from '../accounts/service';
import { handleCodexEvent } from '../codex/http';
import type { DayStatsService } from '../history/daystats';
import type { Office } from '../model/office';
import type { CodexLive } from '../sources/codex/live';
import type { SessionLookup } from '../sources/source';
import { isJsonContentType, isLoopbackHost } from './guard';
import type { RemoteFeature } from './remote';
import { handleSessionsRoute } from './sessions';
import type { Hub } from './sse';
import { handleStatsRoute } from './stats';
import type { TerminalStreams } from './terminal';
import { tr } from '../../shared/i18n';
import type { SpawnService } from '../spawn/spawn';
import { ATTACHMENT_BODY_MAX, parseAttachment, type AttachmentStore } from '../spawn/attachments';
import type { SpawnFolder } from '../spawn/folders';
import { AUDIO_BODY_MAX, type DictationService } from '../dictation/dictation';
import type { DeliveryIndex } from '../deliveries/deliveries';
import type { FileFetcher } from '../deliveries/fetcher';
import { HOST_WAIT_MS } from '../host-wait';

export interface ApiDeps {
  office: Office;
  hub: Hub;
  accounts: AccountsService;
  sources: () => SourceInfo[];
  version: string;
  inDocker: boolean;
  /** Terminal enabled (ServerConfig.terminal: only with local bind). */
  terminal?: boolean;
  /** Terminal streams; without them the feature is disabled even if `terminal` is true. */
  terminals?: TerminalStreams;
  /**
   * Terminal session history (GET /api/sessions/*, http/sessions.ts): HistorySet across all tools
   * (or a single provider); same lock as terminal.
   */
  sessions?: SessionLookup;
  /** Timelapse routes (/api/timeline/*, see http/timeline.ts); returns false for other paths. */
  timeline?: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;
  /**
   * /api/permissions routes (replying via office UI, server/permissions/http.ts). Only available with
   * local bind (ServerConfig.terminal); local Host lock is verified here prior to calling them.
   */
  permissions?: (req: IncomingMessage, res: ServerResponse, path: string) => void;
  /**
   * Office messaging routes (/api/messages, plugin inbox at /api/mod/inbox, and Codex bridge
   * at /api/codex/bridge/*, server/messages/http.ts). Only available with ServerConfig.messages
   * (terminal lock and HABBLAUD_MENSAGENS); local Host lock verified here prior to calling them.
   */
  messages?: (req: IncomingMessage, res: ServerResponse, path: string) => void;
  /**
   * Interactive terminal and agent actions (/api/pty/*, POST /api/agents/:id/stop|takeover; http/pty.ts).
   * Missing = disabled (without HABBLAUD_PTY=1, Docker, node-pty unavailable, or without local bind).
   */
  pty?: (req: IncomingMessage, res: ServerResponse, path: string) => void;
  /**
   * Live Codex source: receives events from Codex hooks (POST /api/codex/events, server/codex/http.ts). Without
   * it route replies {ok: false}. Strictly local Host and, outside Docker, loopback connection (events only observe:
   * independent of terminal lock).
   */
  codexLive?: CodexLive;
  /** Spawn new agent via office UI (/api/spawn and host helper /api/host/spawn/*; server/spawn/spawn.ts). */
  spawn?: SpawnService;
  /** Suggested folders in "New agent" modal (GET /api/spawn/folders; spawn/folders.ts): recent projects. */
  spawnFolders?: () => Promise<SpawnFolder[]>;
  /** Attachments for "New agent" (POST /api/spawn/attachments; spawn/attachments.ts). */
  attachments?: AttachmentStore;
  /** Dictation (/api/dictation and host helper /api/host/dictation/*; dictation/dictation.ts). */
  dictation?: DictationService;
  /** Deliveries (GET /api/deliveries and file attachments at /api/deliveries/file/:id; deliveries/deliveries.ts). */
  deliveries?: DeliveryIndex;
  /** File fetcher for deliveries (and host helper at /api/host/files/*; deliveries/fetcher.ts). */
  files?: FileFetcher;
  /** Renames room (POST /api/rooms/rename {id, name}; empty reverts to default). Returns active name, or undefined if missing. */
  renameRoom?: (id: string, name: string) => string | undefined;
  /** "Where did my day go" statistics (GET /api/stats, http/stats.ts). */
  stats?: DayStatsService;
  /** Check for new versions on GitHub (GET /api/updates, POST /api/updates/check; updates/checker.ts). */
  updates?: {
    status(): UpdateStatus;
    check(opts: { manual?: boolean }): Promise<UpdateStatus>;
  };
  /**
   * Remote port with login (http/remote.ts): `is` checks if request came via remote port (already authenticated);
   * `allows` checks HABBLAUD_REMOTE_ALLOW permissions. Remote request is never considered local Host.
   */
  remote?: { is(req: IncomingMessage): boolean; allows(feature: RemoteFeature): boolean };
  /**
   * Habblaud World routes (/api/world/*, server/world/http.ts). Missing = HABBLAUD_WORLD=0: 404 on all.
   * Strictly local port with local Host: blocked on remote port even with login (403 `local_only`).
   */
  world?: (req: IncomingMessage, res: ServerResponse, url: URL) => void;
}

/** GET /api/agents/:id/terminal (IDs never contain '/'). */
const TERMINAL_ROUTE = /^\/api\/agents\/([^/]+)\/terminal$/;
/** POST /api/agents/:id/stop|takeover (interactive terminal). */
const AGENT_ACTION_ROUTE = /^\/api\/agents\/[^/]+\/(stop|takeover)$/;

/** PUT|DELETE /api/agents/:id/character: project character appearance (see Office.setCharacter). */
const CHARACTER_ROUTE = /^\/api\/agents\/([^/]+)\/character$/;
const NOT_EDITABLE = tr('agente não encontrado: só o agente principal de uma sessão aberta tem personagem editável');

/** Connection originating from loopback interface (127.x, ::1, or ::ffff:127.x). */
function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/i, '');
  return a === '::1' || /^127\./.test(a);
}

/** Office messaging routes (server/messages/http.ts); /api/mod/summary is exempt (unlocked). */
/**
 * Hook, plugin, and host-helper routes: register and wait for permission requests, fetch messages for
 * a session, poll rounds. Strictly valid on local port; denied on remote port even with login.
 */
function isLocalOnlyPath(path: string): boolean {
  return (
    path === '/api/permissions' ||
    /^\/api\/permissions\/[^/]+\/wait$/.test(path) ||
    path === '/api/mod/inbox' ||
    path === '/api/mod/inbox/ack' ||
    path.startsWith('/api/codex/') ||
    path.startsWith('/api/host/')
  );
}

function isMessagesPath(path: string): boolean {
  return (
    path === '/api/messages' ||
    path.startsWith('/api/messages/') ||
    path === '/api/mod/inbox' ||
    path === '/api/mod/inbox/ack' ||
    path === '/api/codex/bridge/poll' ||
    path === '/api/codex/bridge/ack'
  );
}

const MAX_BODY = 256 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // API is only read by the web app itself: no "no-cors" reads by other origins.
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  res.end(data);
}

/**
 * Delivery attachment. HTML and SVG are sandboxed without scripts (CSP) to prevent execution within office context;
 * PDF and images can open inside modal (same origin).
 */
function sendFile(res: ServerResponse, data: Buffer, type: string, name: string): void {
  const active = /^text\/html|^image\/svg/.test(type);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
    ...(active ? { 'Content-Security-Policy': "sandbox; default-src 'none'; img-src data: blob: 'self'; style-src 'unsafe-inline'; media-src 'self'" } : {}),
  });
  res.end(data);
}

/** Reads JSON body. Requires `Content-Type: application/json` (CSRF barrier; see http/guard.ts). */
export function readJson(req: IncomingMessage, max = MAX_BODY): Promise<unknown> {
  if (!isJsonContentType(req.headers['content-type'])) {
    req.resume();
    return Promise.reject(new HttpError(415, tr('envie o corpo como JSON (Content-Type: application/json)')));
  }
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      // Too large: continue draining (without buffering) to send 413 response.
      if (size > max) return void fail(new HttpError(413, tr('corpo grande demais')));
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > max) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return ok({});
      try {
        ok(JSON.parse(raw));
      } catch {
        fail(new HttpError(400, tr('JSON inválido')));
      }
    });
    req.on('error', fail);
  });
}

/** Updates summary for /api/health endpoint. */
function updatesSummary(s: UpdateStatus | undefined): { state: UpdateStatus['state']; latest?: string; available: boolean } {
  return s ? { state: s.state, latest: s.latest, available: s.available } : { state: 'off', available: false };
}

/** Subagents nested deeper than this do not exist in practice; limit prevents cycles in corrupted parentId. */
const MAX_PARENT_HOPS = 16;

/**
 * Summary for Claude Code mod (GET /api/mod/summary, see ModSummary). `isReal` identifies real agents:
 * demo agents exist only in snapshot (not in Office), so `office.has(id)` distinguishes them without depending
 * on "demo:" prefix. The calling session is excluded when `session` is provided (matching `account` if passed):
 * primary agent has active sessionId (updated on /clear) and subagents store initiating sessionId;
 * subagents are also excluded if any ancestor (parentId) matches.
 */
export function modSummary(
  snap: OfficeSnapshot,
  isReal: (id: string) => boolean,
  version: string,
  own: { account?: string; session?: string } = {},
): ModSummary {
  const byId = new Map(snap.agents.map((a) => [a.id, a]));
  const rooms = new Map(snap.rooms.map((r) => [r.id, r.name]));
  const isOwn = (a: AgentInfo): boolean => {
    if (!own.session || (own.account && a.account !== own.account)) return false;
    let cur: AgentInfo | undefined = a;
    for (let hops = 0; cur && hops <= MAX_PARENT_HOPS; hops++) {
      if (cur.sessionId === own.session) return true;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return false;
  };
  const present = snap.agents.filter((a) => isReal(a.id) && a.status !== 'offline' && a.status !== 'done' && !isOwn(a));
  const waiting = present
    .filter((a) => a.status === 'waiting')
    .sort((a, b) => a.statusSince - b.statusSince || a.id.localeCompare(b.id))
    .map((a) => ({
      id: a.id,
      name: a.name,
      room: rooms.get(a.roomId) ?? a.roomId,
      account: a.account,
      waitingFor: a.waitingFor ?? tr('responder no terminal'),
      since: a.statusSince,
      answerable: !!a.permission,
    }));
  return { version, agents: present.length, working: present.filter((a) => a.status === 'working').length, waiting };
}

/** Returns a handler for /api/* routes, returning false for other paths. */
export function createApiHandler(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean {
  const { office, hub, accounts } = deps;
  const terminals = deps.terminal ? deps.terminals : undefined;

  const isRemote = (req: IncomingMessage): boolean => !!deps.remote?.is(req);
  /**
   * Local access lock: on local port, Host header must be loopback; on remote port, only
   * permissions granted by HABBLAUD_REMOTE_ALLOW (`feature` missing = never allowed on remote port).
   */
  const trusted = (req: IncomingMessage, feature?: RemoteFeature): boolean =>
    isRemote(req) ? !!feature && !!deps.remote?.allows(feature) : isLoopbackHost(req.headers.host);
  const denied = (req: IncomingMessage, localMessage: string): string =>
    isRemote(req) ? tr('não liberado no acesso remoto (veja HABBLAUD_REMOTE_ALLOW)') : localMessage;

  const methodNotAllowed = (res: ServerResponse, allow: string) => {
    res.setHeader('Allow', allow);
    sendJson(res, 405, { error: tr('método não permitido') });
  };

  const handleDemo = async (req: IncomingMessage, res: ServerResponse) => {
    const body = (await readJson(req)) as { enabled?: unknown };
    if (typeof body?.enabled !== 'boolean') throw new HttpError(400, tr('esperado {enabled: boolean}'));
    office.setDemo(body.enabled);
    sendJson(res, 200, { ok: true, demo: office.isDemo() });
  };

  const handleCharacter = async (req: IncomingMessage, res: ServerResponse, id: string, method: string) => {
    if (method === 'DELETE') {
      req.resume();
      if (office.resetCharacter(id) === 'not-found') return sendJson(res, 404, { error: NOT_EDITABLE });
      return sendJson(res, 200, { ok: true });
    }
    const body = (await readJson(req)) as { name?: unknown; seed?: unknown; parts?: unknown } | null;
    const name = parseCharacterName(body?.name);
    const seed = parseSeed(body?.seed);
    const parts = parseAppearanceParts(body?.parts);
    if (!name || seed === null || !parts) {
      throw new HttpError(400, tr('esperado {name: texto de 1 a {0} caracteres, seed: inteiro de 0 a 4294967295, parts: peças da aparência}', [NAME_MAX]));
    }
    const r = office.setCharacter(id, { name, seed, parts });
    if (r.result === 'not-found') return sendJson(res, 404, { error: NOT_EDITABLE });
    if (r.result === 'conflict') return sendJson(res, 409, { error: r.message });
    sendJson(res, 200, { ok: true });
  };

  /**
   * Host helper polling round: with `?wait=1`, response waits for work (up to HOST_WAIT_MS). Returns undefined
   * if connection closed while waiting (nothing dequeued).
   */
  const hostWait = async <T>(res: ServerResponse, url: URL, poll: (ms: number, signal: AbortSignal) => Promise<T[]>): Promise<T[] | undefined> => {
    const ac = new AbortController();
    const abort = () => ac.abort();
    res.once('close', abort);
    try {
      const list = await poll(url.searchParams.get('wait') === '1' ? HOST_WAIT_MS : 0, ac.signal);
      return ac.signal.aborted ? undefined : list;
    } finally {
      res.off('close', abort);
    }
  };

  const fail = (res: ServerResponse, err: unknown) => {
    if (res.headersSent) return void res.destroy();
    if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
    else sendJson(res, 500, { error: tr('erro interno') });
  };

  return (req, res, url) => {
    const path = url.pathname;
    if (path !== '/api' && !path.startsWith('/api/')) return false;
    const method = req.method ?? 'GET';
    const isRead = method === 'GET' || method === 'HEAD';

    if (isRemote(req) && isLocalOnlyPath(path)) {
      req.resume();
      sendJson(res, 403, { error: tr('rota só do próprio computador (hooks, plugins e o auxiliar do host)') });
      return true;
    }
    if (path === '/api/world' || path.startsWith('/api/world/')) {
      // Habblaud World account acts on user's behalf: strictly local computer, like terminal. Local Host header alone is
      // not enough (Tailscale reaches loopback and Host can be forged): remote port is never allowed, even with login.
      if (!deps.world) {
        req.resume();
        sendJson(res, 404, { error: tr('rota desconhecida') });
      } else if (isRemote(req) || !isLoopbackHost(req.headers.host)) {
        req.resume();
        sendJson(res, 403, { error: { code: 'local_only', message: tr('o Habblaud World só é usado pelo próprio computador (http://localhost)') } });
      } else deps.world(req, res, url);
      return true;
    }
    if (path === '/api/stream') {
      if (method !== 'GET') methodNotAllowed(res, 'GET');
      else hub.attach(req, res);
      return true;
    }
    if (path === '/api/snapshot') {
      if (!isRead) methodNotAllowed(res, 'GET');
      else sendJson(res, 200, hub.current());
      return true;
    }
    if (path === '/api/health') {
      if (!isRead) methodNotAllowed(res, 'GET');
      else {
        const remote = isRemote(req);
        sendJson(res, 200, {
          ok: true,
          version: deps.version,
          demo: office.isDemo(),
          docker: deps.inDocker,
          remote,
          terminal: !!terminals && (!remote || trusted(req, 'terminal')),
          permissions: !!deps.permissions && (!remote || trusted(req, 'permissions')),
          // Interactive terminal (pty) is never permitted via remote port.
          pty: !!deps.pty && !remote,
          messages: !!deps.messages && (!remote || trusted(req, 'messages')),
          codexEvents: !!deps.codexLive,
          updates: updatesSummary(deps.updates?.status()),
          sources: deps.sources(),
          accounts: accounts.allEntries().map((a) =>
            a.provider === 'claude'
              ? { id: a.id, usageStatus: accounts.usageView(a.id).status }
              : { id: a.id, provider: a.provider, usageStatus: accounts.usageView(a.id).status },
          ),
        });
      }
      return true;
    }
    if (path === '/api/access') {
      if (!isRead) methodNotAllowed(res, 'GET');
      else {
        const remote = isRemote(req);
        const access: AccessInfo = {
          remote,
          local: !remote && isLoopbackHost(req.headers.host),
          permissions: !!deps.permissions && trusted(req, 'permissions'),
          messages: !!deps.messages && trusted(req, 'messages'),
          terminal: !!terminals && trusted(req, 'terminal'),
          spawn: !!deps.spawn && trusted(req, 'spawn'),
          world: !!deps.world && !!deps.terminal && !remote && isLoopbackHost(req.headers.host),
        };
        sendJson(res, 200, access);
      }
      return true;
    }
    if (path === '/api/mod/summary') {
      // Polled every 5 s per mod session: counts and waiting agents only (nothing beyond snapshot).
      if (!isRead) methodNotAllowed(res, 'GET');
      else {
        const own = { account: url.searchParams.get('account') || undefined, session: url.searchParams.get('session') || undefined };
        sendJson(res, 200, modSummary(hub.current(), (id) => office.has(id), deps.version, own));
      }
      return true;
    }
    const terminalMatch = TERMINAL_ROUTE.exec(path);
    if (terminalMatch) {
      if (method !== 'GET') methodNotAllowed(res, 'GET');
      else if (!terminals) {
        sendJson(res, 403, { error: tr('terminal desligado: ele só funciona com o Habblaud acessível apenas pelo próprio computador') });
      } else if (!trusted(req, 'terminal')) {
        sendJson(res, 403, { error: denied(req, tr('o terminal só abre pelo próprio computador (http://localhost ou http://127.0.0.1)')) });
      } else {
        let id: string;
        try {
          id = decodeURIComponent(terminalMatch[1]);
        } catch {
          sendJson(res, 400, { error: tr('id inválido') });
          return true;
        }
        terminals.attach(req, res, id);
      }
      return true;
    }
    if (path.startsWith('/api/sessions/')) {
      handleSessionsRoute(req, res, path, {
        history: deps.terminal ? deps.sessions : undefined,
        terminals,
        trusted: isRemote(req) ? trusted(req, 'terminal') : undefined,
      });
      return true;
    }
    if (path === '/api/permissions' || path.startsWith('/api/permissions/')) {
      // Answering via office acts on sessions: same lock as terminal (local bind + local Host).
      if (!deps.permissions) {
        sendJson(res, 403, { error: tr('responder pelo escritório desligado: só funciona com o Habblaud acessível apenas pelo próprio computador') });
      } else if (!trusted(req, 'permissions')) {
        sendJson(res, 403, { error: denied(req, tr('pedidos de permissão só são respondidos pelo próprio computador (http://localhost ou http://127.0.0.1)')) });
      } else {
        deps.permissions(req, res, path);
      }
      return true;
    }
    if (path === '/api/pty' || path.startsWith('/api/pty/') || AGENT_ACTION_ROUTE.test(path)) {
      // Executes commands on machine: never allowed via remote port, even with login (Host header and peer
      // address are insufficient: Tailscale arrives via loopback and Host can be spoofed).
      if (isRemote(req)) sendJson(res, 403, { error: tr('o terminal interativo só pode ser usado no próprio computador') });
      else if (!deps.pty) sendJson(res, 403, { error: tr('terminal interativo desligado (veja o log do servidor)') });
      else deps.pty(req, res, path);
      return true;
    }
    const characterMatch = CHARACTER_ROUTE.exec(path);
    if (characterMatch) {
      // Changing character modifies office: same lock as terminal (local bind + local Host).
      if (method !== 'PUT' && method !== 'DELETE') methodNotAllowed(res, 'PUT, DELETE');
      else if (!deps.terminal) {
        sendJson(res, 403, { error: tr('editar o personagem desligado: só funciona com o Habblaud acessível apenas pelo próprio computador') });
      } else if (!trusted(req)) {
        sendJson(res, 403, { error: denied(req, tr('o personagem só é editado pelo próprio computador (http://localhost ou http://127.0.0.1)')) });
      } else {
        let id: string;
        try {
          id = decodeURIComponent(characterMatch[1]);
        } catch {
          sendJson(res, 400, { error: tr('id inválido') });
          return true;
        }
        handleCharacter(req, res, id, method).catch((err) => fail(res, err));
      }
      return true;
    }
    if (path === '/api/codex/events') {
      // Codex hook events: observer-only, but strictly accepted from local machine. Outside Docker, hook
      // always connects via loopback (network clients can spoof Host header); in Docker, arrives via published
      // port with gateway address.
      if (method !== 'POST') methodNotAllowed(res, 'POST');
      else if (!trusted(req) || (!deps.inDocker && !isLoopbackAddress(req.socket.remoteAddress))) {
        sendJson(res, 403, { error: denied(req, tr('eventos do Codex só são aceitos pelo próprio computador (http://localhost ou http://127.0.0.1)')) });
      } else handleCodexEvent(req, res, { live: deps.codexLive, entries: () => accounts.entriesOf('codex') }).catch((err) => fail(res, err));
      return true;
    }
    if (path === '/api/spawn' || path.startsWith('/api/spawn/')) {
      // Spawns new session in Claude app: executes code on computer, so requires same lock as messages.
      const spawn = deps.spawn;
      if (!spawn) sendJson(res, 403, { error: tr('novo agente pelo escritório desligado') });
      else if (!trusted(req, 'spawn')) sendJson(res, 403, { error: denied(req, tr('agentes novos só são abertos pelo próprio computador (http://localhost)')) });
      else if (path === '/api/spawn' && isRead) sendJson(res, 200, { available: spawn.available(), mode: spawn.mode() });
      else if (path === '/api/spawn/folders') {
        if (!isRead) methodNotAllowed(res, 'GET');
        else (deps.spawnFolders ?? (async () => []))().then((folders) => sendJson(res, 200, { folders }), (err) => fail(res, err));
      } else if (path === '/api/spawn/attachments') {
        const store = deps.attachments;
        if (method !== 'POST') methodNotAllowed(res, 'POST');
        else if (!store) sendJson(res, 403, { error: tr('anexos desligados') });
        else
          readJson(req, ATTACHMENT_BODY_MAX)
            .then((body) => {
              const a = parseAttachment(body);
              if ('error' in a) return sendJson(res, 400, { error: a.error });
              const r = store.put(a);
              if ('error' in r) return sendJson(res, 429, { error: r.error });
              sendJson(res, 201, { id: r.id, name: a.name, size: a.data.length });
            })
            .catch((err) => fail(res, err));
      }
      else if (path === '/api/spawn' && method === 'POST') {
        readJson(req)
          .then((body) => {
            const r = spawn.submit(body);
            if ('spawn' in r) return sendJson(res, 201, r.spawn);
            sendJson(res, r.error === 'invalid' ? 400 : r.error === 'too-many' ? 429 : 409, { error: r.reason });
          })
          .catch((err) => fail(res, err));
      } else if (path !== '/api/spawn' && isRead) {
        const info = spawn.get(decodeURIComponent(path.slice('/api/spawn/'.length)));
        if (info) sendJson(res, 200, info);
        else sendJson(res, 404, { error: tr('pedido desconhecido') });
      } else methodNotAllowed(res, path === '/api/spawn' ? 'GET, POST' : 'GET');
      return true;
    }
    if (path === '/api/dictation' || path.startsWith('/api/dictation/')) {
      // Dictation for "New agent" and message box: allowed with either lock (transcribed text becomes a spawn
      // request or message, which enforce their respective locks upon dispatch).
      const dictation = deps.dictation;
      if (!dictation) sendJson(res, 403, { error: tr('ditado desligado') });
      else if (!trusted(req, 'spawn') && !trusted(req, 'messages')) {
        sendJson(res, 403, { error: denied(req, tr('o ditado só funciona pelo próprio computador (http://localhost)')) });
      }
      else if (path === '/api/dictation' && isRead) sendJson(res, 200, { available: dictation.available() });
      else if (path === '/api/dictation' && method === 'POST') {
        readJson(req, AUDIO_BODY_MAX)
          .then((body) => {
            const r = dictation.submit(body);
            if ('dictation' in r) return sendJson(res, 201, r.dictation);
            sendJson(res, r.error === 'invalid' ? 400 : r.error === 'too-many' ? 429 : 409, { error: r.reason });
          })
          .catch((err) => fail(res, err));
      } else if (path !== '/api/dictation' && isRead) {
        const info = dictation.get(decodeURIComponent(path.slice('/api/dictation/'.length)));
        if (info) sendJson(res, 200, info);
        else sendJson(res, 404, { error: tr('ditado desconhecido') });
      } else methodNotAllowed(res, path === '/api/dictation' ? 'GET, POST' : 'GET');
      return true;
    }
    if (path === '/api/deliveries' || path.startsWith('/api/deliveries/')) {
      // Deliveries display full response and agent files: same lock as terminal.
      const deliveries = deps.deliveries;
      if (!deliveries) sendJson(res, 403, { error: tr('entregas desligadas (precisam do terminal: acesso local)') });
      else if (!isRead) methodNotAllowed(res, 'GET');
      else if (!trusted(req, 'terminal')) sendJson(res, 403, { error: denied(req, tr('as entregas só abrem pelo próprio computador (http://localhost)')) });
      else if (path === '/api/deliveries') deliveries.list().then((list) => sendJson(res, 200, { deliveries: list }), (err) => fail(res, err));
      else if (path.startsWith('/api/deliveries/file/')) {
        const att = deliveries.attachment(decodeURIComponent(path.slice('/api/deliveries/file/'.length)));
        if (!att) sendJson(res, 404, { error: tr('anexo desconhecido: atualize a lista de entregas') });
        else if (att.kind === 'capture') sendFile(res, att.data, att.type, att.name);
        else if (!deps.files) sendJson(res, 404, { error: tr('arquivos desligados') });
        else
          deps.files.get(att.path).then(
            (r) => ('data' in r ? sendFile(res, r.data, att.type, att.name) : sendJson(res, r.status, { error: r.error })),
            (err) => fail(res, err),
          );
      } else sendJson(res, 404, { error: tr('rota desconhecida') });
      return true;
    }
    if (path === '/api/host/files/poll' || path === '/api/host/files/ack') {
      // Strictly host helper via local port (never remote); outside Docker, loopback only.
      const files = deps.files;
      if (method !== 'POST') methodNotAllowed(res, 'POST');
      else if (!files) sendJson(res, 403, { error: tr('arquivos desligados') });
      else if (!trusted(req) || (!deps.inDocker && !isLoopbackAddress(req.socket.remoteAddress))) {
        sendJson(res, 403, { error: denied(req, tr('só o auxiliar do próprio computador')) });
      } else if (path === '/api/host/files/poll') {
        req.resume();
        hostWait(res, url, (ms, signal) => files.pollWait(ms, signal)).then((list) => list && sendJson(res, 200, { files: list }), (err) => fail(res, err));
      } else {
        readJson(req, 36 * 1024 * 1024)
          .then((body) => {
            files.ack(body);
            sendJson(res, 200, { ok: true });
          })
          .catch((err) => fail(res, err));
      }
      return true;
    }
    if (path === '/api/host/dictation/poll' || path === '/api/host/dictation/ack') {
      // Strictly host helper via local port (never remote); outside Docker, loopback only.
      const dictation = deps.dictation;
      if (method !== 'POST') methodNotAllowed(res, 'POST');
      else if (!dictation) sendJson(res, 403, { error: tr('ditado desligado') });
      else if (!trusted(req) || (!deps.inDocker && !isLoopbackAddress(req.socket.remoteAddress))) {
        sendJson(res, 403, { error: denied(req, tr('só o auxiliar do próprio computador')) });
      } else if (path === '/api/host/dictation/poll') {
        req.resume();
        hostWait(res, url, (ms, signal) => dictation.pollWait(ms, signal)).then((list) => list && sendJson(res, 200, { dictations: list }), (err) => fail(res, err));
      } else {
        readJson(req, 512 * 1024)
          .then((body) => {
            dictation.ack(body);
            sendJson(res, 200, { ok: true });
          })
          .catch((err) => fail(res, err));
      }
      return true;
    }
    if (path === '/api/host/spawn/poll' || path === '/api/host/spawn/ack') {
      // Strictly host helper via local port (never remote); outside Docker, loopback only.
      const spawn = deps.spawn;
      if (method !== 'POST') methodNotAllowed(res, 'POST');
      else if (!spawn) sendJson(res, 403, { error: tr('novo agente pelo escritório desligado') });
      else if (!trusted(req) || (!deps.inDocker && !isLoopbackAddress(req.socket.remoteAddress))) {
        sendJson(res, 403, { error: denied(req, tr('só o auxiliar do próprio computador')) });
      } else if (path === '/api/host/spawn/poll') {
        req.resume();
        sendJson(res, 200, { spawns: spawn.poll() });
      } else {
        readJson(req)
          .then((body) => {
            spawn.ack(body);
            sendJson(res, 200, { ok: true });
          })
          .catch((err) => fail(res, err));
      }
      return true;
    }
    if (isMessagesPath(path)) {
      // Messages enter session as if typed by user: same lock (feature enabled + local Host).
      if (!deps.messages) {
        sendJson(res, 403, {
          error: tr('mensagens pelo escritório desligadas: só funcionam com o Habblaud acessível apenas pelo próprio computador (e sem HABBLAUD_MENSAGENS=0)'),
        });
      } else if (!trusted(req, 'messages')) {
        sendJson(res, 403, { error: denied(req, tr('mensagens só são mandadas pelo próprio computador (http://localhost ou http://127.0.0.1)')) });
      } else {
        deps.messages(req, res, path);
      }
      return true;
    }
    if (path.startsWith('/api/agents/')) {
      if (!isRead) {
        methodNotAllowed(res, 'GET');
        return true;
      }
      let id: string;
      try {
        id = decodeURIComponent(path.slice('/api/agents/'.length));
      } catch {
        sendJson(res, 400, { error: tr('id inválido') });
        return true;
      }
      const detail = office.detail(id);
      if (detail) sendJson(res, 200, detail);
      else sendJson(res, 404, { error: tr('agente não encontrado') });
      return true;
    }
    if (path === '/api/rooms/rename') {
      // Like character editing: same lock as terminal (local bind + local Host).
      if (method !== 'POST') methodNotAllowed(res, 'POST');
      else if (!deps.terminal) sendJson(res, 403, { error: tr('renomear salas desligado: só funciona com o Habblaud acessível apenas pelo próprio computador') });
      else if (!trusted(req)) sendJson(res, 403, { error: denied(req, tr('renomear salas só pelo próprio computador (http://localhost)')) });
      else
        readJson(req)
          .then((body) => {
            const b = body as { id?: unknown; name?: unknown };
            if (typeof b?.id !== 'string' || typeof b.name !== 'string') throw new HttpError(400, tr('esperado {id, name}'));
            const name = deps.renameRoom?.(b.id, b.name);
            if (name === undefined) throw new HttpError(404, tr('sala não encontrada'));
            sendJson(res, 200, { name });
          })
          .catch((err) => fail(res, err));
      return true;
    }
    if (path === '/api/stats' || path.startsWith('/api/stats/')) {
      handleStatsRoute(req, res, url, deps.stats, sendJson);
      return true;
    }
    if (path === '/api/demo') {
      // Enables demo mode globally: local computer only (authenticated remote client only sees allowed features).
      if (method !== 'POST') methodNotAllowed(res, 'POST');
      else if (isRemote(req)) sendJson(res, 403, { error: tr('não liberado no acesso remoto (veja HABBLAUD_REMOTE_ALLOW)') });
      else handleDemo(req, res).catch((err) => fail(res, err));
      return true;
    }
    if (path === '/api/updates') {
      if (!isRead) methodNotAllowed(res, 'GET');
      else sendJson(res, 200, { version: deps.version, ...(deps.updates?.status() ?? { state: 'off', available: false }) });
      return true;
    }
    if (path === '/api/updates/check') {
      // "Check now": queries GitHub (at most once every 30 s) and returns updated status.
      if (method !== 'POST') methodNotAllowed(res, 'POST');
      else {
        req.resume();
        const updates = deps.updates;
        if (!updates) sendJson(res, 200, { version: deps.version, state: 'off', available: false });
        else
          updates
            .check({ manual: true })
            .then((status) => sendJson(res, 200, { version: deps.version, ...status }))
            .catch((err) => fail(res, err));
      }
      return true;
    }
    if (deps.timeline?.(req, res, url)) return true;
    sendJson(res, 404, { error: tr('rota desconhecida') });
    return true;
  };
}
