// Prompt answered directly in terminal: Claude Code displays permission prompt while executing
// hook, and answering there does NOT abort hook (it would otherwise wait until timeout).
// To resolve prompt in office UI, registry scans transcript tail for matching tool call
// (hook receives no tool_use ID, so search matches name + argument signature)
// and awaits its tool_result: approved (tool executed) or denied (error result).
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/** How much of transcript tail is inspected on each poll. */
export const SCAN_TAIL_BYTES = 512 * 1024;
/** Tool invocations older than this (prior to prompt) are ignored: belong to previous turns. */
export const MAX_CALL_AGE_MS = 10 * 60_000;
/** Signature text truncation limit (hook also truncates long arguments before dispatch). */
const SIG_TEXT_MAX = 2_000;

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function cut(v: unknown): unknown {
  if (typeof v === 'string') return v.length > SIG_TEXT_MAX ? v.slice(0, SIG_TEXT_MAX) : v;
  if (Array.isArray(v)) return v.map(cut);
  const r = rec(v);
  if (!r) return v;
  const out: Rec = {};
  for (const k of Object.keys(r).sort()) out[k] = cut(r[k]);
  return out;
}

/**
 * Tool invocation signature, identical across hook `tool_input` and transcript tool_use `input`.
 * Recognized tools use only primary argument (Claude Code may complete optional fields before
 * invoking hook); others use all arguments (sorted keys, truncated strings).
 */
export function callSignature(tool: string, input: unknown): string {
  const r = rec(input) ?? {};
  const s = (k: string) => (typeof r[k] === 'string' ? (cut(r[k]) as string) : '');
  switch (tool) {
    case 'Bash':
      return `Bash|${s('command')}`;
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
    case 'LS':
      return `${tool}|${s('file_path') || s('notebook_path') || s('path')}`;
    case 'WebFetch':
      return `WebFetch|${s('url')}`;
    case 'WebSearch':
      return `WebSearch|${s('query')}`;
    case 'Glob':
    case 'Grep':
      return `${tool}|${s('pattern')}|${s('path')}`;
    default:
      return `${tool}|${JSON.stringify(cut(r))}`;
  }
}

/** Reads final `bytes` of file (first line, potentially truncated, is discarded). */
function readTail(path: string, bytes: number): string[] {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    const lines = buf.subarray(0, read).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } finally {
    closeSync(fd);
  }
}

export interface CallScan {
  /** Matching prompt tool call found in transcript (most recent match lacking tool result). */
  toolUseId?: string;
  /** Call already contains tool_result: request has been resolved (in terminal or session progressed without it). */
  answered: boolean;
}

/**
 * Locates prompt tool call in transcript tail. With `knownId` (found previously), checks if
 * result arrived. Without it, chooses most recent matching invocation by name and signature lacking
 * result and not predating prompt. Unreadable file throws (caller ignores). 
 */
export function scanToolCall(
  path: string,
  q: { tool: string; signature: string; knownId?: string; createdAt: number },
  tailBytes = SCAN_TAIL_BYTES,
): CallScan {
  const calls: Array<{ id: string; at: number }> = [];
  const results = new Set<string>();
  for (const line of readTail(path, tailBytes)) {
    // Cheap pre-filter before JSON.parse: only lines with tool_use or tool_result are relevant.
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
    let j: Rec | undefined;
    try {
      j = rec(JSON.parse(line));
    } catch {
      continue;
    }
    const content = rec(j?.message)?.content;
    if (!Array.isArray(content)) continue;
    const at = typeof j?.timestamp === 'string' ? Date.parse(j.timestamp) : Number.NaN;
    for (const raw of content) {
      const b = rec(raw);
      if (!b) continue;
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') results.add(b.tool_use_id);
      else if (b.type === 'tool_use' && typeof b.id === 'string' && !q.knownId && b.name === q.tool && callSignature(q.tool, b.input) === q.signature) {
        calls.push({ id: b.id, at });
      }
    }
  }
  if (q.knownId) return { toolUseId: q.knownId, answered: results.has(q.knownId) };
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    if (results.has(c.id)) continue;
    if (Number.isFinite(c.at) && c.at < q.createdAt - MAX_CALL_AGE_MS) break;
    return { toolUseId: c.id, answered: false };
  }
  return { answered: false };
}
