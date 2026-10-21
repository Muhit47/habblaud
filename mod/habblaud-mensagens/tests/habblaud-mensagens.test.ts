// Messaging plugin tests, executed by Claude Code CLI: `claude plugin test` inside
// mod/habblaud-mensagens (isolated, without session, auth, or network). Stubs mock Claude Code and
// Habblaud: env, clock (mock.clock), $.session.id, $.session.surfaces, $.http.fetch (both server
// routes), and low-level prompt.submit (session: accepts, hook rejects, call throws, or hangs).
import type { HttpResponse, On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import { accountIdOf, ackBody, configDirOf, inboxBody, MAX_REASON, normalizePath, parseInbox, portOf, reasonText, type InboxMessage } from '../hooks/register'

const NOW = Date.parse('2026-10-09T12:00:00Z')
const PORT = '4850'
const INBOX_URL = `http://127.0.0.1:${PORT}/api/mod/inbox`
const ACK_URL = `${INBOX_URL}/ack`
const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' }

/** Habblaud response to inbox: messages, 'offline' (refused), 'hang' (timeout), or raw HTTP. */
type Answer = InboxMessage[] | 'offline' | 'hang' | { status: number; text: string }
/** Session response to a prompt: accepted, hook rejects, call throws, or hangs (busy session). */
type Fate = 'ok' | 'drop' | 'throw' | 'hang'

interface World {
  env?: Record<string, string>
  surfaces?: ReadonlyArray<'terminal' | 'desktop'>
  /** Default: no messages. */
  inbox?: () => Answer
  /** Default: ack responds 200. */
  ack?: () => 'ok' | 'offline' | 'hang'
  /** Default: 'ok'. */
  fate?: (text: string) => Fate
}

interface Sent {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
}

function response(status: number, text: string): HttpResponse {
  return { status, ok: status >= 200 && status < 300, headers: { 'content-type': 'application/json' }, text }
}

/** Response queue: each poll takes next response; empty returns no messages. */
function batches(...list: Answer[]): () => Answer {
  return () => list.shift() ?? []
}

/** Registers all stubs (prior to first $ invocation, required by kit) and returns recorded calls. */
function world(on: On, w: World = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, w.env ?? { HOME: '/home/fulano', CLAUDE_CONFIG_DIR: '~/.claude-conta2', HABBLAUD_PORT: PORT })
  const sent: Sent[] = []
  const submits: Array<{ text: string; origin: unknown }> = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.surfaces', () => ({ value: w.surfaces ?? ['terminal'] }))
  on('http.fetch', async ($, e) => {
    const body = e.init?.body
    sent.push({ url: e.url, method: e.init?.method, headers: e.init?.headers, body: body === undefined ? undefined : JSON.parse(body) })
    if (e.url.endsWith('/ack')) {
      const a = w.ack ? w.ack() : 'ok'
      if (a === 'offline') return { deny: 'connect ECONNREFUSED 127.0.0.1:4850' }
      if (a === 'hang') {
        await clock.sleep(60_000)
        return { deny: 'tarde demais' }
      }
      return { value: response(200, '{"ok":true}') }
    }
    const a = w.inbox ? w.inbox() : []
    if (a === 'offline') return { deny: 'connect ECONNREFUSED 127.0.0.1:4850' }
    if (a === 'hang') {
      await clock.sleep(60_000)
      return { deny: 'tarde demais' }
    }
    return { value: Array.isArray(a) ? response(200, JSON.stringify({ messages: a })) : response(a.status, a.text) }
  })
  on('prompt.submit', async ($, e) => {
    submits.push({ text: e.text, origin: e.origin })
    const fate = w.fate ? w.fate(e.text) : 'ok'
    if (fate === 'drop') return { drop: `recusada por um hook: ${e.text}` }
    if (fate === 'throw') throw new Error('a sessão\nfechou')
    if (fate === 'hang') await clock.sleep(60_000)
    return { text: e.text }
  })
  return {
    clock,
    sent,
    submits,
    inboxes: () => sent.filter((s) => s.url === INBOX_URL),
    acks: () => sent.filter((s) => s.url === ACK_URL),
    texts: () => submits.map((s) => s.text),
  }
}

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

