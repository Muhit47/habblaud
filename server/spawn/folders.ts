// Suggested folders in "New agent": recent project directories for one-tap selection.
// Derived from session history (`cwd` from transcripts across all accounts and tools) and office rooms.
// Agent worktrees (<project>/.claude/worktrees/<name>) map to parent project; disposable desktop
// temporary directories (and Claude app scratch-workspaces) are excluded. Pure Node: aggregation and sorting
// (transcripts read by sources/history.ts).

export interface SpawnFolder {
  /** Absolute path on machine hosting Claude app. */
  path: string;
  /** Short name (last path segment). */
  name: string;
  /** Most recent activity timestamp (epoch ms; 0 = room only, timestamp unknown). */
  lastAt: number;
  /** Recent sessions in this folder. */
  sessions: number;
}

export const FOLDERS_LIMIT = 15;

const TEMP = /^(\/private)?\/(tmp|var\/folders|var\/tmp)(\/|$)/;
/** Disposable directories created by Claude desktop app for project-less sessions. */
const SCRATCH = /\/Application Support\/Claude\/scratch-workspaces\//;
const WORKTREE = /^(.*?)\/\.(claude|codex)\/worktrees\/[^/]+(\/.*)?$/;

function absolute(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
}

/** Resolves project folder for session path (worktree maps to project; temp or relative = undefined). */
export function projectFolder(raw: string | undefined): string | undefined {
  const p = raw?.trim().replace(/[\\/]+$/, '');
  if (!p || !absolute(p) || TEMP.test(p) || SCRATCH.test(p)) return undefined;
  const wt = WORKTREE.exec(p);
  return wt ? wt[1] || undefined : p;
}

/** Merges sessions and rooms into deduplicated folders, sorted from newest to oldest activity. */
export function recentFolders(
  sessions: ReadonlyArray<{ project?: string; lastAt: number }>,
  rooms: ReadonlyArray<{ path?: string; lastAt?: number }>,
  limit = FOLDERS_LIMIT,
): SpawnFolder[] {
  const byPath = new Map<string, SpawnFolder>();
  const add = (raw: string | undefined, lastAt: number, session: boolean) => {
    const path = projectFolder(raw);
    if (!path) return;
    const cur = byPath.get(path);
    if (cur) {
      cur.lastAt = Math.max(cur.lastAt, lastAt);
      if (session) cur.sessions++;
    } else byPath.set(path, { path, name: path.split(/[\\/]/).pop() || path, lastAt, sessions: session ? 1 : 0 });
  };
  for (const s of sessions) add(s.project, s.lastAt, true);
  for (const r of rooms) add(r.path, r.lastAt ?? 0, false);
  return [...byPath.values()].sort((a, b) => b.lastAt - a.lastAt || a.path.localeCompare(b.path)).slice(0, limit);
}
