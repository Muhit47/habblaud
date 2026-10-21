// PermissionRequest hook (mod/habblaud-permissoes/hooks/permission-hook.mjs) executed as real process against
// test server: stdin JSON → expected output (allow, deny, "always allow", terminal fallback, answering
// AskUserQuestion options), immediate exit without decision when Habblaud is offline, disabled, or without open pages, and timeout.
// Asynchronous child processes (spawn): test server runs in same process.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { hookJson, MAIN, servePermissions, type PermissionServer } from './permission-server';

setQuiet(true);

const HOOK = resolve(__dirname, '../../mod/habblaud-permissoes/hooks/permission-hook.mjs');

/** Hook exported functions (pure JavaScript, untyped). */
interface HookModule {
  parseOptions(argv: string[], env: NodeJS.ProcessEnv): { port: number; timeoutMs: number };
  requestBody(input: Record<string, unknown>, timeoutMs: number): Record<string, unknown>;
  trimInput(v: unknown, max?: number): unknown;
  decisionOutput(result: unknown, input: unknown): unknown;
}
const { decisionOutput, parseOptions, requestBody, trimInput } = (await import(pathToFileURL(HOOK).href)) as HookModule;

/**
 * tool_input of AskUserQuestion. Returned `answers` are the ORIGINAL values (office only sees
 * masked representations): secret token in label confirms this. Entry 1 is invalid (skipped; positions indexed in original).
 */
const ASK = {
  questions: [
    { question: 'Qual banco usar?', header: 'Banco', multiSelect: false, options: [{ label: 'Postgres' }, { label: 'Bearer abcdef123456', description: 'o token' }] },
    null,
    { question: 'Quais testes rodar?', header: 'Testes', multiSelect: true, options: [{ label: 'Unidade' }, { label: 'E2E' }, { label: 'Lint' }] },
  ],
  metadata: { source: 'teste' },
};
const askJson = (over: Record<string, unknown> = {}) => hookJson({ tool_name: 'AskUserQuestion', tool_input: ASK, permission_suggestions: [], ...over });

interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function runHook(stdin: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<HookRun> {
  return new Promise((ok, fail) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [HOOK, ...args], { env: { PATH: process.env.PATH, HOME: '/nao/existe', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    const kill = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(kill);
      ok({ code, stdout, stderr, ms: Date.now() - t0 });
    });
    child.stdin.end(stdin);
  });
}

/** Waits until request appears in registry and returns its ID. */
async function pendingId(s: PermissionServer): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const id = s.registry!.snapshot().get(MAIN)?.id;
    if (id) return id;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error('o hook não registrou o pedido');
}

/** Free unallocated port (Habblaud "offline"). */
async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return port;
}

let srv: PermissionServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

