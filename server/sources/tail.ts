// Incremental reader for append-only files (JSONL): yields only complete new lines,
// buffers partial lines for next cycle (up to MAX_LINE_BYTES), and detects truncation/rotation.
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { log } from '../log';
import { tr } from '../../shared/i18n';

export interface TailRead {
  lines: string[];
  /** File was truncated or replaced: reading restarted from beginning. */
  reset: boolean;
  /** File does not exist (yet or any longer). */
  missing: boolean;
  /** Unread bytes still remain (read limit reached). */
  more: boolean;
}

const NL = 0x0a;
/** How many bytes of file head to retain to verify a replacement indicated solely by birthtime (see `replaced`). */
const HEAD_BYTES = 256;
/**
 * JSONL line limit. In real Claude Code and Codex conversations, the largest observed line
 * reached 5.8 MiB (large tool_result requiring full parsing for activity). 8 MiB
 * provides comfortable headroom; beyond that, lines are discarded up to `\n`.
 */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** Warns once per file when a line exceeds limit and is dropped. Line content omitted. */
export function warnOversizedLine(path: string): void {
  const mb = MAX_LINE_BYTES / (1024 * 1024);
  log.warnOnce(`oversize-line:${path}`, tr('Linha com mais de {0} MiB em {1} foi ignorada até a próxima quebra.', [mb, path]));
}

/**
 * Incomplete line in chunks: assembled only when `\n` is encountered. Each read copies only the new slice;
 * above `max`, releases buffer and discards up to next newline.
 */
export class LineBuffer {
  private pieces: Buffer[] = [];
  private bytes = 0;
  private skipping = false;

  constructor(private readonly max = MAX_LINE_BYTES) {}

  reset(): void {
    this.pieces = [];
    this.bytes = 0;
    this.skipping = false;
  }

  /** Consumes `chunk` and returns closed lines, omitting `\n`. */
  push(chunk: Buffer): { lines: Buffer[]; discarded: number } {
    const lines: Buffer[] = [];
    let discarded = 0;
    let i = 0;
    while (i < chunk.length) {
      if (this.skipping) {
        const nl = chunk.indexOf(NL, i);
        if (nl === -1) return { lines, discarded };
        this.skipping = false;
        i = nl + 1;
        continue;
      }
      const nl = chunk.indexOf(NL, i);
      if (nl === -1) {
        const rest = chunk.length - i;
        if (rest > 0 && this.bytes + rest > this.max) {
          this.pieces = [];
          this.bytes = 0;
          this.skipping = true;
          discarded++;
        } else if (rest > 0) {
          this.pieces.push(Buffer.from(chunk.subarray(i)));
          this.bytes += rest;
        }
        return { lines, discarded };
      }
      const total = this.bytes + (nl - i);
      if (total > this.max) discarded++;
      else if (total > 0) lines.push(this.take(chunk.subarray(i, nl)));
      this.pieces = [];
      this.bytes = 0;
      i = nl + 1;
    }
    return { lines, discarded };
  }

  /** Remainder without `\n` at EOF; null if empty or if line exceeded limit. */
  flush(): Buffer | null {
    if (this.skipping || this.bytes === 0) return null;
    const out = this.pieces.length === 1 ? this.pieces[0] : Buffer.concat(this.pieces);
    this.pieces = [];
    this.bytes = 0;
    return out;
  }

  private take(tail: Buffer): Buffer {
    if (this.pieces.length === 0) return tail;
    if (tail.length === 0) return this.pieces.length === 1 ? this.pieces[0] : Buffer.concat(this.pieces);
    return Buffer.concat([...this.pieces, tail]);
  }
}

/** First `max` bytes of file via positional read (does not modify incremental read offset). */
function readHead(fd: number, max: number): Buffer {
  const buf = Buffer.alloc(max);
  return max > 0 ? buf.subarray(0, readSync(fd, buf, 0, max, 0)) : buf;
}

export class FileTail {
  /** Next byte offset to read. */
  offset = 0;
  size = 0;
  mtimeMs = 0;
  /** Incomplete line without `\n`. Above MAX_LINE_BYTES, remainder discarded until newline. */
  private pending = new LineBuffer();
  private ino: number | undefined;
  /** File creation timestamp (0 when file system does not provide it). */
  private birthtimeMs = 0;
  /** File head (up to HEAD_BYTES); null = not yet read. */
  private head: Buffer | null = null;
  private readonly maxChunk: number;

