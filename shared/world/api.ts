// Local Habblaud World routes (/api/world/*, server/world/http.ts): endpoints called by Habblaud frontend
// to local server, which communicates with world server on its behalf. Local port only, local Host
// (never via mobile remote port), and account-altering operations require terminal lock (local bind).
// The device token is never exposed to the frontend.
//
//   GET  /api/world/status[?refresh=1]       → WorldStatus
//   POST /api/world/register                 {email, password, name, locale?, invite?} → 202 {} (name: player nickname,
//                                                reserved on waitlist; 422 name_invalid | name_blocked, 409 name_taken)
//   POST /api/world/verify                   {email, code} → 200 WorldStatus (authenticates: stores token locally)
//   POST /api/world/login                    {email, password} → 200 WorldStatus
//   POST /api/world/logout                   {} → 200 WorldStatus (deletes local token and revokes on server)
//   POST /api/world/resend                   {email} → 202 {}
//   POST /api/world/password/forgot          {email} → 202 {}
//   POST /api/world/password/reset           {email, code, password} → 204
//   PUT  /api/world/character                PlayerInput → 200 Player (when creating with reserved registration name, omit `name`)
//   PUT  /api/world/visibility               Visibility → 200 Visibility
//   GET  /api/world/devices                  → {devices: DeviceInfo[]}
//   POST /api/world/devices/:id/revoke       {} → 204 (own device: unlinks locally too)
//   PUT  /api/world/theme                    {theme: WorldThemeChoice} → 200 {theme} (with or without account: stored in world.json)
//   POST /api/world/pause                    {} → 200 WorldStatus (halts uplink prior to responding; socket
//                                                closes, or stays open for World scene without uplink;
//                                                notifies POST /v1/me/building/pause documented in protocol.ts)
//   POST /api/world/resume                   {} → 200 WorldStatus (notifies POST /v1/me/building/resume and reopens uplink;
//                                                retries with exponential backoff if world server unreachable)
//   POST /api/world/leave                    {} → 200 WorldStatus ("Leave World": pauses uplink, invokes
//                                                DELETE /v1/me/building then responds; account and player character
//                                                persist)
//   POST /api/world/join                     {} → 200 WorldStatus ("Rejoin World": POST /v1/me/building/join and,
//                                                on success, clears departed and paused state, reopening uplink;
//                                                subsequent packet creates new building on new lot; if not departed,
//                                                acts as resume)
//   GET  /api/world/last-uplink              → WorldLastUplink | {} (exact last sent uplink payload)
//
// Account and data management (Phase 6):
//   POST /api/world/delete-account           {} → 202 {} ("Delete account": POST /v1/me/delete sends code to email)
//   POST /api/world/delete-account/confirm   {code} → 200 WorldStatus (POST /v1/me/delete/confirm; on success,
//                                                closes building socket and wipes entire world.json: local session
//                                                cleared, status resets without account, with lastError
//                                                `account_deleted`)
//   GET  /api/world/export                   → 200 WorldExport (account JSON as received from GET /v1/me/export), attachment
//                                                (habblaud-world-dados.json); once per day (429 rate_limited); strictly
//                                                via UI page, like stream (consumes daily quota)
//   PUT  /api/world/visibility               also accepts `notifyInactivity` (optional): email notification prior
//                                                to building eviction due to inactivity
// Light social (Phase 5; server/world/social.ts), via building connection, regardless of whether World scene is open:
//   POST /api/world/summary/seen             {} → 204 (dispatches ↑ `summary.seen`: owner reviewed "While you were away";
//                                                409 not_connected if disconnected from world)
//   POST /api/world/unblock                  {playerId} → 204 (dispatches ↑ `unblock`; unblocks player locally
//                                                and on server)
//                                                immediately and refreshes /v1/me; 409 not_connected when disconnected)
// The building code ("Go to HB-XXXX") routes directly to scene ↑ `teleport {code}`: route GET /v1/buildings/:code in
// protocol (BuildingCodeResponse) is not called by frontend.
//
// World scene (Phase 3; server/world/viewer.ts), subject to same security guards and excluding mobile port:
//   GET  /api/world/stream                   → text/event-stream: `world.snapshot` (WorldSceneSnapshot) on connect and
//                                                on each restart (world connection open or dropped, fresh `view`),
//                                                `world` (WorldSceneMessage) streaming city messages as received,
//                                                in strict order without `rev` gaps, and `: ping` every 15 s. Maximum
//                                                4 open streams (429 too_many_streams). First open stream dispatches
//                                                `view` to world server; last close sends `view.off`
//   POST /api/world/cmd                      {stream, cmds: WorldSceneCommand[]} → 202 {sent} (up to 5 batches/s per
//                                                stream, 20 commands per batch; only latest `move` in batch is forwarded)
//
// Errors: {error: {code, message?, retryAfter?}} with world server status when originating remotely (codes in
// WORLD_ERROR_CODES from protocol; newer codes passed through) or with local error codes listed below. UI translates
// via `code`; `message` is intended for log inspection or curl debugging.
import {
  WORLD_ERROR_CODES,
  type AfkMessage,
  type AppearanceParts,
  type AreaMessage,
  type AreaPatchMessage,
  type AwaySummary,
  type AwaySummaryMessage,
  type CityFireworksMessage,
  type CityStatusMessage,
  type KnockedMessage,
  type KnockMessage,
  type LikesTodayMessage,
  type StampMessage,
  type SummarySeenMessage,
  type TeleportMessage,
  type BlockMessage,
  type BuildingMessage,
  type BuildingPatchMessage,
  type DeviceInfo,
  type EnterMessage,
  type GoodbyeReason,
  type GreetingMessage,
  type GreetMessage,
  type IntroId,
  type LeaveMessage,
  type LikeMessage,
  type LikeUpdateMessage,
  type MinimapMessage,
  type MoveMessage,
  type NoticeMessage,
  type Player,
  type PlayerJoinMessage,
  type PlayerLeaveMessage,
  type PlayersMessage,
  type PosMessage,
  type ProfileMessage,
  type ProfileRequestMessage,
  type ReportMessage,
  type ResyncMessage,
  type TraitId,
  type ViewMessage,
  type ViewOffMessage,
  type VisitorsMessage,
  type WorldBuildingDetail,
  type WorldAccess,
  type WorldBuildingPublic,
  type WorldErrorCode,
  type UplinkAckError,
  type WorldPlayerPublic,
  type WorldPosition,
  type WorldTheme,
  type WorldUplink,
} from './protocol';

