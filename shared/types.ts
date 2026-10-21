// Shared protocol between server (Node) and client (browser).
// Pure code: no Node or DOM APIs.
//
// Evolution rule: changes here must be ADDITIVE (new optional fields).
// Renaming/removing fields breaks server, world, and UI simultaneously.

import type { AppearanceParts } from './appearance';
import type { WorldMeta } from './world/api';

export type AgentKind = 'main' | 'sub';

/**
 * Which tool the agent comes from (or account, source, session, request). In protocol types the
 * `provider` field is optional and ABSENT means 'claude' (everything prior to Codex remains identical).
 * - claude: Claude Code;
 * - codex: OpenAI Codex (`codex` CLI and desktop app, recording to the same CODEX_HOME).
 */
export type Provider = 'claude' | 'codex' | 'antigravity' | 'kilo';

/**
 * High-level state of an agent — drives character behavior.
 * - working: processing a turn (busy). Sits at desk typing.
 * - waiting: requires user (permission, question, dialog). Sits at desk with hand raised.
 * - idle: finished turn and awaits next instruction. Moves around office (coffee, water cooler...).
 * - shell: finished turn, but background shell(s) are running (see `shells`); waiting for shell to finish.
 *   Sits at desk, watching terminal. (Claude Code transcript records "shell" when session is idle with background shells.)
 * - done: subagent completed. Delivers result to main agent and leaves.
 * - offline: session closed. Leaves (if last in room, turns off light).
 */
export type AgentStatus = 'working' | 'waiting' | 'idle' | 'shell' | 'done' | 'offline';

/** A shell command the agent is waiting to finish. */
export interface ShellJob {
  /** Background task ID (e.g., "bo0ov3q3l") or, in foreground, the tool_use ID. */
  id: string;
  /** Short text: Bash description or summary of command (secrets masked). */
  label: string;
  /** Full command (masked, up to ~300 chars), if available. */
  command?: string;
  /** Epoch ms when command started. */
  startedAt: number;
  /** true = run_in_background (agent ended turn and awaits notification); false = foreground command still without result. */
  background: boolean;
  /** 'monitor' = Monitor tool (tracks a process); 'shell' = Bash. */
  kind: 'shell' | 'monitor';
}

export type ActivityKind =
  | 'prompt' // received new user instruction
  | 'think' // thinking (thinking block)
  | 'respond' // writing text response
  | 'read'
  | 'search'
  | 'edit'
  | 'write'
  | 'run' // terminal command
  | 'test'
  | 'git'
  | 'web'
  | 'browser'
  | 'plan' // tasks / planning
  | 'delegate' // spawned subagent(s)
  | 'communicate' // message to another agent / notice
  | 'ask' // question to user
  | 'mcp'
  | 'skill'
  | 'wait'
  | 'error'
  | 'compact' // context compaction
  | 'done' // finished turn
  | 'other';

export interface Activity {
  /** Unique per activity (e.g., entry uuid + block index). */
  id: string;
  kind: ActivityKind;
  /** Emoji representing the activity. */
  icon: string;
  /** Short text (up to ~46 characters). E.g.: "Editing App.tsx". */
  text: string;
  /** Optional detail (full command, path, query...), up to ~300 characters. */
  detail?: string;
  /** Raw tool name, when present. */
  tool?: string;
  /** Epoch ms. */
  at: number;
  durationMs?: number;
  error?: boolean;
  /** Full questions from an AskUserQuestion (kind 'ask'), for the office to display options. */
  questions?: AskQuestion[];
}

/**
 * A question from AskUserQuestion, already masked and truncated. With the request in the office (PermissionRequestInfo.questions),
 * it can be answered there; otherwise the answer is provided in Claude Code.
 */
