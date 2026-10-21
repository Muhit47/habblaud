// Office messaging routes. Security locks (feature enabled + local Host) already validated in http/app.ts;
// edge guard (http/guard.ts) already required JSON and local Origin on POST (CSRF protection).
//
//   POST /api/messages          (web app)     {agentId, text}: 201 OutboxMessage (queued) | 400 | 404 | 409 | 429
//   GET  /api/messages/:id      (web app)     message status: 200 OutboxMessage | 404
//   POST /api/mod/inbox         (plugin)      {session, account?}: 200 {messages: InboxMessage[]} (and marks presence)
//   POST /api/mod/inbox/ack     (plugin)      {session, results: [{id, ok, error?}]}: 200 {ok: true}
//   POST /api/codex/bridge/poll (host helper, npm run codex:bridge)
//                                             {}: 200 {messages: [{id, account, codexHome, thread, text}]} (marks presence)
//   POST /api/codex/bridge/ack  (helper)      {results: [{id, ok, error?}]}: 200 {ok: true}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, sendJson } from '../http/app';
import { InvalidRequest, MAX_OPEN, type MessageRegistry } from './registry';
import { tr } from '../../shared/i18n';

const ITEM = /^\/api\/messages\/([^/]+)$/;

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('Allow', allow);
  sendJson(res, 405, { error: tr('método não permitido') });
}

function fail(res: ServerResponse, err: unknown): void {
  if (res.headersSent) return void res.destroy();
  if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
  else if (err instanceof InvalidRequest) sendJson(res, 400, { error: err.message });
  else sendJson(res, 500, { error: tr('erro interno') });
}

export function createMessageRoutes(registry: MessageRegistry): (req: IncomingMessage, res: ServerResponse, path: string) => void {
  const send = async (req: IncomingMessage, res: ServerResponse) => {
    const r = registry.send(await readJson(req));
    if ('message' in r) return sendJson(res, 201, r.message);
    switch (r.error) {
      case 'not-found':
        return sendJson(res, 404, { error: tr('agente desconhecido: ele já saiu do escritório?') });
      case 'unavailable':
        return sendJson(res, 409, { error: r.reason });
      case 'too-many':
        return sendJson(res, 429, { error: tr('já há {0} mensagens esperando a entrega para este agente: espere a sessão buscar', [MAX_OPEN]) });
    }
  };

  const inbox = async (req: IncomingMessage, res: ServerResponse) => {
    sendJson(res, 200, { messages: registry.inbox(await readJson(req)) });
  };

  const ack = async (req: IncomingMessage, res: ServerResponse) => {
    registry.ack(await readJson(req));
    sendJson(res, 200, { ok: true });
  };

  const codexPoll = async (req: IncomingMessage, res: ServerResponse) => {
    sendJson(res, 200, { messages: registry.codexPoll(await readJson(req)) });
  };

  const codexAck = async (req: IncomingMessage, res: ServerResponse) => {
    registry.codexAck(await readJson(req));
    sendJson(res, 200, { ok: true });
  };

  const post = (req: IncomingMessage, res: ServerResponse, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
    if ((req.method ?? 'GET') !== 'POST') return methodNotAllowed(res, 'POST');
    handler(req, res).catch((err) => fail(res, err));
  };

  return (req, res, path) => {
    if (path === '/api/messages') return post(req, res, send);
    if (path === '/api/mod/inbox') return post(req, res, inbox);
    if (path === '/api/mod/inbox/ack') return post(req, res, ack);
    if (path === '/api/codex/bridge/poll') return post(req, res, codexPoll);
    if (path === '/api/codex/bridge/ack') return post(req, res, codexAck);
    const m = ITEM.exec(path);
    if (!m) return sendJson(res, 404, { error: tr('rota desconhecida') });
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET');
    let id: string;
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      return sendJson(res, 400, { error: tr('id inválido') });
    }
    const msg = registry.get(id);
    if (msg) sendJson(res, 200, msg);
    else sendJson(res, 404, { error: tr('mensagem desconhecida: ela já foi resolvida há mais de 10 min ou o Habblaud reiniciou') });
  };
}
