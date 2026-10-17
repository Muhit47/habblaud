# Habblaud Claude Code Plugins

This repository acts as a marketplace for Claude Code plugins. The `.claude-plugin/marketplace.json` (at the root) lists the `habblaud` marketplace with three plugins, each contained in its own folder: the `habblaud` mod (observational), `habblaud-permissoes` (handles permissions from the office), and `habblaud-mensagens` (sends messages from the office). Running `npm run mod:install` installs all three; using `--sem-permissoes` or `--sem-mensagens` allows you to exclude them. Versions are tracked in `package.json` (the `server/test/mod.test.ts` test will fail if they diverge).

Tested with **Claude Code 2.1.293** (`habblaud-mensagens` currently only via `claude plugin test` in 2.1.295). Mods (TypeScript hooks loaded by Claude Code) are available starting from 2.1.287; the API is still in "early access" and may change between versions. For earlier versions, use the standard installers (`npm run usage:install` and `npm run hooks:install`); sending messages from the office is only possible with the mod. Installation details are in the main README.

## `habblaud` — the mod

Located in `habblaud/hooks/register.ts`, this is a single module without a build step. It connects each session to the office without reading the conversation:

- **Usage tracking (5h and weekly):** At the beginning of a session and on every `session.measure` (after each turn and when a limit advances), it reads `$.session.usage().rateLimits` and saves it to `~/.habblaud/usage/<account>.json` (or the path defined in `HABBLAUD_USAGE_DIR`) in the same format as the statusline tap, with an added `"source": "mod"` field. This replaces `npm run usage:install`, leaving your statusline untouched. The account is the first folder in `CLAUDE_CONFIG_DIR` or `~/.claude` (where `~` is `HOME`; on Windows, `USERPROFILE` if `HOME` is missing). Identical values saved less than 10 seconds ago are not overwritten; write failures are ignored.
- **"Needs you" below the prompt:** Every 5 seconds, it queries the local Habblaud instance (`GET http://127.0.0.1:<HABBLAUD_PORT or 4747>/api/mod/summary`) to see who needs attention, excluding the current session and its subagents. It displays messages like `🏢 Valentina needs you in loja-virtual` or `🏢 2 need you: Valentina (loja-virtual), Elias (app-mobile)` (up to 3 names, followed by "and N others"). If no one needs help or Habblaud is offline, the line disappears; if offline, it polls every 30 seconds until reconnection. This only appears in interactive sessions (no polling in `claude -p`).
- **`/habblaud`:** A summary of the entire office, answered by the mod itself (no model call, no usage cost):

  ```
  Habblaud 0.3.0 at http://localhost:4747
  7 agents · 3 working · 2 need you
  ✋ Valentina (loja-virtual): approve a permission · can respond from the office
  ✋ Elias (app-mobile): respond in the terminal
  ```

  If offline: `Habblaud is not responding at http://localhost:4747. To start: npm run docker:up in the Habblaud folder.`

### Access and permissions

Output from `claude plugin validate --strict mod/habblaud` (the static analysis Claude Code performs before loading the module):

```
❯ ./register.ts hooks: session.start, session.measure, command.run{command=habblaud}
❯ ./register.ts answers its own command: command.run{command=habblaud}
❯ ./register.ts calls: $.clock.after (via askHabblaud), $.clock.every (via schedule), $.clock.now (via writeUsage), $.command.register, $.env.get (via readEnv), $.fs.write (via writeUsage), $.http.fetch (via askHabblaud), $.session.id (via poll), $.session.surfaces (via poll), $.session.usage, $.ui.status (via setStatus)
❯ ./register.ts env writes: nothing
❯ ./register.ts env reads: CLAUDE_CONFIG_DIR, HABBLAUD_PORT, HABBLAUD_USAGE_DIR, HOME, USERPROFILE
```

In short: it is observational only (no hook decides anything: it does not approve tools, change prompts, or read messages), writes only one file (usage), communicates only with `127.0.0.1`, and reads five environment variables. `$.clock.after` handles the 2-second timeout for Habblaud queries (`$.http.fetch` does not accept AbortSignal).

## `habblaud-permissoes` — respond to permissions from the office

A standard `PermissionRequest` hook (non-mod), located in `habblaud-permissoes/hooks/hooks.json`:

```json
{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/permission-hook.mjs\"", "timeout": 86430, "statusMessage": "Waiting for response in Habblaud" }] }
```

The `hooks/permission-hook.mjs` script is the same as the one installed by `npm run hooks:install` (single source; pure Node, only `node:*`, as Claude Code copies only the plugin folder to the cache). It sends the request to the local Habblaud instance and waits for up to 5 minutes; the dialog remains in the terminal, and your first response is final. If Habblaud is offline or no pages are open, it terminates immediately. Port: `HABBLAUD_PORT` (default 4747); timeout: `HABBLAUD_PERMISSION_TIMEOUT` (default 300s, up to 86400s = 24h; the plugin hook timeout is 86430s). To approve from your phone away from your computer, add `"env": { "HABBLAUD_PERMISSION_TIMEOUT": "86400" }` to the account's `settings.json`; it applies to sessions opened subsequently. Background subagents only display the dialog once the hook finishes, hence the 5-minute default. Requires `node` 22+ in the session `PATH`.

