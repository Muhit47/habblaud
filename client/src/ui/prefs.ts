// UI preferences, persisted in localStorage ('habblaud:prefs').
// Pure module: storage implementation is injected (testable in Node).
import { DEFAULT_SOUND_SETTINGS, sanitizeSoundSettings, type SoundSettings } from '../audio/scheduler';
import type { DaylightMode, WorldOptions } from '../world/api';
import { DEFAULT_WORLD_OPTIONS } from '../world/api';

export const PREFS_KEY = 'habblaud:prefs';

export interface UiPrefs {
  showNames: boolean;
  bubbles: WorldOptions['bubbles'];
  liveliness: WorldOptions['liveliness'];
  /** Day/night cycle: auto (local time), always day, or always night. */
  daylight: DaylightMode;
  theme: NonNullable<WorldOptions['theme']>;
  /** Synthesized sound effects (master switch; off by default). */
  sound: boolean;
  /** Master volume and audio category settings. */
  sounds: SoundSettings;
  /** Browser notification API for alerts when tab is hidden. */
  browserNotifications: boolean;
  sidebarOpen: boolean;
  feedOpen: boolean;
  /** Hidden accounts in sidebar (AccountInfo.id). */
  hiddenAccounts: string[];
  /** Habblaud World: notify when first visitor enters your building (per connection). Enabled by default. */
  worldVisitNotify: boolean;
}

export const DEFAULT_PREFS: UiPrefs = {
  showNames: DEFAULT_WORLD_OPTIONS.showNames,
  bubbles: DEFAULT_WORLD_OPTIONS.bubbles,
  liveliness: DEFAULT_WORLD_OPTIONS.liveliness,
  daylight: 'auto',
  theme: 'auto',
  sound: false,
  sounds: DEFAULT_SOUND_SETTINGS,
  browserNotifications: false,
  sidebarOpen: true,
  feedOpen: true,
  hiddenAccounts: [],
  worldVisitNotify: true,
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/** Validates field by field: unknown or corrupted values fall back to defaults. */
export function sanitizePrefs(raw: unknown): UiPrefs {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_PREFS;
  return {
    showNames: bool(o.showNames, d.showNames),
    bubbles: oneOf(o.bubbles, ['all', 'important', 'none'] as const, d.bubbles),
    liveliness: oneOf(o.liveliness, ['calm', 'normal', 'lively'] as const, d.liveliness),
    // legacy prefs: disabled "day and night" toggle maps to "always day"
    daylight: oneOf(o.daylight, ['auto', 'day', 'night'] as const, o.dayNight === false ? 'day' : d.daylight),
    theme: oneOf(o.theme, ['auto', 'none', 'christmas', 'halloween'] as const, d.theme),
    sound: bool(o.sound, d.sound),
    sounds: sanitizeSoundSettings(o.sounds),
    browserNotifications: bool(o.browserNotifications, d.browserNotifications),
    sidebarOpen: bool(o.sidebarOpen, d.sidebarOpen),
    feedOpen: bool(o.feedOpen, d.feedOpen),
    hiddenAccounts: Array.isArray(o.hiddenAccounts) ? o.hiddenAccounts.filter((x): x is string => typeof x === 'string').slice(0, 20) : [],
    worldVisitNotify: bool(o.worldVisitNotify, d.worldVisitNotify),
  };
}

export function loadPrefs(storage: StorageLike | null): UiPrefs {
  if (!storage) return { ...DEFAULT_PREFS };
  try {
    const raw = storage.getItem(PREFS_KEY);
    return sanitizePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(storage: StorageLike | null, prefs: UiPrefs): void {
  if (!storage) return;
  try {
    storage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or restricted (private browsing): preferences apply to current session only.
  }
}

/** Subset of preferences consumed by the world canvas. */
export function worldOptionsFrom(p: UiPrefs): Partial<WorldOptions> {
  return { showNames: p.showNames, bubbles: p.bubbles, liveliness: p.liveliness, dayNight: p.daylight !== 'day', daylight: p.daylight, theme: p.theme };
}

/** Safe localStorage accessor guarding against browser environments that throw on access. */
export function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Legacy branding migration (CodeTown up to 0.3.2): keys were `codetown:prefs`,
 * `codetown:update-seen`, `codetown.wallets.v1`... and now use the `habblaud` prefix.
 */
const LEGACY_NAME = 'codetown';
const LEGACY_PREFIXES = [`${LEGACY_NAME}:`, `${LEGACY_NAME}.`];
const NAME = 'habblaud';

type ListableStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

/**
 * Migrates legacy storage keys so users upgrading don't lose preferences or tokens.
 * Runs at startup before any reads. If a new key already exists, it takes precedence and legacy key is purged.
 * Returns number of keys migrated.
 */
export function migrateLegacyKeys(storage: ListableStorage | null): number {
  if (!storage) return 0;
  const legacy: string[] = [];
  try {
    // Snapshot keys prior to modification: deleting during iteration alters key(i) indices.
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && LEGACY_PREFIXES.some((p) => key.startsWith(p))) legacy.push(key);
    }
  } catch {
    return 0;
  }
  let copied = 0;
  for (const old of legacy) {
    try {
      const value = storage.getItem(old);
      const key = NAME + old.slice(LEGACY_NAME.length);
      if (value !== null && storage.getItem(key) === null) {
        storage.setItem(key, value);
        copied++;
      }
      // Only delete after successful write: if write throws (quota exceeded), legacy key is retained for retry.
      storage.removeItem(old);
    } catch {
      // continue with remaining keys
    }
  }
  return copied;
}