describe('rodadas', () => {
  test('a cada 2 s pergunta ao Habblaud (marca a presença); sem mensagens, nada vai para a sessão e não há ack', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    expect(w.sent).toEqual([])
    await w.clock.advance(2_000)
    expect(w.sent).toEqual([{ url: INBOX_URL, method: 'POST', headers: JSON_HEADERS, body: { session: 'sess-1', account: '.claude-conta2' } }])
    await w.clock.advance(4_000)
    expect(w.inboxes().length).toBe(3)
    expect(w.acks()).toEqual([])
    expect(w.submits).toEqual([])
  })

  test('entrega na ordem, como se você tivesse digitado (texto intacto), e confirma tudo num POST só', async ($, on) => {
    const typed = '  e depois:\n- abre o PR\n\n(sem pressa)  '
    const w = world(on, { inbox: batches([{ id: 'm1', text: 'roda os testes' }, { id: 'm2', text: typed }]) })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.texts()).toEqual(['roda os testes', typed])
    expect(w.submits[0]?.origin).toEqual({ kind: 'plugin', name: 'habblaud-mensagens', asUser: true })
    expect(w.acks()).toEqual([{ url: ACK_URL, method: 'POST', headers: JSON_HEADERS, body: { session: 'sess-1', results: [{ id: 'm1', ok: true }, { id: 'm2', ok: true }] } }])
    await w.clock.advance(2_000)
    expect(w.sent.map((s) => s.url)).toEqual([INBOX_URL, ACK_URL, INBOX_URL])
    expect(w.submits.length).toBe(2)
  })

  test('recusa de um hook e exceção viram falha com o motivo; sem texto, falha sem ir para a sessão', async ($, on) => {
    const raw = JSON.stringify({
      messages: [
        { id: 'a', text: 'pode ir' },
        { id: 'b', text: 'proibida' },
        { id: 'c', text: 'quebra' },
        { id: 'd', text: '  \n ' },
        { id: 'e', text: 42 },
        // without id: cannot acknowledge, excluded
        { text: 'órfã' },
      ],
    })
    const w = world(on, {
      inbox: batches({ status: 200, text: raw }),
      fate: (t) => (t === 'proibida' ? 'drop' : t === 'quebra' ? 'throw' : 'ok'),
    })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.texts()).toEqual(['pode ir', 'proibida', 'quebra'])
    expect(w.acks()[0]?.body).toEqual({
      session: 'sess-1',
      results: [
        { id: 'a', ok: true },
        { id: 'b', ok: false, error: 'recusada por um hook: proibida' },
        // Lower throwing hook is skipped; with nothing below it, the call rejects: reason comes from kit.
        { id: 'c', ok: false, error: expect.stringMatching(/\S/) },
        { id: 'd', ok: false, error: 'mensagem vazia' },
        { id: 'e', ok: false, error: 'mensagem vazia' },
      ],
    })
  })

  test('sessão ocupada: passou de 2 s, conta como entregue e as seguintes vão em seguida, na ordem; as rodadas seguem', async ($, on) => {
    const w = world(on, {
      inbox: batches([
        { id: 'm1', text: 'primeira' },
        { id: 'm2', text: 'segunda' },
        { id: 'm3', text: 'terceira' },
      ]),
      fate: (t) => (t === 'primeira' ? 'hang' : 'ok'),
    })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.texts()).toEqual(['primeira'])
    expect(w.acks()).toEqual([])
    await w.clock.advance(2_000)
    expect(w.texts()).toEqual(['primeira', 'segunda', 'terceira'])
    expect(w.acks().map((a) => a.body)).toEqual([
      {
        session: 'sess-1',
        results: [
          { id: 'm1', ok: true },
          { id: 'm2', ok: true },
          { id: 'm3', ok: true },
        ],
      },
    ])
    const asked = w.inboxes().length
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBeGreaterThan(asked)
  })

  test('uma rodada por vez: com a sessão ocupada e o ack travado, a pergunta do meio é pulada', async ($, on) => {
    const w = world(on, { inbox: batches([{ id: 'm1', text: 'primeira' }]), fate: () => 'hang', ack: () => 'hang' })
    await $.session.start(START)
    await w.clock.advance(2_000)
    // Round spans from 2 s (poll) to 4 s (submit deadline) to 6 s (ack deadline): 4 s pass does not start.
    await w.clock.advance(3_000)
    expect(w.inboxes().length).toBe(1)
    expect(w.acks().length).toBe(1)
    await w.clock.advance(3_000)
    expect(w.inboxes().length).toBeGreaterThan(1)
    expect(w.texts()).toEqual(['primeira'])
  })

  test('ack que falha = silêncio: as rodadas seguem', async ($, on) => {
    const w = world(on, { inbox: batches([{ id: 'm1', text: 'oi' }]), ack: () => 'offline' })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.acks().length).toBe(1)
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(2)
    expect(w.texts()).toEqual(['oi'])
  })

  test('Habblaud fora do ar, 403 (mensagens desligadas) ou 404 (versão sem a rota): recua para 30 s até voltar', async ($, on) => {
    let answer: Answer = 'offline'
    const w = world(on, { inbox: () => answer })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(1)
    await w.clock.advance(28_000)
    expect(w.inboxes().length).toBe(1)
    answer = { status: 403, text: '{"error":"mensagens pelo escritório desligadas"}' }
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(2)
    answer = { status: 404, text: '{"error":"rota desconhecida"}' }
    await w.clock.advance(30_000)
    expect(w.inboxes().length).toBe(3)
    answer = []
    await w.clock.advance(30_000)
    expect(w.inboxes().length).toBe(4)
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(5)
    expect(w.acks()).toEqual([])
  })

  test('Habblaud travado: desiste em 2 s e recua para 30 s', async ($, on) => {
    let hang = true
    const w = world(on, { inbox: () => (hang ? 'hang' : []) })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(1)
    await w.clock.advance(31_000)
    expect(w.inboxes().length).toBe(1)
    hang = false
    await w.clock.advance(1_000)
    expect(w.inboxes().length).toBe(2)
  })

  test('sessão sem superfície (claude -p, SDK): nem pergunta ao Habblaud', async ($, on) => {
    const w = world(on, { surfaces: [] })
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await w.clock.advance(10_000)
    expect(w.sent).toEqual([])
  })

  test('sessão do app desktop fora da tela (SDK sem superfície): pergunta mesmo assim', async ($, on) => {
    const w = world(on, { surfaces: [], env: { HOME: '/home/fulano', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', HABBLAUD_PORT: PORT } })
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(1)
  })

  test('sem HOME nem CLAUDE_CONFIG_DIR: pergunta sem a conta, na porta padrão', async ($, on) => {
    const w = world(on, { env: {} })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.sent).toEqual([{ url: 'http://127.0.0.1:4747/api/mod/inbox', method: 'POST', headers: JSON_HEADERS, body: { session: 'sess-1' } }])
  })
})

