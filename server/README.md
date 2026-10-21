# Habblaud Server

Pure Node (zero runtime dependencies). Monitors **active** Claude Code sessions across all
accounts on the machine, maintains the office model, and streams everything via SSE.

```
npm run dev      # server + Vite (middleware, HMR) at http://127.0.0.1:4747
npm run build && npm start   # production: serves dist/client
```

## Data Sources (Read-Only)

| Data | Location |
| --- | --- |
| Active sessions and status (busy/idle/waiting) | `<config>/sessions/<pid>.json` (+ live PID check outside Docker) |
| Activities, tasks, title, token metrics | `<config>/projects/<cwd>/<sessionId>.jsonl` (reads last ~1 MB at boot; head parsed in background) |
| Subagents (including workflows) | `<config>/projects/<cwd>/<sessionId>/subagents/**/agent-*.jsonl` + `.meta.json` |
| Account (email, organization) and usage cache | `~/.claude.json` (default account) or `<config>/.claude.json` — these fields only |
| Live usage (5h and weekly) | `~/.habblaud/usage/<account>.json`, recorded by Habblaud mod (`npm run mod:install`) or `scripts/statusline-tap.mjs` (`npm run usage:install`) |
| Account alias (`c`, `d`...) | `alias x='... claude ...'` lines from `~/.zshrc`, `~/.bashrc`, `~/.zprofile`, `~/.bash_profile` |

**Forks** (subagents inheriting context from parent): the transcript starts with a `fork-context-ref` line,
a copy of the parent's `Agent` call (same `tool_use` id as in `.meta.json`), and its result ("Fork started…") together
with the fork instruction. The parser ignores this copy — otherwise the inherited result appears to conclude the
subagent and the fork never appears in the office — and treats the text following `</fork-boilerplate>` as its initial prompt.

## Waiting for Shell

The `shell` status (see `shared/types.ts`) represents an agent that completed its turn while background commands
are still running. Derived from the registry (`"status": "shell"`, Claude Code 2.1.292+, which excludes monitors); in
versions not recording `shell`, a registry `idle` + background Bash without notification within the last 12 h becomes `shell`.

`sources/shells.ts` tracks, per session (lead and subagents), the `ShellJob` objects published in `AgentInfo.shells`:
Bash with `run_in_background` (id mapped to `backgroundTaskId` from tool_result), foreground Bash awaiting
result (`background: false`; temporarily hidden while session awaits user permission), and `Monitor` (`kind: 'monitor'`).
Termination triggers: `<task-notification>` (`queue-operation`/`enqueue` line, user message or attachment) matching `task-id`
or `tool-use-id`; `TaskStop`/`KillShell`/`KillBash`; turn conclusion / interrupt (foreground); `/clear` or session
exit; jobs prior to current process (resumed session) or older than 24 h. A terminated background shell turns
into a `tool: 'ShellDone'` activity (`error` = failed/interrupted; world celebrates or laments) and a notice;
while in `shell` status, the agent's thought bubble displays "⏳ Waiting for shell: <label>" (`tool: 'ShellWait'`).

## GitHub in the Office

`sources/github.ts` extracts GitHub events from transcripts, requiring zero tokens and zero network access (works inside Docker): the parser tracks
relevant tool invocations (Bash with `git push`/`gh pr create|merge|checks`/`gh run watch|view`/`gh release create`, stripped of heredocs
and with command chains split, plus GitHub MCP server tools) and inspects their results:

- **preferred source:** `toolUseResult.gitOperation`, written natively by Claude Code (`{pr: {number, url, action:
  'created'|'merged'}, push: {branch}}`);
- **command output:** URL `…/pull/<n>` from `gh pr create`; `gh pr merge` without errors or failure indicators (and without `--auto`);
  `abc..def  main -> main` / `* [new branch]` lines following `To <remote>`; header `✓|X <branch> <workflow> · <id>`
  or `completed with '<conclusion>'` from `gh run watch|view`, `--json`/`--jq` conclusions, `gh pr checks` (tabs, summary,
  or `--json`; pending checks excluded); URL `…/releases/tag/<tag>` from `gh release create` (drafts excluded); MCP tool JSON;
- **exit code:** `gh run watch --exit-status` or `gh pr checks` as final command, unpiped (otherwise exit code belongs to another
  binary) — in foreground ("Exit code N") or background (`<task-notification>` summary). Codes ≥ 128 (killed)
  and 8 (`gh pr checks` pending) are ignored.

Failed, blocked, or interrupted commands produce no events (only red CI uses the error). The `github` signal triggers
`Office.githubEvent`: activity `tool: 'GitHub'` (`shared/github.ts`) and, live only (never during initial boot or for
lines older than 2 min), an alert and room visual effect published in `RoomInfo.effect` (`{kind: 'party'|'alarm', text, at, until, agentId}`):
party (opened/merged PR, release) lasting 12 s; alarm (red CI) until green CI in room (triggering a party) or 10 min.
Push events display notifications only. Duplicate CI events seen within 2 min do not repeat notices.

## API