/**
 * Theme chosen in Settings › Appearance, stored in world.json (PUT /api/world/theme). Packet carries already
 * resolved theme: auto resolves to seasonal calendar theme (server/world/theme.ts).
 */
export const WORLD_THEME_CHOICES = ['auto', 'none', 'halloween', 'christmas'] as const;
export type WorldThemeChoice = 'auto' | WorldTheme;

export function isWorldThemeChoice(v: unknown): v is WorldThemeChoice {
  return typeof v === 'string' && (WORLD_THEME_CHOICES as readonly string[]).includes(v);
}

/** Account state on this computer. */
export type WorldState = 'off' | 'logged_out' | 'waiting' | 'approved';

/** Why building stopped uploading: reason from world server `goodbye` (`deploy` only reconnects). */
export type WorldBuildingStop = Exclude<GoodbyeReason, 'deploy'>;

/**
 * World server shipment response (`uplink.ack`): accepted (`at` and `bytes` counted by server) or rejected with
 * reason (`error`, strictly UPLINK_ACK_ERRORS codes; unknown codes fallback to `internal`; `at` is timestamp of rejection).
 */
export interface WorldUplinkAck {
  ok: boolean;
  error?: UplinkAckError;
  /** Timestamp (ms). */
  at: number;
  bytes?: number;
}

/**
 * Building of this computer in the world: GET /api/world/status → `building`, only with approved account and created
 * character. `floors` and `agents` reflect last shipment (prior to first shipment, values from `welcome`; 0 when none).
 */