export interface AskQuestion {
  /** Position of the question in `tool_input.questions` (invalid entries are skipped, so gaps can occur). */
  index: number;
  question: string;
  header?: string;
  multiSelect?: boolean;
  /** `index` = position of the option in original `options`: this is returned in the answer (PermissionAnswer). */
  options: Array<{ index: number; label: string; description?: string }>;
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface TaskItem {
  id: string;
  title: string;
  status: TaskStatus;
  /** Form in gerund ("Writing tests"), when available. */
  activeForm?: string;
}

export interface AgentStats {
  toolCalls: number;
  /** input + cache read + cache creation. */
  tokensIn: number;
  tokensOut: number;
  costUSD?: number;
  linesAdded?: number;
  linesRemoved?: number;
  /** Total subagents spawned by this agent. */
  subagents: number;
}

export interface AgentInfo {
  /**
   * Stable while agent exists. Claude Code: main "<account>:<pid>", sub "<sessionId>:<agentId>".
   * Codex: main and sub "<account>:<threadId>" (sub with `parentId`).
   */
  id: string;
  kind: AgentKind;
  /** Agent provider tool; absent = 'claude'. */
  provider?: Provider;
  /** For subagents: ID of the agent that spawned it. */
  parentId?: string;
  roomId: string;
  /** Unique human name in the office. E.g.: "Marina". */
  name: string;
  /** Name presentation hint (used by art to vary look). */
  look: 'f' | 'm';
  /** Role. Main: "Main agent". Sub: subagent type ("Explore", "Plan", "fork"...). */
  role: string;
  /** Session title (main) or task description (sub). */
  title?: string;
  sessionId: string;
  /** Origin account = AccountInfo.id (config dir basename, e.g.: ".claude", ".claude-account2"). */
  account: string;
  status: AgentStatus;
  /** Reason when status === 'waiting'. E.g.: "approving a permission". */
  waitingFor?: string;
  /** Current (or most recent) activity. */
  activity?: Activity;
  /** Recent activities, oldest to newest (max ~30). */
  recent: Activity[];
  tasks: TaskItem[];
  /** Running shells the agent awaits: in background and foreground command still without result. */
  shells?: ShellJob[];
  model?: string;
  gitBranch?: string;
  permissionMode?: string;
  startedAt: number;
  lastEventAt: number;
  /** When status last changed (epoch ms). */
  statusSince: number;
  stats: AgentStats;
  /** 32-bit seed for deterministic character appearance. */
  seed: number;
  /** Parts chosen in character editor, applied on top of `seed` appearance (see shared/appearance.ts). */
  parts?: AppearanceParts;
  /** Uses character chosen for project (the room): panel offers "Back to random". */
  custom?: true;
  /** Subagent running in background. */
  background?: boolean;
  /**
   * Permission request answerable via Habblaud (PermissionRequest hook; oldest if multiple).
   * While it exists, agent appears as 'waiting'. See PermissionRequestInfo.
   */
  permission?: PermissionRequestInfo;
  /**
   * Can message this agent via Habblaud (main agents only): session has habblaud-messages plugin
   * and checked inbox recently. See POST /api/messages.
   */
  canMessage?: boolean;
}

export interface RoomInfo {
  /** Stable key: normalized project cwd. */
  id: string;
  /** Display name (cwd basename, disambiguated if repeated). */
  name: string;
  /** Full project path. */
  path: string;
  /**
   * Arrival order of room, assigned by server and stable while room exists (freed slot only
   * reused after waiting period). Client uses only as ordering: in building, each room occupies first free
   * slot, and when a slot opens between rooms, furthest moves into it (client/src/world/sim/sim.ts,
   * compact). Slot in client: col = floor(slot / 2); even = north side of hallway, odd = south side.
   */
  slot: number;
  /** Seed for deterministic colors/decorations. */
  seed: number;
  createdAt: number;
  /** Temporary visual effect in room (GitHub events detected in transcripts; see shared/github.ts). */
  effect?: RoomEffect;
}

/**
 * Temporary effect in project room, triggered by live GitHub event:
 * - party: celebration (PR opened or merged, release, CI green after alarm); lasts ~12 s;
 * - alarm: CI red; lasts until CI green in that room or expires in ~10 min.
 */
export interface RoomEffect {
  kind: 'party' | 'alarm';
  /** Short banner text. E.g.: "PR #12 merged!", "CI failed (feat/x)". */
  text: string;
  /** Start (epoch ms, server clock): a new effect has another `at`. */
  at: number;
  /** Scheduled end (epoch ms, server clock). */
  until: number;
  /** Responsible agent: opened/merged (party) or saw CI fail (alarm, "!" balloon). */
  agentId?: string;
}

/**
 * New version check: server queries latest repository release on GitHub
 * (server/updates/checker.ts) and compares with current version.
 */
export interface UpdateStatus {
  /**
   * - off: check disabled (HABBLAUD_UPDATE_CHECK=0 or package.json without GitHub repo);
   * - pending: not checked yet;
   * - ok: checked (with or without published release);
   * - error: last attempt failed (no internet, GitHub rate limit...).
   */
  state: 'off' | 'pending' | 'ok' | 'error';
  /** Queried repository, "owner/name". */
  repo?: string;
  /** Last successful query (epoch ms). */
  checkedAt?: number;
  /** Version of latest release, without "v" (absent: no release published). */
  latest?: string;
  /** Latest release page on GitHub. */
  url?: string;
  /** Publication timestamp of latest release (epoch ms). */
  publishedAt?: number;
  /** Latest release is newer than current version. */
  available: boolean;
  /** Failure reason (state "error"). */
  error?: string;
}

export interface SourceInfo {
  /** Account label (config dir basename). */
  label: string;
  /** Source provider; absent = 'claude'. */
  provider?: Provider;
  path: string;
  /** Open sessions detected in this source. */
  sessions: number;
  ok: boolean;
  error?: string;
}

/** Usage limit window of plan (e.g. 5h session, week). */
export interface UsageWindow {
  /** Percentage used, 0–100. */
  utilization: number;
  /** When window resets (epoch ms). */
  resetsAt?: number;
}

export interface TokenUsageWindow {
  tokens: number;
  tokensIn?: number;
  tokensOut?: number;
}

export interface AccountUsage {
  /** 5-hour session. */
  fiveHour?: UsageWindow;
  /** Weekly limit (all models). */
  sevenDay?: UsageWindow;
  sevenDayOpus?: UsageWindow;
  sevenDaySonnet?: UsageWindow;
  /** Daily token usage (24 h) for tools based on real token count (Antigravity, Kilo). */
  dailyTokens?: TokenUsageWindow;
  /** Weekly token usage (7 d). */
  weeklyTokens?: TokenUsageWindow;
  /** Total accumulated tokens. */
  totalTokens?: TokenUsageWindow;
  /**
   * Origin of numbers (all are local files saved by the tool itself):
   * - 'statusline': captured live and saved to ~/.habblaud/usage/<account>.json by Habblaud mod
   *   (mod/habblaud, recommended) or by scripts/statusline-tap.mjs (rate_limits field of statusline);
   * - 'cache': `cachedUsageUtilization` saved by Claude Code itself (updates when someone runs /usage);
   * - 'codex': `rate_limits` from Codex session files (only renew while a session is running).
   */
  source: 'cache' | 'statusline' | 'codex' | 'antigravity' | 'kilo';
  /** Who wrote the live file ('statusline'): Habblaud mod in Claude Code or statusline tap. */
  via?: 'mod' | 'tap';
  /**
   * Account without quota or credits to use now (Codex: `rate_limits.primary` null, e.g. workspace credits
   * exhausted). Not "0% used": windows are absent.
   */
  noQuota?: boolean;
  /** When numbers were fetched at source (epoch ms). */
  fetchedAt: number;
}

/** A Claude account (a config dir: ~/.claude, ~/.claude-account2, ...) or Codex (a CODEX_HOME: ~/.codex). */
export interface AccountInfo {
  /** = AgentInfo.account (config dir basename, e.g. ".claude"); unique among accounts of all tools. */
  id: string;
  /** Account provider; absent = 'claude'. */
  provider?: Provider;
  /** Very short label (1–3 chars), e.g. "C" and "D" — shortcuts detected in shell — or derived. */
  short: string;
  /** Friendly name. E.g.: "Account C". */
  name: string;
  email?: string;
  organization?: string;
  /** Plan, when known (e.g. "Max", "Pro"). */
  plan?: string;
  /** Account identification color (hex). */
  color: string;
  configDir: string;
  /** Currently open sessions in this account. */
  sessions: number;
  usage?: AccountUsage;
  /**
   * - ok: recent numbers;
   * - stale: old numbers (e.g. /usage cache from hours ago);
   * - disabled: no numbers (statusline tap not installed and no /usage cache).
   */
  usageStatus: 'ok' | 'stale' | 'disabled';
}

export interface OfficeSnapshot {
  /** Increments on each change. */
  rev: number;
  serverTime: number;
  rooms: RoomInfo[];
  agents: AgentInfo[];
  /** Interactive terminals opened by Habblaud (Claude Code running inside browser). */
  ptys?: PtyInfo[];
  /** Claude accounts detected (with 5h/weekly usage when available). */
  accounts: AccountInfo[];
  meta: {
    demo: boolean;
    sources: SourceInfo[];
    startedAt: number;
    version: string;
    /**
     * Client build identifier served by server (bundle name, e.g. "main-BFqheOCa").
     * A page open with another build is outdated and should reload. Absent in dev mode.
     */
    build?: string;
    /**
     * Terminal (GET /api/agents/:id/terminal) available: only when Habblaud is not
     * exposed beyond the local machine (local bind). Absent/false = feature disabled.
     */
    terminal?: boolean;
    /**
     * In-office messaging enabled (POST /api/messages): same guard as terminal and HABBLAUD_MENSAGENS
     * not disabled. Current recipient indicated by AgentInfo.canMessage. Absent/false = feature disabled.
     */
    messages?: boolean;
    /**
     * Interactive terminal (open/attach sessions and terminate agents via office): only outside Docker,
     * with node-pty and local access. Absent = feature disabled.
     */
    pty?: PtyStatus;
    /** Check for new version on GitHub (absent in tests and timelapse). */
    updates?: UpdateStatus;
    /**
     * Habblaud World (server/world/): `enabled` = section visible (HABBLAUD_WORLD not 0 and world server
     * accepted: default, server.habblaud.com, or valid HABBLAUD_WORLD_URL; if rejected, feature is disabled and
     * nothing of World appears); `configured` = world server accepted; `state` = account on this machine;
     * `building` (additive, only with approved account and created character) = building summary in world:
     * connected, paused, floors and agents of last shipment and timestamp, whether left world and whether world server
     * stopped it (without reason, which only goes into status). Nothing of account beyond that (snapshot also sent to phone
     * and timeline). Absent in tests and timelapse.
     */
    world?: WorldMeta;
  };
}

/**
 * What THIS page can do (GET /api/access): local port allows everything via local Host; remote port with login
 * (server/http/remote.ts) only what HABBLAUD_REMOTE_ALLOW permits. `local` = opened by local machine (edit
 * character and rename rooms, which never apply via remote port).
 */
export interface AccessInfo {
  remote: boolean;
  local: boolean;
  permissions: boolean;
  messages: boolean;
  terminal: boolean;
  /** Can spawn new agents in Claude app (POST /api/spawn). */
  spawn: boolean;
  /**
   * Can use Habblaud World account (/api/world/*): feature enabled (HABBLAUD_WORLD), terminal guard and local port
   * with local Host. Absent on older servers.
   */
  world?: boolean;
}

export interface FeedItem {
  id: string;
  agentId: string;
  roomId: string;
  agentName: string;
  roomName: string;
  /** Agent account (= AccountInfo.id). */
  account?: string;
  activity: Activity;
}

export type NoticeLevel = 'info' | 'success' | 'warn' | 'alert';

export interface Notice {
  id: string;
  level: NoticeLevel;
  text: string;
  agentId?: string;
  roomId?: string;
  at: number;
}

/**
 * Server messages via SSE at GET /api/stream.
 * Each message arrives as a named SSE event (`event: snapshot|feed|notice`) whose `data` is the JSON of `data`.
 * On connect, server sends a full `snapshot` and a `feed` with recent items.
 */
export type ServerMessage =
  | { type: 'snapshot'; data: OfficeSnapshot }
  | { type: 'feed'; data: FeedItem[] }
  | { type: 'notice'; data: Notice };

/** Response of GET /api/agents/:id */
export interface AgentDetail {
  agent: AgentInfo;
  /** Longer history (max ~200), oldest to newest. */
  history: Activity[];
}

// ------------------------------------------------------------------ Claude Code mod

/**
 * Response of GET /api/mod/summary: minimum needed by Claude Code mod (mod/habblaud) for
 * "needs you" line below prompt and for /habblaud command. Real agents only (demo excluded)
 * and active (excluding closed or finished); with `?session=` (and `?account=`), without the querying session itself:
 * its main agent and subagents.
 */
export interface ModSummary {
  /** Habblaud version in use. */
  version: string;
  /** Active agents and count of working agents. */
  agents: number;
  working: number;
  /** Who needs you, ordered from longest waiting to shortest waiting. */
  waiting: ModWaitingAgent[];
}

export interface ModWaitingAgent {
  /** = AgentInfo.id. */
  id: string;
  name: string;
  /** Displayed room (project) name. */
  room: string;
  /** = AccountInfo.id. */
  account: string;
  /** Reason (AgentInfo.waitingFor), e.g.: "approving a permission". */
  waitingFor: string;
  /** Waiting since (epoch ms). */
  since?: number;
  /** Has permission request answerable via office (AgentInfo.permission). */
  answerable: boolean;
}

// ------------------------------------------------------------------ terminal

/**
 * How to display the `input` of a tool call:
 * - command: shell command; diff: "- old" / "+ new" lines (Edit/Write); json: raw arguments; text: free text.
 */
export type TerminalInputKind = 'command' | 'diff' | 'json' | 'text';

/**
 * A terminal entry: session conversation reconstructed from JSONL transcript,
 * in the format shown by Claude Code. All text already has secrets masked and is truncated.
 * Entries are only appended (never edited): tool result arrives later, in a
 * 'result' entry pointing to 'tool' via `toolUseId`.
 */
export type TerminalEntry =
  /** User prompt or slash command (e.g.: "/model"). */
  | { kind: 'user'; id: string; at: number; text: string }
  /** Agent response text (markdown). */
  | { kind: 'assistant'; id: string; at: number; text: string }
  /** Thinking block; `text` absent when transcript only stores signature. */
  | { kind: 'thinking'; id: string; at: number; text?: string }
  /**
   * Tool call. `id` = tool_use id. `title` in Claude Code style: "Bash(npm test)",
   * "Read(server/index.ts)". `input` = relevant arguments (command, diff...), when present.
   */
  | { kind: 'tool'; id: string; at: number; tool: string; title: string; input?: string; inputKind?: TerminalInputKind }
  /** Tool result. `truncated` = text was truncated (result too long). */
  | { kind: 'result'; id: string; at: number; toolUseId: string; text: string; error?: boolean; truncated?: boolean }
  /** Session event: compaction, interruption, background result, API error... */
  | { kind: 'system'; id: string; at: number; text: string; detail?: string; level?: 'info' | 'warn' | 'error' };

/** `init` event of terminal stream: recent conversation (replaces all client has). */
export interface TerminalInit {
  agentId: string;
  /** Oldest to newest. */
  entries: TerminalEntry[];
  /** Earlier conversation exists that was not loaded (transcript is larger than read window). */
  truncated: boolean;
}

/**
 * Terminal stream (Server-Sent Events) at GET /api/agents/:id/terminal.
 * On connect (and upon each reconnect, or if transcript was truncated/replaced) an `init` arrives;
 * thereafter, `append` with new entries. Errors before stream respond with JSON `{error}`:
 * 403 (feature disabled or non-local access), 404 (unknown agent/transcript),
 * 429 (too many open terminals).
 */
export type TerminalMessage = { type: 'init'; data: TerminalInit } | { type: 'append'; data: TerminalEntry[] };

/**
 * A recent session (open or closed) in terminal history, at
 * GET /api/sessions/recent. Closed session conversation is served with same terminal protocol
 * as agent (TerminalMessage), from GET /api/sessions/:account/:sessionId/terminal.
 */
export interface RecentSession {
  /** = AccountInfo.id. */
  account: string;
  /** Session provider; absent = 'claude'. */
  provider?: Provider;
  sessionId: string;
  /** Project path (`cwd` from first lines of transcript); absent if unable to detect. */
  project?: string;
  /** Project folder name in `projects/` (encoded cwd), for when `project` is missing. */
  projectDir: string;
  /** Title like agent: /rename > agent name > auto title > last prompt (or first). */
  title?: string;
  /** First and last timestamped activity (epoch ms); `lastAt` falls back to file mtime without trailing timestamp. */
  firstAt?: number;
  lastAt: number;
  /** Transcript size in bytes. */
  size: number;
  /** Session is still open: `agentId` is its main agent in the office. */
  open: boolean;
  agentId?: string;
}

// ------------------------------------------------------------------ deliveries

/** Delivery attachment kind, to choose viewer. */
export type DeliveryAttachmentKind = 'image' | 'pdf' | 'video' | 'page' | 'text' | 'file';

/** File delivered by agent (SendUserFile, link in response) or captured screen at end of work. */
export interface DeliveryAttachment {
  /** Opaque ID for GET /api/deliveries/file/:id (never path). */
  id: string;
  name: string;
  kind: DeliveryAttachmentKind;
  /** Agent caption (SendUserFile) or "Captured screen". */
  caption?: string;
  /** Screenshot captured from within conversation (not a file on computer). */
  capture?: boolean;
}

/**
 * A delivery: completion of a request where agent worked (used tools) and responded. Built from transcript
 * (server/deliveries/deliveries.ts), structured for user review: headline, summary, request, and attachments.
 */
export interface DeliveryInfo {
  /** "<account>:<session>:<request entry>". */
  id: string;
  account: string;
  provider?: Provider;
  sessionId: string;
  /** Agent still in office (for avatar and "open terminal"). */
  agentId?: string;
  /** Agent name (office name) or session title. */
  agentName?: string;
  project?: string;
  /** What was requested (single line). */
  request: string;
  /** First sentence of response, without markdown. */
  headline: string;
  /** Plain language paragraph (last of response), when present. */
  summary?: string;
  /** Full response (markdown). */
  text: string;
  startedAt: number;
  finishedAt: number;
  /** Tools used and files modified in request. */
  tools: number;
  edited: number;
  attachments: DeliveryAttachment[];
}

export interface DeliveriesResponse {
  deliveries: DeliveryInfo[];
}

/** Response of GET /api/sessions/recent: newest to oldest activity. */
export interface RecentSessionsResponse {
  sessions: RecentSession[];
  /** Listing window (days) and maximum sessions. */
  days: number;
  limit: number;
}

// ------------------------------------------------------------------ answering from office

/** "Always allow" rule suggested by Claude Code for a request (hook permission_suggestions). */
export interface PermissionSuggestionInfo {
  /** Position in list received by hook: returned in decision (hook applies original suggestion). */
  index: number;
  /** Rules in Claude Code permission format, e.g. "Bash(npm test:*)". */
  rules: string[];
  /** Where rule is saved: 'session', 'localSettings', 'projectSettings' or 'userSettings'. */
  destination: string;
}

/**
 * Pending permission request answerable via Habblaud: Claude Code PermissionRequest hook
 * (mod/habblaud-permissoes/hooks/permission-hook.mjs) registers it and awaits decision. Only exists with local bind
 * (same guard as terminal) and with some Habblaud page open.
 * In snapshot sent without `input` (full arguments only returned by GET /api/permissions/:id, with local
 * access); demo mock requests include it.
 */
export interface PermissionRequestInfo {
  id: string;
  /** Tool provider of requester; absent = 'claude'. */
  provider?: Provider;
  /** Raw tool name (e.g. "Bash", "Edit", "mcp__github__create_issue"). */
  tool: string;
  /** Title in Claude Code style: "Bash(npm test)", "Edit(src/app.ts)". Masked and truncated. */
  title: string;
  /** Short summary (e.g. "Running tests") and activity icon. */
  text: string;
  icon: string;
  /** Arguments (command, diff, JSON...), masked and truncated. */
  input?: string;
  inputKind?: TerminalInputKind;
  /** Request from a subagent Habblaud does not yet show: its type (e.g. "Explore"). */
  subagent?: string;
  /** "Always allow" rules that can be applied along with approval. */
  suggestions?: PermissionSuggestionInfo[];
  /**
   * AskUserQuestion request: questions, to answer from office (`answer` decision). Also sent in
   * snapshot (without them card has nothing to display).
   */
  questions?: AskQuestion[];
  /** Other requests from same agent queued after this one. */
  queued?: number;
  createdAt: number;
  /** When hook stops waiting and request falls back to terminal only. */
  expiresAt: number;
}

/**
 * Answer to an AskUserQuestion question, by POSITION (AskQuestion.index and options `index`): hook replaces
 * positions with original texts received from Claude Code (page only sees masked and truncated texts).
 */
export interface PermissionAnswer {
  /** AskQuestion.index. */
  question: number;
  /** Positions of selected options (single option without multiSelect). */
  options?: number[];
  /** Free text ("Other"). Without multiSelect, replaces an option. */
  other?: string;
}

/** Body of POST /api/permissions/:id/decision (from page). */
export interface PermissionDecision {
  /**
   * allow = approve; deny = reject; terminal = return request to terminal (hook exits without deciding);
   * answer = answer questions from an AskUserQuestion (`answers`).
   */
  behavior: 'allow' | 'deny' | 'terminal' | 'answer';
  /** Denial: reason passed back to agent. */
  message?: string;
  /** Denial: interrupts agent (stops and waits for you). */
  interrupt?: boolean;
  /** Approval: also applies suggestion at this position (PermissionSuggestionInfo.index). */
  suggestion?: number;
  /** Answers (`answer`): one per request question. */
  answers?: PermissionAnswer[];
}

// ------------------------------------------------------------------ messages from office

/**
 * Status of a message sent by page to an agent (GET /api/messages/:id):
 * queued = waiting for session to fetch; sent = session fetched and is delivering; delivered = entered session (or
 * its queue, if agent was busy); failed = did not enter (`error` explains why).
 */
export type OutboxStatus = 'queued' | 'sent' | 'delivered' | 'failed';

export interface OutboxMessage {
  id: string;
  /** AgentInfo.id of recipient (always a main agent). */
  agentId: string;
  status: OutboxStatus;
  error?: string;
  createdAt: number;
  /** Last status change. */
  updatedAt: number;
}

/** Interactive terminal state (OfficeSnapshot.meta.pty). */
export interface PtyStatus {
  enabled: boolean;
  /** Why it is disabled. */
  reason?: string;
}

/** Interactive terminal opened by Habblaud (node-pty on server, xterm.js in browser). */
export interface PtyInfo {
  id: string;
  /** Claude Code PID: corresponding agent is `${account}:${pid}` (= agentId). */
  pid: number;
  cwd: string;
  account: string;
  agentId: string;
  /** Resumed session (`claude --resume`), when terminal attached to an existing session. */
  resumed?: string;
  /** Agent this terminal attached to (old ID, of terminated process). */
  fromAgent?: string;
  startedAt: number;
  exitedAt?: number;
  exitCode?: number;
}

/** Message delivered to habblaud-messages plugin (POST /api/mod/inbox). */
export interface InboxMessage {
  id: string;
  /** Text as typed: plugin sends it to session as if you typed it. */
  text: string;
}