describe('permission-hook.mjs (processo)', () => {
  it('aprovar pelo Habblaud: imprime a decisão allow e sai com 0', async () => {
    srv = await servePermissions();
    const run = runHook(JSON.stringify(hookJson()), ['--port', String(srv.port)]);
    const id = await pendingId(srv);
    expect(srv.registry!.decide(id, { behavior: 'allow' })).toBe('ok');
    const r = await run;
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  });

  it('"sempre permitir": aplica a sugestão ORIGINAL do stdin pela posição', async () => {
    srv = await servePermissions();
    const input = hookJson();
    const run = runHook(JSON.stringify(input), ['--port', String(srv.port)]);
    srv.registry!.decide(await pendingId(srv), { behavior: 'allow', suggestion: 0 });
    const out = JSON.parse((await run).stdout);
    expect(out.hookSpecificOutput.decision).toEqual({ behavior: 'allow', updatedPermissions: [(input.permission_suggestions as unknown[])[0]] });
  });

  it('recusar com motivo (e interromper): decisão deny com a mensagem para o agente', async () => {
    srv = await servePermissions();
    const run = runHook(JSON.stringify(hookJson()), [], { HABBLAUD_PORT: String(srv.port) });
    srv.registry!.decide(await pendingId(srv), { behavior: 'deny', message: 'use pnpm', interrupt: true });
    const r = await run;
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'Recusado pelo usuário no Habblaud: use pnpm', interrupt: true });
  });

  it('pergunta respondida no Habblaud: aprova com a entrada original mais `answers` (textos originais)', async () => {
    srv = await servePermissions();
    const run = runHook(JSON.stringify(askJson()), ['--port', String(srv.port)]);
    const id = await pendingId(srv);
    // Office only saw masked label.
    expect(JSON.stringify(srv.registry!.detail(id)!.questions)).not.toContain('abcdef123456');
    const answers = [{ question: 0, options: [1] }, { question: 2, options: [2, 0], other: 'e o build' }];
    expect(srv.registry!.decide(id, { behavior: 'answer', answers })).toBe('ok');
    const r = await run;
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          updatedInput: { ...ASK, answers: { 'Qual banco usar?': 'Bearer abcdef123456', 'Quais testes rodar?': 'Unidade, Lint, e o build' } },
        },
      },
    });
  });

  it('pergunta recusada no Habblaud: decisão deny (o agente segue sem a resposta)', async () => {
    srv = await servePermissions();
    const run = runHook(JSON.stringify(askJson()), ['--port', String(srv.port)]);
    srv.registry!.decide(await pendingId(srv), { behavior: 'deny', message: 'decida você' });
    expect(JSON.parse((await run).stdout).hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'Recusado pelo usuário no Habblaud: decida você' });
  });

  it('"responder no terminal": sai sem decisão (stdout vazio)', async () => {
    srv = await servePermissions();
    const run = runHook(JSON.stringify(hookJson()), ['--port', String(srv.port)]);
    srv.registry!.decide(await pendingId(srv), { behavior: 'terminal' });
    const r = await run;
    expect(r).toMatchObject({ code: 0, stdout: '' });
  });

  it('Habblaud fora do ar: sai rápido, sem decisão', async () => {
    const r = await runHook(JSON.stringify(hookJson()), ['--port', String(await deadPort())]);
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(3_000);
  });

  it('recurso desligado (403) ou ninguém olhando: sai na hora, sem decisão', async () => {
    srv = await servePermissions({ enabled: false });
    let r = await runHook(JSON.stringify(hookJson()), ['--port', String(srv.port)]);
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(3_000);
    await srv.close();
    srv = await servePermissions({ viewers: 0 });
    r = await runHook(JSON.stringify(hookJson()), ['--port', String(srv.port)]);
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(3_000);
    expect(srv.registry!.size).toBe(0);
  });

  it('stdin inválido, outro evento ou AskUserQuestion sem perguntas: sai sem decisão e sem pedido no Habblaud', async () => {
    srv = await servePermissions();
    for (const stdin of ['', 'não é json', '[]', JSON.stringify(hookJson({ hook_event_name: 'PreToolUse' })), JSON.stringify(hookJson({ tool_name: 'AskUserQuestion' }))]) {
      const r = await runHook(stdin, ['--port', String(srv.port)]);
      expect(r, stdin).toMatchObject({ code: 0, stdout: '' });
    }
    expect(srv.registry!.size).toBe(0);
  });

  it('tempo limite (--timeout): desiste, sai sem decisão e o pedido some do escritório', async () => {
    srv = await servePermissions({ registry: { orphanMs: 300 } });
    const r = await runHook(JSON.stringify(hookJson()), ['--port', String(srv.port), '--timeout', '5']);
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeGreaterThanOrEqual(4_500);
    expect(r.ms).toBeLessThan(12_000);
    await new Promise((ok) => setTimeout(ok, 600));
    expect(srv.registry!.size).toBe(0);
  }, 20_000);
});