| Route | Description |
| --- | --- |
| `GET /api/stream` | SSE: `snapshot`, `feed`, `notice` events (see `shared/types.ts`); 15 s keepalive ping |
| `GET /api/snapshot` | Current `OfficeSnapshot` |
| `GET /api/agents/:id` | `AgentDetail` (history of up to 200 activities) |
| `GET /api/agents/:id/terminal` | Terminal SSE: `init` and `append` events (`TerminalMessage`); requires local bind (see below) |
| `PUT /api/agents/:id/character` | Project character: `{name, seed, parts}` (see below); `200 {ok}`, `400`, `404` (not a lead in active session), `409` (name in use); local access only |
| `DELETE /api/agents/:id/character` | "Reset to random": removes custom character from room; `200 {ok}` or `404`; local access only |
| `GET /api/sessions/recent` | `RecentSessionsResponse`: sessions from past 7 days across all accounts (up to 150); same terminal guard |
| `GET /api/sessions/:account/:sessionId/terminal` | Historical session terminal SSE (same terminal protocol); same guard |
| `GET /api/stats?day=YYYY-MM-DD&tz=<IANA>&source=real\|demo` | `DayStatsResponse` for "My Day" (see below); defaults: today, server timezone, demo if active and day is today |
| `GET /api/stats/days?tz=<IANA>` | `StatsDaysResponse`: dates with real recorded data (and demo, if active), latest first |
| `GET /api/timeline/days` | `{recording, days:[{day, bytes, from, to}]}`: dates recorded for timelapse, latest to oldest |
| `GET /api/timeline/:day` | Daily timelapse JSONL (`YYYY-MM-DD`) (`application/x-ndjson`, gzip if supported); 400 for invalid date, 404 if missing |
| `GET /api/health` | `{ok, version, demo, docker, terminal, permissions, messages, updates:{state, latest, available}, sources, accounts:[{id, usageStatus}]}` |
| `POST /api/demo` | `{enabled: boolean}` toggles simulated agents (interleaved with real sessions) |
| `GET /api/mod/summary?account=&session=` | `ModSummary` for Claude Code mod: `{version, agents, working, waiting:[{id, name, room, account, waitingFor, since, answerable}]}`, excluding demo and caller session (see below) |
| `GET /api/updates` | `{version, ...UpdateStatus}`: running version and update check result (see below) |
| `POST /api/updates/check` | "Check now": checks GitHub (max once per 30 s) and returns `{version, ...UpdateStatus}` |
| `/api/world/*` | Habblaud World (account, character, building; enabled by default, disabled via `HABBLAUD_WORLD=0`): local port with local `Host` only; see below |
| `POST /api/permissions` | (hook) registers permission request: `201 {id, expiresAt}` or `200 {skip}`; local bind only (see below) |
| `GET /api/permissions/:id/wait` | (hook) long-poll up to 25 s (`?timeout=` in seconds): `{status: 'pending' \| 'decided' \| 'released', ...}` |
| `GET /api/permissions/:id` | (client) request detail including input arguments (`PermissionRequestInfo` with `input`) |
| `POST /api/permissions/:id/decision` | (client) `PermissionDecision`: `{behavior: 'allow' \| 'deny' \| 'terminal' \| 'answer', message?, interrupt?, suggestion?, answers?}` |
| `POST /api/messages` | (client) `{agentId, text}`: dispatches message to lead agent; `201 OutboxMessage`; local bind only (see below) |
| `GET /api/messages/:id` | (client) message delivery status (`OutboxMessage`: `queued` \| `sent` \| `delivered` \| `failed`) |
| `POST /api/mod/inbox` | (`habblaud-mensagens` plugin) `{session, account?}`: registers session heartbeat and retrieves `{messages: InboxMessage[]}` |
| `POST /api/mod/inbox/ack` | (plugin) `{session, results: [{id, ok, error?}]}`: acknowledges delivered messages (or reports failure) |

The snapshot (SSE and `GET /api/snapshot`) contains only the 8 most recent activities per agent in `recent`;
history up to 200 activities (including transcript heads parsed asynchronously) is queried via `GET /api/agents/:id`.

Perimeter security (`http/guard.ts`, applied across API, static files, and Vite): `Host` must match `localhost`/`*.localhost`, an IP address,
or an entry in `HABBLAUD_ALLOWED_HOSTS` (mitigating DNS rebinding) → else 403; `POST` on `/api/*` requires
`Content-Type: application/json` (415) and same-origin or local `Origin` (403), mitigating CSRF. JSON responses
are emitted with `nosniff` and `Cross-Origin-Resource-Policy: same-origin`, omitting CORS.

## New Version Checks

`updates/checker.ts` queries `GET https://api.github.com/repos/<owner>/<repo>/releases/latest`, without authorization tokens, 5 s after
startup and every 6 h subsequently (1 h after failures). Target repository is extracted from `package.json`'s `repository` field
(forks need only update that field). Requests send `If-None-Match` with previous ETag, ensuring 304 responses
do not consume the unauthenticated 60 req/hr rate limit. State (`repo`, `checkedAt`, `etag`, `latest`, `url`,
`publishedAt`) is cached in `<dataDir>/updates.json` to prevent re-querying across restarts. Tags must follow
semver (`v1.2.3` or `1.2.3-beta.1`) and are compared against `package.json`. Responses: 404 = no releases
(`ok` without `latest`); 403/429 = GitHub rate limiting (`error`). On failure, latest known release remains
active. Status is published in snapshot `meta.updates` (`UpdateStatus` in `shared/types.ts`) and triggers snapshot
re-broadcast upon changes. Release URL is validated to originate from the repository itself. Newly detected
releases are logged once. `HABBLAUD_UPDATE_CHECK=0` disables checks (`state: 'off'`).

Each version maintains a dedicated section in `CHANGELOG.md`; tests enforce that `package.json`'s version exists in changelog,
and `npm run release` (`scripts/release.ts`) tags and publishes releases using corresponding changelog notes.

## Terminal