`claude plugin validate --strict mod/habblaud-permissoes`: `✔ Validation passed` (the validator also checks the `hooks.json` schema).

## `habblaud-mensagens` — send messages from the office

`habblaud-mensagens/hooks/register.ts`, a single module without a build step. It bridges what you type in the office (in the agent panel or the T-key terminal) to the session, as if you had typed it directly in the terminal:

- **Polling:** Every 2 seconds, in interactive sessions only (no polling in `claude -p`), it sends `POST http://127.0.0.1:<HABBLAUD_PORT or 4747>/api/mod/inbox` with `{session, account}`. The request also marks the session as present: this enables the agent's message box on the page (without the plugin, the page prompts you to install it). If offline, or responding to something else (403 if messages are disabled, 404 in a version without the route), it polls every 30 seconds until connection is restored.
- **Delivery:** Each message, in order, is submitted via `$.prompt.submit({ text, asUser: true })`. The model reads the text as yours, without "The habblaud-mensagens plugin sent a message" (the session log still indicates it originated from the plugin), and the text is passed exactly as typed. If the session is mid-turn, Claude Code queues the prompt and executes it in its own turn once the current one completes (a plugin prompt never interrupts mid-turn, unlike manual input). A hook that rejects the message (`{drop}`) or an exception becomes a failure message on the page.
- **Confirmation:** A `POST /api/mod/inbox/ack` with the result of each message (`{session, results: [{id, ok, error?}]}`). Message waiting is limited to 2 seconds: if it takes longer, the session is occupied, the message remains in its queue and is counted as delivered (subsequent messages follow in order). Thus, a round trip never exceeds a few seconds, preventing session occupation from triggering presence (10s) or server confirmation (30s) timeouts; the tradeoff is that a rejection after those 2 seconds does not reach the web page.

Kept separate from the `habblaud` mod by design: the mod is observational; this plugin acts, typing into the session on your behalf. To remove: `npm run mod:install -- --sem-mensagens` (an already installed instance remains; to uninstall: `claude plugin uninstall habblaud-mensagens@habblaud`). `npm run docker:up` updates the plugin for those who already have it, but does not install it automatically: for an account with the mod but without the plugin, it simply prompts you to run `npm run mod:install`.

### Access and permissions

Output from `claude plugin validate --strict mod/habblaud-mensagens`:

```
❯ ./register.ts hooks: session.start
❯ ./register.ts calls: $.clock.after (via waitAtMost), $.clock.every (via schedule), $.env.get (via readEnv), $.http.fetch (via postJson), $.prompt.submit (via submitOne), $.session.id (via round), $.session.surfaces (via round)
❯ ./register.ts env writes: nothing
❯ ./register.ts env reads: CLAUDE_CODE_ENTRYPOINT, CLAUDE_CONFIG_DIR, HABBLAUD_PORT, HOME, USERPROFILE
```

In short: one hook (`session.start`, which starts the polling cycle); the only action in the session is `$.prompt.submit` for messages; it does not read the conversation, writes no files, communicates only with `127.0.0.1`, and reads four environment variables (the account is derived from `CLAUDE_CONFIG_DIR`, as in the mod). `$.clock.after` handles the 2-second timeout for Habblaud requests and `$.prompt.submit`.

Port: `HABBLAUD_PORT` (default 4747). Requires Claude Code 2.1.287+ and a Habblaud instance with messaging enabled: subject to the same terminal/permissions constraints (port bound to `127.0.0.1` and local Host header) and `HABBLAUD_MENSAGENS` not disabled (`0`, `false`, `off`, or `no` disable it). Any process on this machine communicating with Habblaud can send messages to sessions with the plugin installed; this is why the local constraint exists.

## Development

```bash
claude --plugin-dir mod/habblaud                     # load mod in a session without installing (reloads on save)
claude -p "/habblaud" --plugin-dir mod/habblaud      # test command without interactive session (no model call)
cd mod/habblaud && claude plugin test                # mod tests (tests/*.test.ts), no session, login, or network
cd mod/habblaud-mensagens && claude plugin test      # same for message plugin
claude plugin validate --strict mod/habblaud         # static analysis + manifest (same for other folders and .)
npx tsc -p mod/habblaud                              # types (after loading mod once with --plugin-dir)
```

Upon loading a mod, Claude Code writes the installed version's types to `<folder>/.claude-plugin/types/` and a `<folder>/tsconfig.json` that extends them; both are generated and ignored by git (`mod/.gitignore`). Mod tests import `claude-code/testing` and run only via `claude plugin test`: `npm test` (vitest) and `npm run typecheck` ignore this folder.