describe('permission-hook.mjs (funções)', () => {
  it('parseOptions: argumentos, ambiente e limites', () => {
    expect(parseOptions([], {})).toEqual({ port: 4747, timeoutMs: 300_000 });
    expect(parseOptions(['--port', '4851', '--timeout', '60'], {})).toEqual({ port: 4851, timeoutMs: 60_000 });
    expect(parseOptions([], { HABBLAUD_PORT: '4848', HABBLAUD_PERMISSION_TIMEOUT: '1' })).toEqual({ port: 4848, timeoutMs: 5_000 });
    expect(parseOptions(['--port', 'x', '--timeout', '99999'], {})).toEqual({ port: 4747, timeoutMs: 86_400_000 });
  });

  it('requestBody: só o que o Habblaud usa, com textos cortados', () => {
    const body = requestBody(hookJson({ agent_id: 'a1', agent_type: 'Explore', tool_input: { content: 'x'.repeat(20_000) } }), 60_000);
    expect(Object.keys(body).sort()).toEqual(['agent_id', 'agent_type', 'cwd', 'permission_suggestions', 'session_id', 'timeout_ms', 'tool_input', 'tool_name']);
    expect((body.tool_input as { content: string }).content.length).toBe(8_000);
    expect(trimInput({ a: [{ b: 'y'.repeat(9_000) }] })).toEqual({ a: [{ b: 'y'.repeat(8_000) }] });
    // Bulk edits: truncated shorter to respect server payload limits.
    const edits = Array.from({ length: 60 }, () => ({ old_string: 'o'.repeat(10_000), new_string: 'n'.repeat(10_000) }));
    const big = requestBody(hookJson({ tool_name: 'MultiEdit', tool_input: { file_path: '/a.ts', edits } }), 60_000);
    expect(JSON.stringify(big).length).toBeLessThan(200_000);
    expect((big.tool_input as { edits: Array<{ old_string: string }> }).edits[0].old_string.length).toBe(1_000);
  });

  it('decisionOutput: allow/deny no formato do hook; o resto = sem decisão', () => {
    expect(decisionOutput({ status: 'decided', behavior: 'allow', suggestion: 5 }, hookJson())).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(decisionOutput({ status: 'decided', behavior: 'deny' }, hookJson())).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Recusado pelo usuário no Habblaud.' } },
    });
    expect(decisionOutput({ status: 'released', reason: 'terminal' }, hookJson())).toBeUndefined();
    expect(decisionOutput({ status: 'pending' }, hookJson())).toBeUndefined();
    expect(decisionOutput(undefined, hookJson())).toBeUndefined();
  });

  it('decisionOutput: answer troca as posições pelos textos originais; o que não dá para responder = sem decisão', () => {
    const out = (answers: unknown, input: Record<string, unknown> = askJson()) =>
      decisionOutput({ status: 'decided', behavior: 'answer', answers }, input) as { hookSpecificOutput: { decision: { behavior: string; updatedInput: { answers: unknown } } } } | undefined;
    const ok = out([{ question: 2, options: [1] }, { question: 0, other: 'MySQL' }])!;
    expect(ok.hookSpecificOutput.decision.behavior).toBe('allow');
    expect(ok.hookSpecificOutput.decision.updatedInput).toEqual({ ...ASK, answers: { 'Quais testes rodar?': 'E2E', 'Qual banco usar?': 'MySQL' } });
    const single = { question: 0, options: [0] };
    for (const bad of [
      [single], // falta a pergunta 2
      [single, { question: 2, options: [0] }, { question: 2, options: [1] }],
      [single, { question: 1, options: [0] }], // invalid entry in original
      [single, { question: 2, options: [3] }],
      [single, { question: 2, options: [-1] }],
      [single, { question: 2, options: ['0'] }],
      [single, { question: 2 }],
      [{ question: 0, options: [0, 1] }, { question: 2, options: [0] }], // single choice with two selections
      [{ question: 0, options: [0], other: 'e mais' }, { question: 2, options: [0] }],
      [],
      undefined,
    ]) {
      expect(out(bad), JSON.stringify(bad)).toBeUndefined();
    }
    // Input without questions, other tool, questions sharing same text.
    expect(out([single], askJson({ tool_input: {} }))).toBeUndefined();
    expect(out([single], hookJson())).toBeUndefined();
    const twin = { questions: [{ question: 'Igual?', options: [{ label: 'A' }] }, { question: 'Igual?', options: [{ label: 'B' }] }] };
    expect(out([single, { question: 1, options: [0] }], askJson({ tool_input: twin }))).toBeUndefined();
    // Approving without answers does not resolve question: no decision. Deny is valid.
    expect(decisionOutput({ status: 'decided', behavior: 'allow' }, askJson())).toBeUndefined();
    expect(decisionOutput({ status: 'decided', behavior: 'deny' }, askJson())).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });
  });
});
