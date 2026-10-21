// "New agent" attachments (images and files sent from mobile/web with request). Desktop app deep link only
// supports text, so files are persisted on host at ~/.habblaud/attachments/<date>-<id>/, and prompt receives
// file list for agent to read. Persisted by dispatcher: server in Node mode, host helper (scripts/codex-bridge.ts)
// in Docker. Files uploaded as base64 JSON (guard requires JSON on all POSTs: CSRF protection).
// Pure Node zero-dependency: also imported by host helper (via tsx).
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tr } from '../../shared/i18n';

export const ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024;
export const ATTACHMENTS_PER_SPAWN = 8;
/** POST /api/spawn/attachments body: base64 payload (4/3) plus JSON framing overhead. */
export const ATTACHMENT_BODY_MAX = Math.ceil((ATTACHMENT_MAX_BYTES * 4) / 3) + 64 * 1024;
/** Uploaded attachments expire if unused; total buffered in memory is capped. */
export const ATTACHMENT_TTL_MS = 30 * 60_000;
/** Attachment memory ceiling: uploads awaiting spawn plus attachments held by pending requests (`held`). */
export const STORE_MAX_BYTES = 120 * 1024 * 1024;
const NAME_MAX = 120;

export interface Attachment {
  name: string;
  type: string;
  data: Buffer;
}

/** Safe filename for disk: basename only, no control chars or path separators, no leading dot. */
export function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  let name = base
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '');
  if (!name) name = 'arquivo';
  if (name.length > NAME_MAX) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = name.slice(0, NAME_MAX - ext.length) + ext;
  }
  return name;
}

/** Confere o corpo de POST /api/spawn/attachments: {name, type?, data (base64)}. */
export function parseAttachment(raw: unknown): Attachment | { error: string } {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const name = typeof r.name === 'string' ? safeFileName(r.name) : 'arquivo';
  const type = typeof r.type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(r.type) ? r.type : 'application/octet-stream';
  if (typeof r.data !== 'string' || !r.data) return { error: tr('arquivo vazio') };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(r.data)) return { error: tr('arquivo ilegível (base64)') };
  const data = Buffer.from(r.data, 'base64');
  if (!data.length) return { error: tr('arquivo vazio') };
  if (data.length > ATTACHMENT_MAX_BYTES) return { error: tr('o arquivo passa de {0} MB', [ATTACHMENT_MAX_BYTES / 1024 / 1024]) };
  return { name, type, data };
}

/** Uploaded attachments held in memory awaiting spawn request (ID returned to client). */
export class AttachmentStore {
  private readonly items = new Map<string, Attachment & { at: number }>();
  /** Bytes claimed by take() and retained in memory (queued request); released via release(). */
  private held = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID,
    private readonly maxBytes: number = STORE_MAX_BYTES,
  ) {}

  put(a: Attachment): { id: string } | { error: string } {
    this.prune();
    let total = a.data.length + this.held;
    for (const it of this.items.values()) total += it.data.length;
    if (total > this.maxBytes) return { error: tr('anexos demais esperando: envie o pedido ou tente de novo daqui a pouco') };
    const id = this.newId();
    this.items.set(id, { ...a, at: this.now() });
    return { id };
  }

  /** Claims attachments from store (each attachment serves one request). Unknown or expired IDs throw. */
  take(ids: unknown): Attachment[] | { error: string } {
    this.prune();
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) return { error: tr('anexos inválidos') };
    if (ids.length > ATTACHMENTS_PER_SPAWN) return { error: tr('no máximo {0} anexos por pedido', [ATTACHMENTS_PER_SPAWN]) };
    const out: Attachment[] = [];
    for (const id of ids as string[]) {
      const it = this.items.get(id);
      if (!it) return { error: tr('um anexo expirou: anexe de novo') };
      out.push({ name: it.name, type: it.type, data: it.data });
    }
    for (const id of ids as string[]) this.items.delete(id);
    this.held += out.reduce((n, f) => n + f.data.length, 0);
    return out;
  }

  /** Attachments retrieved by take() are evicted from memory (saved to disk, delivered to helper, or discarded). */
  release(bytes: number): void {
    this.held = Math.max(0, this.held - bytes);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, it] of this.items) if (now - it.at > ATTACHMENT_TTL_MS) this.items.delete(id);
  }
}

export function attachmentsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.HABBLAUD_ATTACHMENTS_DIR?.trim() || join(env.HOME || homedir(), '.habblaud', 'attachments');
}

function stamp(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
}

/** Writes attachments into fresh folder (mode 700; files 600) with unique names. Returns paths in order. */
export function writeAttachments(root: string, spawnId: string, files: readonly Attachment[], at = new Date()): string[] {
  if (!files.length) return [];
  const dir = join(root, `${stamp(at)}-${spawnId.replace(/[^\w-]/g, '').slice(0, 8) || 'pedido'}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const used = new Set<string>();
  return files.map((f) => {
    let name = safeFileName(f.name);
    if (used.has(name.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
      let n = 2;
      while (used.has(`${stem}-${n}${ext}`.toLowerCase())) n++;
      name = `${stem}-${n}${ext}`;
    }
    used.add(name.toLowerCase());
    const path = join(dir, name);
    writeFileSync(path, f.data, { mode: 0o600, flag: 'wx' });
    return path;
  });
}

/** Prompt formatted with appended attachment paths (agent inspects files via filesystem paths). */
export function promptWithAttachments(prompt: string, paths: readonly string[]): string {
  if (!paths.length) return prompt;
  const list = paths.map((p) => `- ${p}`).join('\n');
  const head = paths.length === 1 ? tr('Anexo enviado pelo Habblaud (leia antes de começar):') : tr('Anexos enviados pelo Habblaud (leia antes de começar):');
  return `${prompt.trim() ? `${prompt.trimEnd()}\n\n` : ''}${head}\n${list}`;
}