export interface WorldBuildingStatus {
  /**
   * WebSocket open and accepted (`welcome`) and building uploading. Paused or outside world is always false: connection
   * opened by World scene to explore city does not upload building.
   */
  connected: boolean;
  /** Paused by owner (POST /api/world/pause). */
  paused: boolean;
  floors: number;
  agents: number;
  /** Last shipment (ms). */
  lastUplinkAt?: number;
  /** Response to last shipment (absent until received). */
  lastAck?: { ok: boolean; error?: UplinkAckError };
  /**
   * World server closed connection and building stopped: `banned`/`suspended` (account), `update` (outdated version: update),
   * `other-device` (account connected elsewhere; resumes via "Resume" or restarting Habblaud), `waiting`,
   * `no_player`, `unauthorized` (account changed remotely; local state updates).
   */
  stopped?: WorldBuildingStop;
  /** Left world (POST /api/world/leave): building removed and no packets upload until join (new building, new lot). */
  left?: true;
  /** Visitors inside building currently (see WorldBuildingMeta.visitors). */
  visitors?: number;
  /**
   * World marked building as "unverified" (WorldBuildingPublic.unverified, from `welcome` or city): data
   * flagged implausible and undergoing review; excluded from leaderboards and spotlights. Appealable.
   */
  unverified?: true;
  /** Likes recebidos hoje (veja WorldBuildingMeta.likesToday). */
  likesToday?: number;
  /** Knocks on door since this Habblaud session started (see WorldBuildingMeta.knocks). */
  knocks?: number;
  /** "While you were away" unread summary (↓ `away.summary` or /v1/me): visits, likes, and stamps, anonymous. */
  summary?: AwaySummary;
  /** Building code ("HB-4F2K", from /v1/me), to share with friends. */
  code?: string;
}

/** OfficeSnapshot.meta.world.building: building summary (without account details), for UI display without polling status. */
export interface WorldBuildingMeta {
  connected: boolean;
  paused: boolean;
  floors: number;
  agents: number;
  lastUplinkAt?: number;
  /** Left world (see WorldBuildingStatus.left). */
  left?: true;
  /** World server halted building (`goodbye`); reason appears only in status, not sent to mobile. */
  stopped?: true;
  /**
   * Visitors currently inside building (↓ `visitors {count}` on building connection, Phase 4): absent before first
   * count, without connection, or when building is closed to visitors (closed buildings emit neither count nor 0).
   */
  visitors?: number;
  /** Likes recebidos hoje (↓ `likes.today` ou /v1/me; Fase 5): o chip "❤️ 3 hoje" da barra. */
  likesToday?: number;
  /**
   * Knocks on door since this Habblaud session opened (↓ `knock {}`, anonymous; only with `knocks` enabled in visibility):
   * UI notifies when counter increments.
   */
  knocks?: number;
  /** Unread "While you were away" available (summary details only in status, not sent to mobile). */
  awaySummary?: true;
}

/** GET /api/world/last-uplink ("Inspect sent data"): exact payload of last shipment, byte size, and response. */
export interface WorldLastUplink {
  at: number;
  /** Payload JSON byte size (UTF-8), as measured by world server. */
  bytes: number;
  uplink: WorldUplink;
  ack?: WorldUplinkAck;
}

/**
 * OfficeSnapshot.meta.world: minimal metadata for UI to decide whether to render section (snapshot also goes to
 * mobile and timeline: no account credentials here).
 */
export interface WorldMeta {
  /**
   * Section visible: HABBLAUD_WORLD is not 0 and world server was accepted (default, server.habblaud.com, or
   * valid HABBLAUD_WORLD_URL). With rejected URL, feature is disabled and nothing appears in UI.
   */
  enabled: boolean;
  /** World server accepted (default or valid HABBLAUD_WORLD_URL). */
  configured: boolean;
  state: WorldState;
  /** Building in world (requires approved account and created character). */
  building?: WorldBuildingMeta;
  /**
   * World scene (Phase 3), only with World configured, approved account, and created character; `available` additionally
   * requires terminal lock (scene routes enforce it) and absence of ban, suspension, rejected version, or remote device conflict
   * (connection cannot self-recover). Paused or outside world, still valid (walks with darkened building). Toolbar shows World
   * button when `available`.
   */
  scene?: WorldSceneMeta;
}

export interface WorldSceneMeta {
  available: boolean;
}

// ------------------------------------------------------------------------------------------- World scene (Phase 3)

/** Commands dispatched by browser via POST /api/world/cmd (building commands excluded: hello, uplink, ping never allowed). */
export const WORLD_SCENE_COMMANDS = [
  'move', 'profile', 'resync', 'view', 'view.off', 'enter', 'leave', 'like', 'unlike', 'greet', 'block', 'unblock', 'report',
  'stamp', 'teleport', 'knock', 'summary.seen',
] as const;
export type WorldSceneCommand =
  | MoveMessage
  | ProfileRequestMessage
  | ResyncMessage
  | ViewMessage
  | ViewOffMessage
  | EnterMessage
  | LeaveMessage
  | LikeMessage
  | GreetMessage
  | BlockMessage
  | ReportMessage
  | StampMessage
  | TeleportMessage
  | KnockMessage
  | SummarySeenMessage;