describe('funções puras', () => {
  test('inbox: formato estranho = fora do ar; item sem id fica de fora; sem texto vira texto vazio', () => {
    expect(parseInbox('<html>')).toBeUndefined()
    expect(parseInbox('[]')).toBeUndefined()
    expect(parseInbox('{"messages":{}}')).toBeUndefined()
    expect(parseInbox('{"messages":[]}')).toEqual([])
    expect(parseInbox(JSON.stringify({ messages: [{ id: 'a', text: ' x\n' }, { id: '', text: 'y' }, { text: 'z' }, null, { id: 'b' }] }))).toEqual([
      { id: 'a', text: ' x\n' },
      { id: 'b', text: '' },
    ])
  })

  test('corpos das duas rotas', () => {
    expect(JSON.parse(inboxBody('s', '.claude'))).toEqual({ session: 's', account: '.claude' })
    expect(JSON.parse(inboxBody('s', undefined))).toEqual({ session: 's' })
    expect(JSON.parse(ackBody('s', [{ id: 'a', ok: true }, { id: 'b', ok: false, error: 'não' }]))).toEqual({
      session: 's',
      results: [
        { id: 'a', ok: true },
        { id: 'b', ok: false, error: 'não' },
      ],
    })
  })

  test('motivo da falha: uma linha, tamanho limitado, e o padrão quando não há texto', () => {
    expect(reasonText('um\nhook\t recusou ', 'padrão')).toBe('um hook recusou')
    expect(reasonText(new Error('boom'), 'padrão')).toBe('boom')
    expect(reasonText({ message: 'de outro mundo' }, 'padrão')).toBe('de outro mundo')
    expect(reasonText('   ', 'padrão')).toBe('padrão')
    expect(reasonText(undefined, 'padrão')).toBe('padrão')
    const long = reasonText('x'.repeat(2_000), 'padrão')
    expect(long.length).toBe(MAX_REASON)
    expect(long.endsWith('…')).toBe(true)
  })

  test('conta e porta como o mod habblaud calcula (também no Windows)', () => {
    expect(normalizePath('/a//b/./c/../d/')).toBe('/a/b/d')
    expect(configDirOf(' ~/.claude-conta2 , /x', '/home/f')).toBe('/home/f/.claude-conta2')
    expect(configDirOf(undefined, '/home/f/')).toBe('/home/f/.claude')
    expect(configDirOf('', undefined)).toBeUndefined()
    expect(configDirOf('C:\\Users\\f\\.claude-conta2\\', undefined)).toBe('C:/Users/f/.claude-conta2')
    expect(accountIdOf('C:/Users/f/.claude-conta2')).toBe('.claude-conta2')
    expect(accountIdOf('/')).toBeUndefined()
    expect(portOf('4850')).toBe(4850)
    expect(portOf('0')).toBe(4747)
    expect(portOf('abc')).toBe(4747)
    expect(portOf(undefined)).toBe(4747)
  })
})
