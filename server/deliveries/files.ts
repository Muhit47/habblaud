// Delivery files: previewable assets presented in the office. Strictly files delivered by agent itself
// (server requests paths present in deliveries only), limited to viewable MIME types (images, PDFs, videos,
// pages, text) and never security-sensitive files (.ssh, .env, keys, credentials...). Read by server
// (Node mode or Docker mount) or host bridge (scripts/codex-bridge.ts) validating paths prior to reads.
// Pure Node zero-dependency: also imported by host bridge (via tsx).
import { existsSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DeliveryAttachmentKind } from '../../shared/types';
import { tr } from '../../shared/i18n';

export const DELIVERY_FILE_MAX_BYTES = 25 * 1024 * 1024;

const TYPES: Readonly<Record<string, { kind: DeliveryAttachmentKind; type: string }>> = {
  png: { kind: 'image', type: 'image/png' },
  jpg: { kind: 'image', type: 'image/jpeg' },
  jpeg: { kind: 'image', type: 'image/jpeg' },
  gif: { kind: 'image', type: 'image/gif' },
  webp: { kind: 'image', type: 'image/webp' },
  svg: { kind: 'image', type: 'image/svg+xml' },
  pdf: { kind: 'pdf', type: 'application/pdf' },
  mp4: { kind: 'video', type: 'video/mp4' },
  mov: { kind: 'video', type: 'video/quicktime' },
  webm: { kind: 'video', type: 'video/webm' },
  html: { kind: 'page', type: 'text/html; charset=utf-8' },
  htm: { kind: 'page', type: 'text/html; charset=utf-8' },
  md: { kind: 'text', type: 'text/plain; charset=utf-8' },
  txt: { kind: 'text', type: 'text/plain; charset=utf-8' },
  csv: { kind: 'text', type: 'text/plain; charset=utf-8' },
  log: { kind: 'text', type: 'text/plain; charset=utf-8' },
  xlsx: { kind: 'file', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  docx: { kind: 'file', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  pptx: { kind: 'file', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  zip: { kind: 'file', type: 'application/zip' },
};

/** Directory and file patterns never exposed, even if referenced by agent (e.g. prompt-injected text). */
const SECRET_DIRS = /(^|\/)(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.password-store|\.config\/gh|\.config\/gcloud|Keychains|\.habblaud\/remote-tls)(\/|$)/i;
const SECRET_NAMES = /(^|\/)(\.env[^/]*|id_[a-z0-9]+|[^/]*\.(pem|key|p12|pfx|keystore|jks|kdbx)|[^/]*(secret|credential|password|senha|token)[^/]*)$/i;

export function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Preview kind and Content-Type, or undefined if extension is not previewable. */
export function fileType(path: string): { kind: DeliveryAttachmentKind; type: string } | undefined {
  return TYPES[extensionOf(path)];
}

/** Reason path is rejected for preview (lexical inspection), or undefined. */
export function pathProblem(path: string): string | undefined {
  const normPath = path.replace(/\\/g, '/');
  if (!path || path.includes('\0') || (!normPath.startsWith('/') && !/^[a-zA-Z]:\//.test(normPath)) || /(^|\/)\.\.(\/|$)/.test(normPath)) return tr('caminho inválido');
  if (!fileType(path)) return tr('tipo de arquivo que não se mostra aqui');
  if (SECRET_DIRS.test(path) || SECRET_NAMES.test(path)) return tr('arquivo protegido');
  return undefined;
}

/** Validates on disk (resolves symlinks, file size, regular file). Returns real path or error reason. */
export function checkFile(
  path: string,
  fs: { realpath(p: string): string; stat(p: string): { isFile(): boolean; size: number } } = { realpath: realpathSync, stat: statSync },
): { path: string; size: number } | { error: string } {
  const bad = pathProblem(path);
  if (bad) return { error: bad };
  let real: string;
  let st: { isFile(): boolean; size: number };
  try {
    real = fs.realpath(path);
    st = fs.stat(real);
  } catch {
    return { error: tr('arquivo não encontrado') };
  }
  const realBad = pathProblem(real);
  if (realBad) return { error: realBad };
  if (!st.isFile()) return { error: tr('não é um arquivo') };
  if (st.size > DELIVERY_FILE_MAX_BYTES) return { error: tr('arquivo grande demais para ver aqui') };
  return { path: real, size: st.size };
}

/** Temporary directories where agents save scratch files and screenshots (OS tmp and standard macOS/Linux paths). */
export function tempRoots(): string[] {
  const out = new Set<string>(['/tmp', '/private/tmp', '/var/folders', '/private/var/folders']);
  try {
    out.add(realpathSync(tmpdir()));
  } catch {
    out.add(tmpdir());
  }
  return [...out];
}

/**
 * File (real path) resides in allowed folder readable by host bridge: a project folder known to any
 * Claude Code account (<account>/projects/<encoded-cwd>) or allowed `roots` (temp folders, Habblaud attachments),
 * ensuring requests from container cannot escape into unauthorized host directories.
 */
export function insideKnownFolder(
  path: string,
  opts: { accountDirs: readonly string[]; roots: readonly string[]; exists?: (p: string) => boolean },
): boolean {
  if (opts.roots.some((r) => r && path.startsWith(`${r.replace(/\/+$/, '')}/`))) return true;
  const exists = opts.exists ?? existsSync;
  // Same encoding as sources/watcher.ts (encodeCwd): non-alphanumeric chars map to "-".
  const nPath = path.replace(/\\/g, '/');
  for (let dir = dirname(nPath).replace(/\\/g, '/'); dir.split('/').filter(Boolean).length >= 2; dir = dirname(dir).replace(/\\/g, '/')) {
    const encoded = dir.replace(/[^a-zA-Z0-9]/g, '-');
    if (opts.accountDirs.some((acc) => exists(join(acc, 'projects', encoded).replace(/\\/g, '/')))) return true;
  }
  return false;
}
