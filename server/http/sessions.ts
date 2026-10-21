// Terminal history routes (/api/sessions/*):
//   GET /api/sessions/recent                       -> RecentSessionsResponse (sessions from last 7 days)
//   GET /api/sessions/:account/:sessionId/terminal -> SSE with same protocol as agent terminal
// Same lock as terminal (ServerConfig.terminal + local Host), because they expose titles and conversations.
// Account must be known, id must match UUID format, and transcript must reside within account directory
// (validated per tool: sources/history.ts for Claude Code): prevents path traversal.
// Listed and resolved by HistorySet (sources/source.ts), aggregating history across all tools.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RecentSessionsResponse } from '../../shared/types';
import { errMsg, log } from '../log';
import { HISTORY_DAYS, HISTORY_LIMIT } from '../sources/history';
import type { SessionLookup } from '../sources/source';
import { sendJson } from './app';
import { isLoopbackHost } from './guard';
import type { TerminalStreams } from './terminal';
import { tr } from '../../shared/i18n';

export interface SessionRoutesDeps {
  /** Missing = feature disabled (no local bind). */
  history?: SessionLookup;
  /** Missing = terminal disabled. */
  terminals?: TerminalStreams;
  /** Remote port (http/remote.ts): decision already evaluated by API; missing = local Host lock. */
  trusted?: boolean;
}

const RECENT_ROUTE = '/api/sessions/recent';
/** GET /api/sessions/:account/:sessionId/terminal (segments without '/'; %2F only after decoding). */
const TERMINAL_ROUTE = /^\/api\/sessions\/([^/]+)\/([^/]+)\/terminal$/;

/** Why lock rejects request (undefined = allowed): same messages as agent terminal. */
export function sessionsLockError(enabled: boolean, host: string | undefined, trusted?: boolean): string | undefined {
  if (!enabled) return tr('terminal desligado: ele só funciona com o Habblaud acessível apenas pelo próprio computador');
  if (trusted === false) return tr('não liberado no acesso remoto (veja HABBLAUD_REMOTE_ALLOW)');
  if (trusted === undefined && !isLoopbackHost(host)) return tr('o terminal só abre pelo próprio computador (http://localhost ou http://127.0.0.1)');
  return undefined;
}

function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** Handles /api/sessions/* (route already recognized by prefix in http/app.ts). */
export function handleSessionsRoute(req: IncomingMessage, res: ServerResponse, path: string, deps: SessionRoutesDeps): void {
  const method = req.method ?? 'GET';
  const terminalMatch = TERMINAL_ROUTE.exec(path);
  const recent = path === RECENT_ROUTE;
  if (!recent && !terminalMatch) return sendJson(res, 404, { error: tr('rota desconhecida') });
  if (method !== 'GET' && !(recent && method === 'HEAD')) {
    res.setHeader('Allow', recent ? 'GET, HEAD' : 'GET');
    return sendJson(res, 405, { error: tr('método não permitido') });
  }
  const { history, terminals } = deps;
  const locked = sessionsLockError(!!history && !!terminals, req.headers.host, deps.trusted);
  if (locked || !history || !terminals) return sendJson(res, 403, { error: locked });

  if (recent) {
    history
      .list()
      .then((sessions) => {
        const body: RecentSessionsResponse = { sessions, days: HISTORY_DAYS, limit: HISTORY_LIMIT };
        sendJson(res, 200, body);
      })
      .catch((err) => {
        log.warnOnce(`history-list:${errMsg(err)}`, tr('Histórico de sessões: falha ao listar ({0}).', [errMsg(err)]));
        if (!res.headersSent) sendJson(res, 500, { error: tr('não foi possível listar as sessões') });
      });
    return;
  }

  const account = decode(terminalMatch![1]);
  const sessionId = decode(terminalMatch![2]);
  if (account === undefined || sessionId === undefined) return sendJson(res, 400, { error: tr('endereço inválido') });
  const found = history.resolve(account, sessionId);
  if ('error' in found) return sendJson(res, found.status, { error: found.error });
  terminals.attachSession(req, res, `session:${account}:${sessionId}`, found.path, found.createParser);
}
