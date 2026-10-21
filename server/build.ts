// Build identifier of compiled client (dist/client): main bundle name, which changes on every
// `npm run build`. Sent in snapshot so pages open prior to an update detect it and reload.
// Also the server build stamp (dist/build.json: commit and "dirty worktree"), for Habblaud World.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BuildInfo } from '../shared/world/protocol';

const BUNDLE = /bundle\/(main-[\w-]+)\.js/;

/** Reads build id from compiled index.html (cached by file modification time). */
export function createBuildReader(rootDir: string): () => string | undefined {
  const file = join(rootDir, 'dist', 'client', 'index.html');
  let mtime = -1;
  let id: string | undefined;
  return () => {
    try {
      const m = statSync(file).mtimeMs;
      if (m !== mtime) {
        mtime = m;
        id = BUNDLE.exec(readFileSync(file, 'utf8'))?.[1];
      }
    } catch {
      mtime = -1;
      id = undefined;
    }
    return id;
  };
}

/** What scripts/build-server.mjs writes to dist/build.json (scripts/build-info.mjs). */
export interface BuildStamp extends BuildInfo {
  /** When build was created (ISO); absent without the file. */
  builtAt?: string;
}

const UNKNOWN: BuildStamp = { commit: 'unknown', dirty: false };

/**
 * Active build commit and whether worktree was dirty, from dist/build.json. Sent in Habblaud World `hello`.
 * Without file (dev mode with tsx, or legacy build) or if corrupted: commit "unknown".
 */
export function readBuildInfo(rootDir: string): BuildStamp {
  try {
    const raw = JSON.parse(readFileSync(join(rootDir, 'dist', 'build.json'), 'utf8')) as Record<string, unknown>;
    if (typeof raw.commit !== 'string' || !/^([0-9a-f]{40}([0-9a-f]{24})?|unknown)$/.test(raw.commit) || typeof raw.dirty !== 'boolean') return { ...UNKNOWN };
    const stamp: BuildStamp = { commit: raw.commit, dirty: raw.dirty };
    if (typeof raw.builtAt === 'string' && raw.builtAt.length <= 40) stamp.builtAt = raw.builtAt;
    return stamp;
  } catch {
    return { ...UNKNOWN };
  }
}