`GET /api/agents/:id/terminal` (`http/terminal.ts`) streams session conversation history — prompts, responses,
tool calls, and results formatted identically to Claude Code — parsed from transcripts via `sources/terminal.ts`,
with secrets masked and text truncated. Upon connection (and re-connection), an `init` event transmits the latest
500 entries from the trailing ~4 MB of transcript (`truncated: true` if earlier lines omitted); followed by 400 ms
polling emitting `append` events with new items. Truncated, rotated, or cleared transcripts (`/clear` in same process)
trigger a fresh `init`; missing files continue polling. Simulated demo agents lack transcripts: mock dialogue originates
from `shared/demo/terminal.ts` (updated every 500 ms). 15 s keepalive ping, maximum 8 concurrent terminals,
clients buffering >8 MB are disconnected. Input entered in terminal footer dispatches as a message (see
[Messages via Office](#messages-via-office)); terminal stream remains strictly read-only.

This endpoint is strictly gated behind **local bind** (`config.ts`, `terminalOffReason`) as it exposes complete transcripts:

- Node: `HABBLAUD_HOST` loopback (127.0.0.0/8, `::1`, `localhost`); `0.0.0.0`, `::`, or network IPs disable it;
- Docker: process listens on `0.0.0.0` inside container, so host-published port `HABBLAUD_BIND` dictates
  access (`docker-compose.yml` forwards this to container): loopback enables; omitted, empty, or network binding disables;
- `HABBLAUD_TERMINAL=0` always disables; no configuration enables terminal on exposed ports.

Furthermore, every request requires a local `Host` header (`localhost`, `*.localhost`, 127.x, or `[::1]`): network IPs
and names in `HABBLAUD_ALLOWED_HOSTS` (proxies, tunnels) receive 403. Status is reflected in snapshot `meta.terminal`
and in `terminal` under `/api/health`. Early errors return JSON `{error}`: 403 (disabled or non-local access),
404 (unknown agent or transcript), 405 (non-GET method), 429 (terminal concurrency limit), and 500 (unreadable transcript).

## Timelapse Timeline

`history/timeline.ts` records office state for client timelapse playback at `<HABBLAUD_DATA_DIR>/timeline/YYYY-MM-DD.jsonl`
(server local date; `/data/timeline` in Docker). Format and re-assembly documented in `shared/timeline.ts`; one record per line:

- `{"t":"k", at, v, every, boot?, rooms, agents, accounts}`: **keyframe**, full state snapshot. Starts each file,
  recurs every 5 min (`every`), and marks server boot events;
- `{"t":"d", at, rooms?, agents?, accounts?}`: **delta**, changed fields only (`[id, object | null]` for rooms and accounts;
  `[id, changedFields | null]` for agents, with `null` indicating removed entity/field);
- `{"t":"end", at, reason?}`: server shutdown (`SIGTERM`/`SIGINT`) or day reached storage threshold (`reason: "limit"`).

Triggered by every snapshot emitted by `Hub` (`hub.onSnapshot`, i.e., each `Office` state modification), throttled to
1 s and filtered to visual updates. Per agent: id, kind, parentId, room, name, look, role, account,
status (with `statusSince`), waitingFor, activity (`kind`, `icon`, `text`, `at`, `tool`, `error`), seed,
background, title, and summarized shell jobs (omitting raw commands); demo mode entities (`demo:`) carry
`demo: true`. Accounts omit email, organization, and folder paths. Zero transcripts: mirrors `/api/snapshot`
exposure, allowing endpoints to be queried across any binding.

- **Limits:** exceeding 20 MB/day throttles deltas to 15 s and keyframes to 15 min; exceeding 30 MB suspends recording until midnight.
- **Retention:** trailing 7 days (including today); strictly `YYYY-MM-DD.jsonl` files are purged.
- **Disk Failures:** non-fatal: logs warning, retries in 1 min, restarting with a fresh keyframe.
- **Gaps:** periods lacking records exceeding ~1.5× `every` (or following `end`) render as "no data" in player.
- `HABBLAUD_TIMELINE=0` disables recording (routes continue serving existing files).

URL date parameter strictly accepts `YYYY-MM-DD` syntax; file paths are constructed securely without relative traversal
or encoded slashes. `scripts/demo-timeline.ts` (`npm run demo:timeline`) leverages the same recorder, with simulated clock
and `DemoSimulator`, to generate synthetic timelapse logs.

## My Day (Daily Statistics)

`history/daystats.ts` samples office snapshots at 1 s intervals and passes agents to the pure tracker in
`shared/daystats.ts`, integrating elapsed time per status per agent (`working`, `waiting`, `shell`, `idle`; `done`
and `offline` excluded), splitting intervals at `statusSince`. Sampling intervals >2 min (stopped server, sleep mode)
are ignored. User wait episodes represent continuous `waiting` periods (durations <3 s excluded from ranking);
"clock time with active waiters" unions overlapping wait intervals across all agents.

- **Metrics:** `AgentStats` is cumulative per agent, counting increments beyond maximum seen value (re-parsing existing
  transcripts avoids duplicate counts). Pre-existing agents (boot, `/resume`) establish baseline over initial 20 s
  (90 s on boot while long transcript heads are parsed); newly spawned subagents and sessions (or `/clear`) count
  from zero. Impossible spikes in a single sample (>60 tools or 5 M tokens) are treated as transcript re-scans.
  Costs reported on pre-existing agents represent session totals: used as reference only. Prompts originate
  from `prompt` activities after server startup; completed tasks reflect task counter increments. Departed
  and returned agents preserve baselines for 6 h.
- **Hourly UTC-aligned buckets** (by room, account, and present sessions/subagents), stored per server-local calendar date.
  Queried dates are synthesized using browser's `tz` parameter: under Docker (UTC), dashboard days align to user midnight.
- **Files:** `<dataDir>/stats/YYYY-MM-DD.json` (`StatsDayFile`, version 1), written every 30 s and at shutdown (atomic
  temp file + `rename`); boot loads yesterday and today, indexes others, and deletes records older than 30 days. Unreadable
  files become `.corrupt` and restart; disk errors log warnings without crashing.
- **Demo Mode:** `demo:` agents never contaminate real statistics. An isolated in-memory bucket seeds synthetic history
  from yesterday onwards (`shared/demo/daystats.ts`) and ingests live simulation data.
- **Exposure:** strictly aggregated numbers, project names, accounts, and agent names (identical to `/api/snapshot`),
  bypassing local terminal bind requirement. Errors: 400 (malformed `YYYY-MM-DD`, future date, duplicate params,
  invalid `tz`/`source`), 404 (no data, expired retention, or disabled demo), 405.

Static assets (`http/static.ts`): `/bundle/*` (hashed Vite build output, `build.assetsDir`) with 1-year `immutable` cache;
remainder (`index.html`, `client/public` under `/assets/*`) served with `no-cache` + `ETag`/`Last-Modified` (304).

## Session History

`sources/history.ts` lists, on demand, top-level transcripts `<config>/projects/*/<sessionId>.jsonl` for each account
(UUID filenames; subagents excluded) modified within past 7 days, up to 150 most recent. Reads initial 64 KB
(project = `cwd` of first referencing line, initial activity, first prompt) and trailing 64 KB (title and latest activity;
if missing title line, scans trailing 512 KB), asynchronously cached while mtime and size remain unchanged. Title
resolution priority: `custom-title`/`custom-title.json` > `agent-name` > `ai-title` > `last-prompt`, defaulting to initial prompt.
Active sessions (account lead matching `sessionId` in office) carry `open: true` and `agentId`; terminated sessions
lacking timestamps are omitted. Results sorted newest to oldest.

`GET /api/sessions/:account/:sessionId/terminal` (`http/sessions.ts`) reuses agent terminal stream reader
(`TerminalStreams.attachSession`: `init` with trailing 500 entries from last ~4 MB, followed by `append`, polling every
2 s in case session resumes) and counts toward the 8 concurrent terminal limit. Validation: account must be registered (404),
id must match UUID format (400), and resolved real path (`realpath`) must reside within account's `projects/` directory (404);
malformed path segments return 400. Both routes enforce terminal security guards (feature enabled + local `Host`, else 403)
and permit `GET` only (history list also accepts `HEAD`; else 405).

## Responding via Office

Claude Code's `PermissionRequest` hook (`mod/habblaud-permissoes/hooks/permission-hook.mjs`, configured with `matcher: "*"`:
managed via `habblaud-permissoes` plugin in Claude Code 2.1.287+ or installed in `<account>/settings.json` via
`npm run hooks:install`) executes **concurrently** with terminal permission prompts: first to respond wins.
In background subagents, Claude Code invokes hook prior to rendering prompt, displaying UI only after hook finishes.
Hook transmits request (`session_id`, `agent_id`/`agent_type`, `cwd`, `tool_name`, truncated `tool_input`,
`permission_suggestions`, and `timeout_ms`) and waits; upon `decided` it outputs `hookSpecificOutput.decision` (`allow`,
with `updatedPermissions` matching chosen suggestion, or `deny` with `message`/`interrupt`); on `released`, error,
or timeout it exits cleanly without output (falling back to terminal prompt).

Interactive questions (`AskUserQuestion`) follow identical architecture. Payload carries `questions` (masked and truncated,
preserving original indices in `index`; mirrored in snapshot) and UI responds with `{behavior: 'answer', answers: [{question, options?, other?}]}`
by index. Registry validates against stored schema (each question answered once; single-select unless `multiSelect`,
`other` text up to 2,000 chars) and delivers `{status: 'decided', behavior: 'answer', answers}`; hook maps back to original
stdin indices and outputs `allow` with `updatedInput` containing original input plus `answers` (`{question: "Option A, Option B, free text"}`).
Bare `allow` on question requests is rejected (400); `deny` is accepted. Questions exceeding rendering constraints
(>4 questions or none valid) bypass redirection (`unsupported-tool`).

`permissions/registry.ts` (`PermissionRegistry`):

- only accepts requests when at least one UI client is connected via local `Host` (`Hub.localSize`) and session is known
  (lead via `session_id`; subagent via `<session_id>:<agent_id>`, or lead with `subagent` = type);
  otherwise `{skip: 'no-viewers' | 'unknown-session' | 'unsupported-tool' | 'too-many'}` (max 32 open requests);
- publishes earliest request per agent in `AgentInfo.permission` (omitting `input`, which is queried via detail route;
  `queued` = pending queue count) and sets agent status to `waiting`; emits `PermissionRequest` activity and "needs permission"
  notification (deduplicating "needs you"); approve/deny choices publish activities;
- releases hook (`released`) upon: UI `terminal` action, hook timeout + 5 s (`expired`), orphaned hook disconnected for 8 s (`orphan`),
  departed agent (`gone`), or terminal answer (`answered`): since Claude Code does not abort hook upon terminal answer, registry
  locates call at transcript tail (`permissions/transcript.ts`: name + argument signature, newest without result) and awaits its
  `tool_result`; fallback tracks leads previously `waiting` in session registry departing 3 s earlier;
- unretrieved decisions persist for 30 s; demo requests (`demo:perm-…`) route to simulator.

Routes (`permissions/http.ts`) enforce terminal security locks: missing `ServerConfig.terminal` → 403 across all routes;
non-local `Host` → 403. Guard enforces JSON content type and local `Origin` on `POST`. Errors: 400 (invalid body, suggestion,
or answer), 404 (unknown, delivered, or expired request), 405, 409 (already answered).

## Messages via Office

The frontend dispatches text to a lead agent (`POST /api/messages`, via agent drawer or terminal footer) and session's
`habblaud-mensagens` plugin polls for it (`POST /api/mod/inbox`, every 2 s), delivering via `$.prompt.submit({ text, asUser: true })`:
model interprets input as direct user input. Plugin acknowledges completion via `POST /api/mod/inbox/ack`. Plugin details
in [`mod/README.md`](../mod/README.md).

`messages/registry.ts` (`MessageRegistry`):

- **heartbeat:** each plugin poll refreshes session heartbeat (matching lead `sessionId` and optional `account`); active within
  past 10 s marks agent in snapshot with `canMessage: true`. Snapshot updates only on presence changes;
- **queue:** up to 5 pending messages per agent (429) and 20,000 characters per message; text sent verbatim, excluded
  from API responses and logs, and discarded once resolved;
- **states:** `queued` → `sent` (retrieved by plugin) → `delivered` or `failed`. `queued` unretrieved for 60 s, `sent`
  unacknowledged for 30 s, or departed agent = `failed` with error reason. `delivered` = ingested into session prompt
  or queue (if agent busy, enters after turn concludes). Resolved messages retained 10 min for `GET` queries;
- delivery publishes ✉️ "Message via Habblaud" activity (details masked and truncated); demo agents receive simulated
  messages delivered in ~1 s without live processes.

Routes (`messages/http.ts`) require terminal security locks plus configuration toggle: `ServerConfig.messages` = terminal active
and `HABBLAUD_MENSAGENS` not disabled (`0`, `false`, `off`, `no`). Disabled feature or non-local `Host` → 403.
`POST /api/messages` errors: 400 (invalid body, empty or excessive text), 404 (unknown agent), 409 (agent cannot receive:
subagent, departed, or missing plugin connection), and 429. Status reflected in snapshot `meta.messages` and `/api/health`.

Any local machine process can invoke these endpoints (like permission routes): enabling messages implies trusting local
software to submit text into sessions hosting the plugin.

## Project Character

`PUT /api/agents/:id/character` (`http/app.ts`, rules in `Office.setCharacter`) configures name and visual appearance for lead
agent `:id`, persisting as the project character for that room (normalized cwd) in `names.json` › `rooms`:
`{name, look, seed, parts?, owner?, at}`.

Request body accepts three fields:

- `name`: 1 to 24 characters in NFC normalization, collapsed spaces, no control characters;
- `seed`: unsigned 32-bit integer (0 to 4294967295);
- `parts`: parts from `shared/appearance.ts`, with enum styles and `#rrggbb` colors. Client overlays custom parts
  over base `appearanceFromSeed(seed, {look})`.

Rules:

- When a lead enters a room with a configured character, and the name is unclaimed, it spawns with `name`, `look`, `seed`,
  `parts`, and `custom: true`. Departing agents do not block claims (re-opened sessions). If name is taken, falls back to standard pool.
- Character carries ownership (`owner`, `sessionId` of last entity claiming/updating it; `/clear` transfers ownership to
  new session): sessions not owning the character that already have names retain their identities, preventing mid-session swaps.
- Configured names are reserved case-insensitively from random pool sampling. `PUT` returns `409` if name is already held by a
  present agent (including demo agents) or assigned to another room.
- `/clear` preserves character configuration without saving custom name as random pool name for new session.
- `DELETE` clears character from room, returning agent to random session name and ID-derived seed.
- Security locks: requires local bind and local `Host` header. Otherwise `403`. Subagents, demo agents, or unknown IDs return `404`.
- Unused characters expire after 60 days, matching name retention.

## Codex

Agent sources (`sources/source.ts`): `SourceSet` integrates Claude Code (`ClaudeWatcher`) and, when Codex folders are present,
Codex (`sources/codex/`); session history mirrors this (`HistorySet`). Codex agents, accounts, sources, and history sessions
carry `provider: 'codex'` (omitted = Claude Code). IDs: `<account>:<threadId>`, `sessionId` = threadId.

- **Accounts** (`sources/codex/accounts.ts`): `HABBLAUD_CODEX_DIRS` (override) or `CODEX_HOME` and `~/.codex*` matching Codex
  structure (`isCodexHome`: `thread-writer-locks/`, `archived_sessions/`, `config.toml`, `auth.json`, or `sessions/YYYY/`,
  lacking `projects/` which Claude Code creates exclusively). Codex directories never become Claude Code accounts.
  `auth.json` and `config.toml` are never read; plan level extracted from `rate_limits.plan_type`.
- **Open Sessions** (`sources/codex/files.ts`, `source.ts`): `thread-writer-locks/<threadId>.lock` older than 3 s
  (filtering brief maintenance locks; lock files never opened). Lock without rollout = open empty session: lock omits cwd,
  so lead agent enters only once rollout (created on first prompt) or hook reports cwd. Lock and rollout idle for 12 h without
  hook events = crashed session. Missing lock folder: rollout modified within 30 min. Hook events retain presence for 60 s.
- **Rollout** (`sources/codex/rollout.ts`): `sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl` (directory denotes creation date;
  resumed sessions append to original file) and `archived_sessions/`, read using `FileTail`. Formats: "paginated" (default)
  and "legacy"; `.zst` skipped with warning. Status derived from `task_started`/`task_complete`/`turn_aborted`; activities from
  `item_completed` (`CommandExecution` like Bash, `FileChange`, `McpToolCall`, messages, thoughts); token accounting without
  duplicate cache additions (in Codex cache is included in input tokens); no costs; plan usage from `token_count.rate_limits`
  (300 min = 5 h window, 10080 = weekly; null `primary` with `rate_limit_reached_type` = `noQuota`), pushed via `accounts.setUsage`.
  Subagents = threads with `source.subagent.thread_spawn.parent_thread_id`; internal threads (guardian, review, compact, memory) excluded.
- **Terminal and History** (`sources/codex/terminal.ts`, `history.ts`): terminal parser selected dynamically per agent (`SourceSet.parserFor`).
- **Hook Events** (`POST /api/codex/events`, `codex/http.ts`; hook script `mod/habblaud-codex/hook.mjs`): local `Host`
  and loopback connections only. Routed to `CodexLive.applyHookEvent`: matched by account (`codexHome`) and `agent_id ?? session_id`
  (in Codex, `session_id` is the root thread). SessionStart creates agent, UserPromptSubmit/PreToolUse = working (current activity),
  PermissionRequest = waiting ("approve command"), Stop = idle, SessionEnd concludes.
- **Approval via Office** (`permissions/*`, `permissions/codex.ts`): same `POST /api/permissions` with `provider: 'codex'`,
  `account`, and `codexHome`; no suggestions, no questions, no transcript searching; `interrupt` or `suggestion` on Codex request = 400.
  Hook waits up to `permissionTimeoutS` from `~/.habblaud/codex-hook.json` (default 25 s) and outputs `allow` or `deny` (+`message`).
  Codex displays terminal approval prompt only after hook exits.
- **Messages** (`messages/*`, `messages/codex.ts`): for Codex agents, `codex queue --thread=<id> --message=<text>` with
  `CODEX_HOME` = account directory (on host). Outside Docker, server executes binary directly (`HABBLAUD_CODEX_BIN` or `codex` on PATH);
  in Docker, host bridge (`npm run codex:bridge`) polls `POST /api/codex/bridge/poll` and acknowledges via `/ack` (same security lock).
  `canMessage` = available dispatcher (binary found or bridge active in past 10 s). Exit code 0 = queued in session (`delivered`);
  Codex consumes queue every ~10 s when session becomes idle.

## Habblaud World

Enabled by default, pointing to `server.habblaud.com` (`DEFAULT_WORLD_URL` in `config.ts`); nothing leaves machine
before user registers and signs in, and `HABBLAUD_WORLD=0` disables entirely (data safety: `docs/world/privacidade.md`;
modifications: `shared/world/README.md`). Wire protocol defined in `shared/world/protocol.ts` (source of truth, with `schema.json`).
Server implementation in `world/`:

- `settings.ts`: `<dataDir>/world.json` `{deviceId, token, email, access, player?, paused?, left?, updatedAt, theme?}`, atomic write,
  mode 600. Device token is only transmitted in `Authorization: Bearer` header to world server and in WebSocket `hello`:
  never in browser, snapshot, log, or URL. `theme` (Appearance choice, `auto` default) persists across unauthenticated states
  (file stores `{theme}`); `paused` and `left` (departed world, always with `paused`) belong to session.
- `client.ts`: `/v1/*` endpoints via native `fetch` (15 s timeout, redirect following disabled, responses up to 256 KB copied field-by-field;
  data exports up to 8 MB passed through). World server errors map to `{status, code}` (maintenance: `503 maintenance`); network,
  timeout, and malformed responses map to `world_unreachable`, `world_timeout`, and `world_bad_response`.
- `altcha.ts`: anti-bot proof-of-work challenge for registration and email requests, solved via brute force SHA-256 in batches of 5,000
  hashes yielding to event loop.
- `service.ts`: account state machine (single concurrent operation). `/v1/me` re-queried max once every 30 s (or via `?refresh=1`),
  and automatically every 30 min while on waitlist (`waitingPollMs`; unref'd timer) so approval syncs without user intervention;
  401 response on authenticated route clears local session (`lastError: session_expired`); re-authenticating revokes previous device;
  logout purges `world.json` even if server unreachable. `lastError` strictly returns known codes (`worldLastError` in `shared/world/api.ts`):
  network/timeout map to `network`, unhandled error codes map to `unknown`. Pause, resume, and departure requests serialize into a queue;
  unanswered resume attempts retry with exponential backoff matching uplink reconnections (2 s to 60 s) until success or re-pause.
  Account deletion (Phase 6): code requested via `POST /v1/me/delete`; confirmed via `POST /v1/me/delete/confirm` (or `goodbye: deleted`),
  closes uplink, purges entire `world.json` (including theme, `store.erase`), and clears last uplink, returning unauthenticated status with
  `lastError: account_deleted`. Data export (`GET /v1/me/export`) relays payload.
- `uplink.ts`: building WebSocket connection (global Node `WebSocket`) at `<HABBLAUD_WORLD_URL>/v1/socket` (`wss://`; `ws://127.0.0.1`
  and `ws://host.docker.internal` in dev mode only). Connects only when account is approved, character created, and terminal lock active;
  while paused or departed, connects strictly when World scene is open (viewer signals via `cityChanged`), emitting zero uplinks
  (including `welcome` uplink): exchanges `hello`, `ping`/`pong`, and scene commands only. Sends `hello` (`{v, version, build: {commit, dirty}, locale, token}`)
  and, upon each `welcome`, transmits full packet; subsequently, upon office changes (`Office.onChange`) or every minute, calculates
  projection (`shared/world/projection.ts`) and transmits if modified: 3 s debounce after first change, max one transmission per 5 s.
  Keepalive `{t: 'ping'}` every 30 s (disconnects after 75 s without pong). Reconnection backoff: 2 s to 60 s (doubles, ±25%). `goodbye`:
  `deploy` reconnects (under maintenance, `deploy` per `hello`: backoff ramps to ceiling, resetting only upon `welcome`); `banned`, `suspended`,
  `update`, and `other-device` suspend reconnections until resume/reopen; `waiting`, `no_player`, and `unauthorized` suspend until session
  changes, notifying account service (`service.goodbye`); `deleted` terminates and triggers local account purge. Caches in-memory account ID
  from `welcome` (`me.id`, used in appeal email subject) and unverified building badge (`building.unverified`, synced from scene `area`/`area.patch`).
  `uplink.ack {error: 'left'}` (account departed world here or elsewhere) and `left: true` on `/v1/me` persist `left` and `paused`
  (`service.leftElsewhere`): halts uplinks until rejoining. Last transmission `{at, bytes, uplink, ack}` cached in memory and in
  `<dataDir>/world-last-uplink.json` (mode 600; cleared upon logout). Flags snapshot (`markDirty`) on connect, disconnect, pause, resume,
  and ack. Task and compaction signals (`signals.ts`) monitored via `Office.onChange`, max once per second; during office boot (`Office.isBooting`),
  monitoring and uplink transmissions are suspended.
- `ids.ts`: ephemeral in-memory world IDs (`f_` + 10 hex per room, `a_` + 8 hex per agent, `crypto.randomBytes`), each with lifetime of
  24 h ± 6 h; restarting Habblaud generates fresh IDs.
- `tokens.ts`: building token usage (in + out) today and rolling 7 days, from "My Day" real metrics (demo excluded), rounded to 2 significant digits;
  past days cached, today re-calculated every 15 s.
- `theme.ts`: resolves selected theme for payload ("auto" follows office calendar, using server local date: UTC in Docker).
  `signals.ts`: tracks completed daily tasks per agent and new compactions (`/clear` excluded).
- `http.ts`: `/api/world/*` endpoints (spec in `shared/world/api.ts`). `http/app.ts` serves strictly on local port with local `Host`
  (mobile remote port returns 403 `local_only`, even with authentication); all endpoints except `status` require terminal lock (403 `terminal_off`);
  invalid `HABBLAUD_WORLD_URL` returns 409 `not_configured`; `HABBLAUD_WORLD=0` returns 404. Errors: `{error: {code, message?, retryAfter?}}`.
  Building: `PUT /api/world/theme` `{theme}` (with or without account), `POST /api/world/pause` (halts transmission, closes uplink if scene closed,
  notifies `POST /v1/me/building/pause`), `POST /api/world/resume` (notifies `/resume` and reconnects or sends full payload via scene socket),
  `POST /api/world/leave` ("Leave World": sets `left` and `paused`, halts uplinks, responds after `DELETE /v1/me/building`; on error retains
  paused state), `POST /api/world/join` ("Rejoin World": `POST /v1/me/building/join`, clears `left` and `paused` upon success, reopening uplink;
  outside world `/resume` calls route here), `GET /api/world/last-uplink` (`{at, bytes, uplink, ack?}` or `{}`, no terminal lock required, like status).
  `GET /api/world/status` includes `building` and `theme`; responds from cache, refreshing `/v1/me` in background when expired.
  Account (Phase 6): `POST /api/world/delete-account` (`202 {}`: code sent to email), `POST /api/world/delete-account/confirm` `{code}` (responds with
  unauthenticated status after socket close and file purge), `GET /api/world/export` (JSON attachment `habblaud-world-dados.json`; consumed via UI,
  counts against daily quota; `HEAD` skips calling world server), and optional `notifyInactivity` on `PUT /api/world/visibility`.

Snapshot includes `meta.world` (`{enabled, configured, state, building?, scene?}`; `building` = `{connected, paused, floors, agents, lastUplinkAt?, left?, stopped?}`,
`connected` = actively transmitting; `scene` = `{available}` with approved account and character, terminal lock, and no administrative bans).
Build writes `dist/build.json` (`{commit, dirty, builtAt}`, `scripts/build-info.mjs`; `unknown` without git; `HABBLAUD_BUILD_COMMIT`/`HABBLAUD_BUILD_DIRTY`
override git), read by `readBuildInfo()` (`build.ts`) upon uplink connections: `hello` transmits `{commit, dirty}`.

### World Scene: Streaming and Commands

The city (Phase 3) streams over the building WebSocket connection and requires an open World scene in browser. `world/viewer.ts` coordinates
viewer state; logic and state in `shared/world/scene.ts` (pure, mirrored in browser), and geometry in `shared/world/city.ts` (source of truth;
world server maintains identical copy).

- `GET /api/world/stream` (SSE, enforces same security locks as account routes, and same-origin only: cross-site origins or `Sec-Fetch-Site`
  receive 403 `local_only`). Maximum 4 concurrent streams (429 `too_many_streams`). Events: `world.snapshot` (`WorldSceneSnapshot` from `shared/world/api.ts`:
  `{stream, connected, viewing, district?, me?, pos?, afk, chunks: [{chunk, rev, buildings}], players, minimap}`) upon connecting and resyncing;
  followed by `world` with raw city messages (`area`, `area.patch`, `players`, `player.join`, `player.leave`, `pos`, `minimap`, `afk`, `profile`,
  `notice`, `like.update`, `greeting`, `building`, `building.patch`) in order, without `rev` gaps; `: ping` every 15 s. Buffer overflow >1 MB disconnects client.
- First stream to open dispatches `view`; final closing stream dispatches `view.off`. Each `welcome` with open streams re-sends `view`;
  disconnects clear city state, emitting `connected: false` snapshot. Paused or departed accounts open socket solely when scene is active:
  opening first stream connects (`hello`, `view`), closing final stream dispatches `view.off` and closes socket; zero uplinks transmitted.
- State rules: `area` replaces chunk and `rev`; `area.patch` requires `rev` = last + 1 (`lot` replaces building, without `lot` merges fields, `removed` deletes);
  gaps or unknown chunks request `resync {chunk}` (max 1 per 5 s per chunk), dropping patch; retains strictly 3×3 chunks around player position
  (authoritative `pos`, local ID in `players`, or last `move`); `players` updates existing players by ID; `player.join` updates profile; `afk`
  holds until move, turn, `view`, or `profile`. Ephemeral in-memory state only, omitted from logs.
- `POST /api/world/cmd` `{stream, cmds}` → `202 {sent}`: 1 to 20 commands (`move`, `profile`, `resync`, `view`, `view.off`, `enter`, `leave`,
  `like`, `unlike`, `greet`, `block`, `unblock`, `report`), reconstructed field-by-field (`parseSceneCommand`; `hello`, `uplink`, `ping` rejected: 400 `invalid`);
  latest `move` per batch sent. Rate limit: 5 batches/s per stream (burst 5, refill 5/s; 429 `rate_limited` with `Retry-After: 1`).
  Unopened stream: 409 `no_stream`; disconnected: 409 `not_connected`. `view` and `view.off` toggle city streaming subscriptions.
- Client implementation in `client/src/net/world-stream.ts`: `createWorldStream({mock})` with `on`, `send` (queued, 200 ms batching), and `close`;
  demo mode provides `FakeWorldStream` (20 buildings with local player on lot (3,1), 5 walking NPCs, fountain sitter, minimap, `afk` after 60 s;
  `?perf=N` simulates N lots).

## Environment Variables

| Variable | Default | Usage |
| --- | --- | --- |
| `HABBLAUD_PORT` | `4747` | HTTP port |
| `HABBLAUD_HOST` | `127.0.0.1` | Network interface (Docker uses `0.0.0.0`); non-loopback disables terminal, permissions, and messages |
| `HABBLAUD_BIND` | — (Compose: `127.0.0.1`) | Docker only: host-published interface forwarded to container; loopback enables terminal |
| `HABBLAUD_TERMINAL` | — | `0` disables terminal, permissions, and messages (cannot be forced on exposed ports) |
| `HABBLAUD_CODEX` | enabled | `0` disables Codex data source |
| `HABBLAUD_CODEX_DIRS` | — | Comma-separated Codex directories; overrides autodetection (`CODEX_HOME` and `~/.codex*`) |
| `HABBLAUD_CODEX_BIN` | `codex` on PATH | Codex binary for `codex queue` (Node mode and `npm run codex:bridge`) |
| `HABBLAUD_MENSAGENS` | enabled (with terminal) | `0`, `false`, `off`, or `no` disables office messages exclusively |
| `HABBLAUD_CLAUDE_DIRS` | — | Comma-separated config dirs; overrides autodetection (`~/.claude*` with `projects/` or `sessions/` + `CLAUDE_CONFIG_DIR`) |
| `HABBLAUD_DATA_DIR` | `~/.habblaud` (Docker: `/data`) | Habblaud persistent state (`names.json`, `timeline/`, `stats/`, `updates.json`) |
| `HABBLAUD_TIMELINE` | enabled | `0` disables timelapse timeline recording |
| `HABBLAUD_UPDATE_CHECK` | enabled | `0` disables update checks against GitHub releases |
| `HABBLAUD_LANG` | System locale (`LC_ALL`/`LANG`/Intl) | Server-generated text locale: `pt-BR` or `fr` (shared/i18n.ts) |
| `HABBLAUD_DEMO` | disabled | `1` enables demo mode upon startup |
| `HABBLAUD_IN_DOCKER` | auto (`/.dockerenv`) | `1` = bypasses PID checks (belonging to host) |
| `HABBLAUD_ACCOUNTS` | — | JSON account metadata forwarded from host (Docker): `[{id, configDir, mountDir, short, name, email, organization, plan, color, cachedUsage}]` |
| `HABBLAUD_USAGE_DIR` | `~/.habblaud/usage` (Docker: `/usage`) | Usage metrics directory populated by statusline tap or Claude Code mod, re-read every 5 s |
| `HABBLAUD_ALLOWED_HOSTS` | — | Comma-separated additional allowed `Host`/`Origin` headers; `localhost`, `*.localhost`, and IPs always accepted |
| `HABBLAUD_WORLD_URL` | `https://server.habblaud.com` | Habblaud World server URL: `https://` or `wss://` only, no path; `http://127.0.0.1:*` in dev mode only. Building uplinks via WebSocket on same origin (`/v1/socket`) |
| `HABBLAUD_WORLD` | enabled | `0` (`false`, `off`, `no`) disables Habblaud World: 404 routes, UI hidden, zero network activity |
| `HABBLAUD_WORLD_DEV` | disabled (`--dev` enables) | `1` permits `http://127.0.0.1` or `ws://127.0.0.1` world server targets |

Permission hook environment (Claude Code execution context; installer CLI flags `--port`/`--timeout` take precedence):
`HABBLAUD_PORT` (default `4747`), `HABBLAUD_PERMISSION_TIMEOUT` (seconds waiting for UI response, default `300`, range 5-1800),
and `HABBLAUD_HOOK_DEBUG=1` (verbose stderr logging).

## Plan Usage (5h and Weekly)

Two sources, both local files (zero credentials or network requests); most recent timestamp (`fetchedAt`) takes precedence:

- `statusline` (**recommended**, `accounts/statusline.ts`): Claude Code passes JSON containing `rate_limits`
  (`five_hour`/`seven_day`: `used_percentage` and epoch `resets_at` seconds) to statusline command. `scripts/statusline-tap.mjs`,
  installed in front of each account's statusline via `npm run usage:install`, writes metrics to `~/.habblaud/usage/<account>.json`
  (associated via `configDir`, fallback to `accountId`). Under Claude Code 2.1.287+, Habblaud mod records identical file (see below);
- `cache`: `cachedUsageUtilization` recorded by Claude Code during `/usage`, polled every 60 s.

Without either source, account status shows `disabled` ("no usage data"). Metrics older than 30 min appear as `stale`.
Windows whose reset time has elapsed are omitted (rendered as "—" in UI) until fresh metrics arrive — never fabricated as 0%.

## Claude Code Mod

The repository acts as a Claude Code plugin marketplace (`.claude-plugin/marketplace.json`, spec in [`mod/README.md`](../mod/README.md)).
Server-side, the `habblaud` mod provides two functions:

- **usage metrics file:** on each `session.start` and `session.measure`, writes `<HABBLAUD_USAGE_DIR>/<account>.json` in tap format
  (`{accountId, configDir, fetchedAt, five_hour, seven_day}`, `resets_at` in seconds, extracted from `$.session.usage().rateLimits`)
  with `source: "mod"` (reader ignores source flag, treating as standard `statusline` data). Because mod writes using non-atomic
  `$.fs.write`, `StatuslineUsageReader` discards partial or empty reads, retaining last valid record and retrying next cycle;
- **`GET /api/mod/summary`** (`modSummary` in `http/app.ts`), polled every 5 s by active statusline sessions (30 s if Habblaud offline)
  and by `/habblaud` command: aggregated counts and waiting entities from current snapshot. Excludes demo agents (residing strictly in
  snapshot, outside `Office`), terminated or delivered sessions, and caller session filtered via `?session=` (and optional `?account=`):
  filters lead agent matching `sessionId` and its subagents. `answerable` = pending permission request answerable via office
  (`AgentInfo.permission`). Omitted parameters return unfiltered counts for `/habblaud` CLI parity. `GET`/`HEAD` only (else 405).

## Directory Structure

- `config.ts`, `log.ts`, `index.ts` — Configuration, concise logging (never conversation content), and application entry point.
- `accounts/` — Account detection (`detect.ts`, also used by `docker-up`), usage tracking (`usage.ts`), statusline tap (`statusline.ts`), and account service (`service.ts`).
- `sources/` — Session discovery, incremental tail reading (`tail.ts`), transcript parsing (activities in `transcript.ts`; terminal dialogue in `terminal.ts`; GitHub events in `github.ts`), subagents, session history (`history.ts`), and central watcher orchestrator (`watcher.ts`).
- `model/` — Office simulation (`office.ts`), rooms/slots (`rooms.ts`), persisted characters and names (`names.ts`).
- `http/` — Edge guards (`guard.ts`), route registration (`app.ts`), SSE streaming (`sse.ts`), terminal streaming (`terminal.ts`) and session archive (`sessions.ts`), timelapse (`timeline.ts`), My Day stats (`stats.ts`), static assets (`static.ts`).
- `history/` — Timelapse timeline writer (`timeline.ts`) and My Day metrics: sampling, persistence, retention (`daystats.ts`; pure accumulator in `shared/daystats.ts`).
- `permissions/` — Office interaction (permissions and questions): request registry (`registry.ts`), HTTP endpoints (`http.ts`), transcript call resolution (`transcript.ts`).
- `messages/` — Office messaging: queue management, session heartbeat, timeouts (`registry.ts`), and HTTP routes (`http.ts`).
- `updates/` — Version check against GitHub releases (`checker.ts`).
- `world/` — Habblaud World: credentials in `world.json` (`settings.ts`), HTTP client (`client.ts`), ALTCHA challenge solver (`altcha.ts`), account management (`service.ts`), local endpoints `/api/world/*` (`http.ts`), and building uplink (`uplink.ts`, with `ids.ts`, `tokens.ts`, `theme.ts`, `signals.ts`).

Tests: `npx vitest run server shared` (synthetic test fixtures in `server/test/fixtures.ts`; host scripts — statusline tap, permission hook (invoked as child process against mock HTTP server), installers, and `docker-up` — verified in `server/test/` using isolated mock HOME and config dirs).
