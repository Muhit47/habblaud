// Location of Claude Code `claude` executable on this computer. Used by interactive terminal (pty/manager.ts),
// New Agent (spawn/spawn.ts), and host helper (scripts/codex-bridge.ts). Pure Node with no external dependencies.
import { accessSync, constants, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';

/** File exists and can be executed (on Windows existence is sufficient: no execute permission bits). */
export function isExecutableFile(file: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Looks up an executable in PATH (on Windows, also checks PATHEXT extensions if name lacks one). */
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const sep = platform === 'win32' ? ';' : ':';
  const exts =
    platform === 'win32' && !extname(name) ? ['.exe', ...(env.PATHEXT ?? '.COM;.CMD;.BAT').split(';').filter(Boolean).map((e) => e.toLowerCase())] : [''];
  const dirs = (env.PATH ?? env.Path ?? '').split(sep).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = resolve(dir, name + ext);
      if (isExecutableFile(file, platform)) return file;
    }
  }
  return undefined;
}

/**
 * Claude Code executable: HABBLAUD_CLAUDE_BIN (path or executable name found
 * in PATH) or `claude` from PATH. undefined if not found.
 */
export function claudeBinFrom(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const set = env.HABBLAUD_CLAUDE_BIN?.trim();
  if (!set) return findExecutable('claude', env, platform);
  return /[\\/]/.test(set) ? resolve(set) : findExecutable(set, env, platform);
}

/** Runnable `claude`: executable from claudeBinFrom if file exists and is executable. */
export function runnableClaudeBin(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const bin = claudeBinFrom(env, platform);
  return bin && isExecutableFile(bin, platform) ? bin : undefined;
}