  constructor(
    readonly path: string,
    opts: { maxChunk?: number } = {},
  ) {
    this.maxChunk = opts.maxChunk ?? 8 * 1024 * 1024;
  }

  /**
   * Positions reading at the last `maxBytes` of file, aligned to beginning of next line
   * (the cut-off line is discarded). Returns chosen offset (0 = entire file).
   */
  seekTail(maxBytes: number): number {
    this.pending.reset();
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch {
      this.offset = 0;
      return 0;
    }
    try {
      const st = fstatSync(fd);
      this.ino = st.ino;
      this.birthtimeMs = st.birthtimeMs;
      this.size = st.size;
      this.mtimeMs = st.mtimeMs;
      this.head = readHead(fd, Math.min(st.size, HEAD_BYTES));
      if (st.size <= maxBytes) {
        this.offset = 0;
        return 0;
      }
      // Find first newline starting from (window start - 1).
      let pos = st.size - maxBytes - 1;
      const buf = Buffer.allocUnsafe(64 * 1024);
      while (pos < st.size) {
        const n = readSync(fd, buf, 0, buf.length, pos);
        if (n <= 0) break;
        const i = buf.subarray(0, n).indexOf(NL);
        if (i !== -1) {
          this.offset = pos + i + 1;
          return this.offset;
        }
        pos += n;
      }
      this.offset = st.size;
      return this.offset;
    } finally {
      closeSync(fd);
    }
  }

  /** Positions at EOF (only bytes written from this point forward will be read). */
  seekEnd(): void {
    this.pending.reset();
    this.head = null;
    try {
      const st = statSync(this.path);
      this.ino = st.ino;
      this.birthtimeMs = st.birthtimeMs;
      this.size = st.size;
      this.mtimeMs = st.mtimeMs;
      this.offset = st.size;
    } catch {
      this.offset = 0;
    }
  }

  /**
   * Was the file replaced with another? A different inode suffices, but the filesystem may reuse the
   * number of a deleted file (ext4): therefore, when both sides report creation timestamp, it also
   * counts. However, on Linux without statx (WSL1, legacy seccomp), Node returns ctime instead, and ctime changes on
   * every write: birthtime changes only count if the file head also changed. A new file starting with
   * identical bytes passes as the same, as before birthtime was tracked.
   * The same applies to mtime: rewriting file in-place on the same inode (`writeFileSync` over it) alters neither inode nor
   * birthtime, and with equal (or larger) size, `size < offset` fails to trigger. Appending lines modifies mtime
   * without touching the head, so only a change in the head qualifies as replacement.
   */
  private replaced(fd: number, st: { ino: number; birthtimeMs: number; mtimeMs: number }): boolean {
    if (this.ino === undefined) return false;
    if (st.ino !== this.ino) return true;
    const born = this.birthtimeMs > 0 && st.birthtimeMs > 0 && st.birthtimeMs !== this.birthtimeMs;
    const written = st.mtimeMs !== this.mtimeMs;
    if (!born && !written) return false;
    return !!this.head && !readHead(fd, this.head.length).equals(this.head);
  }

  read(): TailRead {
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { lines: [], reset: false, missing: true, more: false };
      throw err;
    }
    try {
      const st = fstatSync(fd);
      let reset = false;
      if (this.replaced(fd, st) || st.size < this.offset) {
        this.offset = 0;
        this.pending.reset();
        this.head = null;
        reset = true;
      }
      this.ino = st.ino;
      this.birthtimeMs = st.birthtimeMs;
      this.size = st.size;
      this.mtimeMs = st.mtimeMs;
      // Head is only re-read while file length remains under HEAD_BYTES.
      const headLen = Math.min(st.size, HEAD_BYTES);
      if (!this.head || this.head.length < headLen) this.head = readHead(fd, headLen);
      const avail = st.size - this.offset;
      if (avail <= 0) return { lines: [], reset, missing: false, more: false };
      const len = Math.min(avail, this.maxChunk);
      const chunk = Buffer.allocUnsafe(len);
      const n = readSync(fd, chunk, 0, len, this.offset);
      this.offset += n;
      const fed = this.pending.push(chunk.subarray(0, n));
      if (fed.discarded) warnOversizedLine(this.path);
      const lines: string[] = [];
      for (const buf of fed.lines) {
        const line = buf.toString('utf8').replace(/\r$/, '');
        if (line.trim()) lines.push(line);
      }
      return { lines, reset, missing: false, more: avail > len };
    } finally {
      closeSync(fd);
    }
  }
}
