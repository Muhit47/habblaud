// User-assigned room names (right-click > Rename), persisted per directory in <dataDir>/rooms.json.
// Without an alias, room uses directory name (model/rooms.ts roomDisplayNames); `defaults` gives fixed names
// to known folders (e.g. assets folder displays as "Architect").
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { errMsg, log } from '../log';
import { tr } from '../../shared/i18n';

export const ROOM_NAME_MAX = 40;

/** Comparable path key (standard forward slashes, no trailing slash, case-insensitive). */
export function pathKey(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export class RoomAliases {
  private aliases = new Map<string, string>();
  private readonly defaults = new Map<string, string>();

  /** `file` null = in-memory only (tests). */
  constructor(private readonly file: string | null) {}

  load(): void {
    if (!this.file) return;
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as { aliases?: Record<string, unknown> };
      for (const [k, v] of Object.entries(j.aliases ?? {})) if (typeof v === 'string' && v.trim()) this.aliases.set(pathKey(k), v.trim().slice(0, ROOM_NAME_MAX));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(tr('rooms.json ilegível ({0}); sem nomes de sala personalizados.', [errMsg(err)]));
    }
  }

  /** Fixed fallback name for directory when user has not configured custom name. */
  setDefault(path: string, name: string): void {
    this.defaults.set(pathKey(path), name);
  }

  get(path: string): string | undefined {
    const k = pathKey(path);
    return this.aliases.get(k) ?? this.defaults.get(k);
  }

  /** Sets room name for directory; empty string reverts to default. Returns active name. */
  set(path: string, name: string): string | undefined {
    const k = pathKey(path);
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, ROOM_NAME_MAX);
    if (clean) this.aliases.set(k, clean);
    else this.aliases.delete(k);
    this.save();
    return this.get(path);
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, aliases: Object.fromEntries(this.aliases) }, null, 2));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (err) {
      log.warn(tr('Não consegui gravar {0}: {1}', [this.file, errMsg(err)]));
    }
  }
}
