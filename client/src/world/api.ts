// World CONTRACT (office canvas) consumed by the UI (client/src/ui/**).
// Implementation: client/src/world/index.ts -> createWorld().
// Rule: changes here must be ADDITIVE.

export type Selection = { type: 'agent'; id: string } | { type: 'room'; id: string } | null;

export interface WorldOptions {
  /** Display badges with character names. */
  showNames: boolean;
  /** Activity speech bubbles: all, only important (needs attention, selected, recent changes), or none. */
  bubbles: 'all' | 'important' | 'none';
  /** Frequency of roaming through office when agents are idle. */
  liveliness: 'calm' | 'normal' | 'lively';
  /** Camera tracks the selected agent. */
  followSelected: boolean;
  /** Day/night cycle based on local time (windows, lighting). */
  dayNight: boolean;
  /** (Optional, additive) Day/night cycle: auto, always day, or always night. Takes precedence over `dayNight`. */
  daylight?: DaylightMode;
  /** Visual theme: auto (follows calendar; see seasonalThemeFor), none, Christmas, or Halloween. */
  theme?: OfficeTheme;
}

/** Theme drawn by renderer: original office ('none') or one of the seasonal themes. */
export type SeasonalTheme = 'none' | 'christmas' | 'halloween';
export type OfficeTheme = 'auto' | SeasonalTheme;

/**
 * Theme drawn on a date (local time). In auto mode: Halloween from Oct 1 to Oct 31, Christmas from Nov 1 to
 * Dec 26, and original office throughout the rest of the year.
 */
export function seasonalThemeFor(theme: OfficeTheme | undefined, date: Date): SeasonalTheme {
  if (theme && theme !== 'auto') return theme;
  const month = date.getMonth();
  if (month === 9) return 'halloween';
  if (month === 10 || (month === 11 && date.getDate() <= 26)) return 'christmas';
  return 'none';
}

/** Ciclo dia/noite: segue a hora local, ou fixa o dia ou a noite. */
export type DaylightMode = 'auto' | 'day' | 'night';

/** Ambient sounds suggested by the world (UI decides whether and how to play them). */
export type SoundCueKind = 'keys' | 'elevator' | 'pingpong' | 'table' | 'arcade';

export interface SoundCue {
  kind: SoundCueKind;
  /** 0..1: proximity (zoom, offscreen...). */
  gain: number;
  /** -1 (left) .. 1 (right): screen stereo panning position. */
  pan: number;
  /** Keyboard: number of keys in burst. */
  count?: number;
}

export interface WorldApi {
  /** Selects (or deselects) an agent/room. `focus` moves camera to it. */
  select(sel: Selection, opts?: { focus?: boolean }): void;
  getSelection(): Selection;
  /** Fired when selection changes (by canvas click or via select()). */
  onSelect(cb: (sel: Selection) => void): () => void;
  /** Agent under cursor (for UI tooltips). */
  onHover(cb: (agentId: string | null) => void): () => void;
  focusAgent(id: string, opts?: { follow?: boolean }): void;
  focusRoom(id: string): void;
  /** Frames the entire building. */
  overview(): void;
  zoomBy(factor: number): void;
  getOptions(): WorldOptions;
  setOptions(o: Partial<WorldOptions>): void;
  /** Screen position (CSS px, relative to viewport) just above character head, or null if not visible. */
  screenPositionOf(agentId: string): { x: number; y: number } | null;
  /**
   * (Optional, additive) Screen area covered by UI panels, in CSS px. World frames
   * (overview) and centers (focusAgent/focusRoom/follow) within the remaining free area.
   */
  setViewInsets?(insets: Partial<ViewInsets>): void;
  /**
   * (Optional, additive) Social life of an agent present in the office: personality, coin
   * wallet, friendships/rivalries with present agents, and active social gathering. null if not present.
   */
  social?(agentId: string): AgentSocial | null;
  /** (Optional, additive) Right click on an office room: room id and click point (window px). */
  onRoomContextMenu?(cb: (roomId: string, at: { x: number; y: number }) => void): () => void;
  /** (Optional, additive) Social events (matches and bets) for feed. */
  onSocialEvent?(cb: (e: SocialEvent) => void): () => void;
  /**
   * (Optional, additive) Timelapse: with `p`, world renders the playback day (clock and animation
   * factor from `p`); `null` returns to live mode. Each call restarts world from scratch (nobody walks to desk:
   * all appear directly in place), so call when entering, jumping to another time, or exiting; the next
   * store snapshot is applied as initial load.
   */
  setPlayback?(p: WorldPlayback | null): void;
  /** (Optional, additive) Ambient sounds: keyboard typing in view, elevator, social gatherings. */
  onSound?(cb: (cue: SoundCue) => void): () => void;
  /**
   * (Optional, additive) Office offscreen (city scene is active): stops rendering and camera
   * keyboard; upon return, simulation fast-forwards elapsed time (same as background tab).
   */
  setSuspended?(suspended: boolean): void;
  destroy(): void;
}

/** Timelapse clocks (see world/playback.ts). */
export interface WorldPlayback {
  /** Playback instant (epoch ms): sky time, lighting, and wall clock. */
  clock(): number;
  /** Animation speed multiplier (1 = real-time; 0 = paused). */
  scale(): number;
}

export interface AgentSocial {
  traits: { emoji: string; label: string; desc: string }[];
  /** Catchphrase ("All set!"). */
  catchphrase: string;
  /** Saldo de moedinhas (🪙). */
  coins: number;
  /** Total earned from work (initial balance + tasks + requests + deliveries). */
  earned: number;
  wins: number;
  losses: number;
  /** Present colleagues with friendship or rivalry; `record` = [wins, losses] against them. */
  bonds: { id: string; name: string; kind: 'amizade' | 'rivalidade'; record: [number, number] | null }[];
  /** Current gathering activity ("📺 Watching soccer on TV with Rafaela"), or null. */
  doing: string | null;
  /** Statement: most recent transactions first. */
  ledger: { at: number; delta: number; icon: string; text: string }[];
}

/** Resolved match/bet (converts to feed entry). */
export interface SocialEvent {
  id: string;
  at: number;
  icon: string;
  /** Protagonista (quem venceu). */
  agentId: string;
  /** Text without protagonist name: "won 🪙10 from Caio in rock-paper-scissors". */
  text: string;
  /** Where event occurred ("Lounge", "Pantry"...). */
  place: string;
}

/** Viewport margins covered by UI chrome (CSS px). */
export interface ViewInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const DEFAULT_WORLD_OPTIONS: WorldOptions = {
  showNames: true,
  bubbles: 'important',
  liveliness: 'normal',
  followSelected: false,
  dayNight: true,
  theme: 'auto',
};
