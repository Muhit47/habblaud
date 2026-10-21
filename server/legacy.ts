// Migration from the project's old name (CodeTown, up to 0.3.2) to Habblaud. What still needs to recognize the
// old name stays here, to be cleanly removed once nobody upgrades from a 0.3 installation.
import { existsSync, readdirSync, renameSync, rmdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tr } from '../shared/i18n';

/** Old name in lowercase: state directory, plugins, marketplace, project, and Docker volume. */
export const LEGACY_NAME = 'codetown';
const LEGACY_ENV_PREFIX = 'CODETOWN_';
const ENV_PREFIX = 'HABBLAUD_';

/** Old name environment variables (CODETOWN_*) present in `keys`, with the new name for each. */
export function legacyEnvVars(keys: Iterable<string>): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (const k of keys) {
    if (k.startsWith(LEGACY_ENV_PREFIX)) out.push({ from: k, to: ENV_PREFIX + k.slice(LEGACY_ENV_PREFIX.length) });
  }
  return out.sort((a, b) => a.from.localeCompare(b.from));
}

/** Warning for old variables (no longer valid), or undefined if none present. */
export function legacyEnvWarning(keys: Iterable<string>, where = tr('no ambiente')): string | undefined {
  const vars = legacyEnvVars(keys);
  if (!vars.length) return undefined;
  return tr('{0} {1}: {2}. Renomeie para valer de novo.', [vars.length === 1 ? tr('variável do nome antigo ignorada') : tr('variáveis do nome antigo ignoradas'), where, vars.map((v) => `${v.from} → ${v.to}`).join(', ')]);
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Moves missing items from `from` to `to` (shared folders are merged); for files existing on both sides, newer wins. */
function mergeInto(from: string, to: string, moved: string[], rel: string): void {
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    const relName = rel ? `${rel}/${name}` : name;
    if (!existsSync(dst)) {
      renameSync(src, dst);
      moved.push(relName);
    } else if (isDir(src) && isDir(dst)) mergeInto(src, dst, moved, relName);
    else if (isFile(src) && isFile(dst) && statSync(src).mtimeMs > statSync(dst).mtimeMs) {
      // E.g. legacy mod kept recording usage in ~/.codetown after new folder was created.
      renameSync(src, dst);
      moved.push(relName);
    }
  }
  try {
    rmdirSync(from);
  } catch {
    // remaining items already existed at destination: keep old folder with only those items
  }
}

/**
 * Migrates state from ~/.codetown to ~/.habblaud (usage captured by mod/tap and, outside Docker, names, timeline,
 * and stats). Without the new folder, it performs a rename; if it already exists (mod recorded usage earlier), moves missing
 * and newer files. Returns moved items (empty = nothing to do) and never throws.
 */
export function migrateLegacyStateDir(home: string): { moved: string[]; error?: string } {
  const from = join(home, `.${LEGACY_NAME}`);
  const to = join(home, '.habblaud');
  const moved: string[] = [];
  if (!isDir(from)) return { moved };
  try {
    if (!existsSync(to)) {
      renameSync(from, to);
      moved.push('.');
    } else if (isDir(to)) mergeInto(from, to, moved, '');
    else return { moved, error: tr('{0} existe e não é uma pasta', [to]) };
    return { moved };
  } catch (err) {
    return { moved, error: (err as Error).message };
  }
}

/** Short log message for migrated installation (undefined if nothing changed). */
export function describeStateMigration(r: { moved: string[]; error?: string }): string | undefined {
  if (r.error) return tr('não consegui levar ~/.{0} para ~/.habblaud ({1}); mova a pasta à mão.', [LEGACY_NAME, r.error]);
  if (!r.moved.length) return undefined;
  return r.moved[0] === '.' ? tr('~/.{0} (nome antigo) agora é ~/.habblaud.', [LEGACY_NAME]) : tr('de ~/.{0} (nome antigo) para ~/.habblaud: {1}.', [LEGACY_NAME, r.moved.join(', ')]);
}