/** Commands per batch (POST /api/world/cmd) and batches per second per stream. */
export const WORLD_SCENE_LIMITS = { cmdsPerBatch: 20, batchesPerSec: 5, streams: 4 } as const;

/**
 * City messages streamed to client (`world` event), as received from world server. Local server has
 * verified patch `rev` sequence (gaps trigger `resync` and patch is dropped) and filtered non-scene events.
 */
export type WorldSceneMessage =
  | AreaMessage
  | AreaPatchMessage
  | PlayersMessage
  | PlayerJoinMessage
  | PlayerLeaveMessage
  | PosMessage
  | MinimapMessage
  | AfkMessage
  | ProfileMessage
  | NoticeMessage
  | LikeUpdateMessage
  | GreetingMessage
  | BuildingMessage
  | BuildingPatchMessage
  | VisitorsMessage
  | CityStatusMessage
  | CityFireworksMessage
  | LikesTodayMessage
  | AwaySummaryMessage
  | KnockedMessage;

export const WORLD_SCENE_MESSAGES = [
  'area', 'area.patch', 'players', 'player.join', 'player.leave', 'pos', 'minimap', 'afk', 'profile', 'notice', 'like.update',
  'greeting', 'building', 'building.patch', 'visitors',
  'city', 'city.fireworks', 'likes.today', 'away.summary', 'knock',
] as const satisfies readonly WorldSceneMessage['t'][];

/**
 * Inside a building (Phase 4, Visit scene): interior received from world server in `building` (upon entry or via
 * `resync {building}`), with each `building.patch` applied, and current building `rev`.
 */
export interface WorldSceneInside {
  /** Building ID (owner ID). */
  id: string;
  rev: number;
  detail: WorldBuildingDetail;
}

/** City stats (downstream `city`, Phase 5): lit buildings, weekly goal, and token band (both require 10+ buildings). */
export type WorldSceneCity = Omit<CityStatusMessage, 't'>;

/** Local player in scene: character of this account (from `welcome`), omitting visibility settings. */
export interface WorldSceneMe {
  id: string;
  name: string;
  look: 'f' | 'm';
  parts: AppearanceParts;
  traits: TraitId[];
  intro?: IntroId;
  country?: string;
  /** This account's building (building ID is owner ID), if present in world. */
  buildingId?: string;
}

/** Buildings in chunk with current revision. */
export interface WorldSceneChunk {
  chunk: string;
  rev: number;
  buildings: WorldBuildingPublic[];
}

/** Authoritative local server city snapshot (`world.snapshot` event): browser completely replaces state with this. */
export interface WorldSceneSnapshot {
  /** Stream ID: sent in POST /api/world/cmd. */
  stream: string;
  /**
   * Connection to world server open (`welcome`). Without it (dropped, reconnecting, halted by server), nothing
   * streams downstream. When paused or outside world, opens only with active scene, without building uplink.
   */
  connected: boolean;
  /** `view` dispatched: world server is streaming area and players. */
  viewing: boolean;
  /** Chunk ID district (`<district>:<cx>,<cy>`), from `welcome`. */
  district?: string;
  me?: WorldSceneMe;
  /** Local player position: authoritative downstream `pos` (or local ID in `players`) or last dispatched `move`. */
  pos?: WorldPosition;
  /** Server signaled `afk` and no authoritative user command has occurred yet (move, turn, `view`, `profile`). */
  afk: boolean;
  /** Subscribed chunks (strictly 3×3 chunks around current player position). */
  chunks: WorldSceneChunk[];
  /** Other visible players (never self), with latest positions. */
  players: WorldPlayerPublic[];
  /** Minimap (illuminated buildings per block), or null before initial receipt. */
  minimap: MinimapMessage['blocks'] | null;
  /** Inside building: interior state (until `pos` signaling return to street). Absent on street. */
  inside?: WorldSceneInside;
  /** Latest `city` broadcast (Phase 5): sent upon opening scene and periodically every minute. */
  city?: WorldSceneCity;
  /** Today's likes for owner building (latest downstream `likes.today` on this connection). */
  likesToday?: number;
  /** Latest "While you were away" summary for this connection, until cleared by `summary.seen`. */
  summary?: AwaySummary;
}

/** GET /api/world/status (and verify, login, and logout response). */
export interface WorldStatus {
  /** Whether account actions are permitted (terminal lock enabled: strictly local machine access). */
  available: boolean;
  configured: boolean;
  state: WorldState;
  /**
   * `id`: account ID in world, when known (from building connection `welcome`); included in appeal subject.
   * `reservedName`: player name chosen during registration, reserved while character is not yet created (from `GET /v1/me`).
   */
  account?: { emailMasked: string; access: WorldAccess; id?: string; reservedName?: string };
  player?: Player;
  devices?: DeviceInfo[];
  /** Last error code (worldLastError: known codes only), indicating potentially stale data. */
  lastError?: WorldKnownErrorCode;
  /** Building in world (requires approved account and created character). */
  building?: WorldBuildingStatus;
  /** Stored building theme (PUT /api/world/theme); omitted = 'auto'. */
  theme?: WorldThemeChoice;
  /** Accounts blocked by this user (/v1/me; Phase 5): Settings › Habblaud World › Blocked. */
  blocked?: WorldBlockedPlayer[];
}

/** Blocked player record (world player ID and name only). */
export interface WorldBlockedPlayer {
  id: string;
  name: string;
}

export interface WorldErrorResponse {
  error: { code: string; message?: string; retryAfter?: number };
}

/**
 * Error codes produced by local server. It also reuses selected WORLD_ERROR_CODES from world server with identical
 * semantics: invalid, invalid_code, password_invalid, name_invalid, name_blocked, invalid_json, too_large,
 * unsupported_media_type, method_not_allowed, not_found, and internal (500: local server internal error).
 */
export const WORLD_LOCAL_ERROR_CODES = [
  'not_configured', // 409: no accepted world server (HABBLAUD_WORLD_URL rejected)
  'local_only', // 403: incoming via mobile remote port or non-local Host
  'terminal_off', // 403: terminal lock disabled (port exposed to network or HABBLAUD_TERMINAL=0)
  'not_logged_in', // 401: account action attempted without active session
  'session_expired', // in lastError: world server rejected token (revoked/expired); session wiped
  'invalid_email', // 400
  'altcha_failed', // 502: world server bot challenge could not be solved
  'world_unreachable', // 502: connection to world server failed
  'world_timeout', // 504
  'world_bad_response', // 502: malformed response from world server
  'world_error', // world server error without human-readable code (propagates status)
  'storage_failed', // in lastError: failed to write world.json (session valid only until restart)
  'too_many_streams', // 429: World scene already open in 4 tabs
  'no_stream', // 409: command dispatched to non-existent stream (scene closed or server restarted)
  'not_connected', // 409: command dispatched without active connection to world server
  'account_deleted', // in lastError: account was deleted (locally or remotely) and world.json cleared
  'network', // in lastError: no connection to world server or request timed out
  'unknown', // in lastError: unexpected failure (malformed response, unmapped error code)
] as const;
export type WorldLocalErrorCode = (typeof WORLD_LOCAL_ERROR_CODES)[number];

/** All known error codes: union of world server and local server codes, deduplicated. */
export const WORLD_KNOWN_ERROR_CODES: readonly (WorldErrorCode | WorldLocalErrorCode)[] = [...new Set([...WORLD_ERROR_CODES, ...WORLD_LOCAL_ERROR_CODES])];
export type WorldKnownErrorCode = WorldErrorCode | WorldLocalErrorCode;

export function isWorldKnownErrorCode(v: unknown): v is WorldKnownErrorCode {
  return typeof v === 'string' && (WORLD_KNOWN_ERROR_CODES as readonly string[]).includes(v);
}

/**
 * Error code assigned to WorldStatus.lastError: strictly from whitelist; connection failures or timeouts become `network`,
 * and others (malformed payload, unclassified code, unknown remote code) normalize to `unknown`.
 */
export function worldLastError(code: string): WorldKnownErrorCode {
  if (code === 'world_unreachable' || code === 'world_timeout') return 'network';
  if (code === 'world_bad_response' || code === 'world_error') return 'unknown';
  return isWorldKnownErrorCode(code) ? code : 'unknown';
}
