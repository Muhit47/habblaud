# Changelog

What changed in each Habblaud version. Each version has its own section here, and its text becomes the [GitHub release](https://github.com/Muhit47/habblaud/releases) notes (`npm run release`), which Habblaud opens in **Settings › About › See what changed**.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the numbers follow [Semantic Versioning](https://semver.org/): patch releases increment the last number (0.2.**1**), new features increment the middle one (0.**3**.0).

## [Unreleased]

## [1.0.3] - 2026-10-16

### Fixed

- **City: "Reply" and "Show in office" in warnings now return to the office and open the agent's request.** With the city open, clicking on a request or question warning (and browser notifications, request chips in the bar, and Deliveries) did nothing visible: the agent was selected behind the city. Now the city closes, the drawer opens to the agent, and the request card receives focus.

## [1.0.2] - 2026-10-16

### Fixed

- **City: Entering and liking started working again after leaving the tab in the background.** After half a minute with Habblaud in another tab or window, the character stopped sending the position to Habblaud World: it would walk on the screen, but "Enter" and liking would say to get closer to the door.

## [1.0.1] - 2026-10-16

### Fixed

- **City: Keys started walking again.** In 1.0.0, with the release popups and the Habblaud World window on the page, WASD, arrows, and office shortcuts stopped responding even with everything closed: a closed `<dialog>` remains on the page and was taken over by an open modal. Only open dialogs now count.

## [1.0.0] - 2026-10-16

Why 1.0: the office (rooms, characters, subagents, account usage, terminal, timelapse, mobile with login) has been stable for several versions, and Habblaud World arrives complete: account, character, building, city, visits, and light social. To update: `git pull` and `npm run docker:up`.

### Habblaud World

The online Habblaud city is live: every Habblaud becomes a building, lit live while agents work, and every person walks around the city with a character. **It comes enabled by default**, pointing to `server.habblaud.com`; **nothing leaves the computer until you create an account** and log in, and `HABBLAUD_WORLD=0` turns everything off (it even hides the routes). Access is granted via a waiting list. What can leave and what never leaves is in [`docs/world/privacidade.md`](docs/world/privacidade.md); the README has the complete **Habblaud World** section, in four languages.

- **Configure and test:** without `HABBLAUD_WORLD_URL`, the official server (`https://server.habblaud.com`; `npm run docker:up` and the server log say "(default)"); if defined, the defined one holds (only `https://` or `wss://`; if refused, World stays disabled, with the reason in the log). `HABBLAUD_WORLD=0` disables everything, and `HABBLAUD_WORLD_DEV=1` accepts a local world server without TLS at `http://127.0.0.1:<port>` (`npm run dev` already accepts it) or, from inside Docker, at `http://host.docker.internal:<port>`. `docker-compose.yml` passes the three variables and connects `host.docker.internal` to the host (`extra_hosts` with `host-gateway`, harmless on macOS), and `npm run docker:up` finishes by saying if World is enabled and to which server. The build records `dist/build.json` with the commit and if the copy was modified (goes in the first building connection message).
- **Own window:** Habblaud World has its own button on the top bar (the city icon, next to Settings; only appears with world server configured) and opens in its own modal, outside Settings: the pixel art building, account status in the header, and everything that follows in a scrollable body. The "in world" chip next to the version, the release popups, and the "While you were away" warning open the same window, on the correct screen.
- **Account:** in the Habblaud World window. **Create account** (email and password of 12 characters or more, the summary of what leaves and what never leaves the computer, the true data line, and the mandatory acceptance of Terms of Use and Privacy Policy; the anti-robot challenge is solved by Habblaud itself) or **I already have an account**; 6-digit code with resend; **Forgot password**; **Devices** (up to 3, with revoke) and logout. On the waiting list, only the warning, without position or forecast, and Habblaud open checks by itself every 30 minutes if access has been granted. Everything only via the computer itself: never via mobile port, and what acts on behalf of the account only with local access (terminal lock). The device token stays in `~/.habblaud/world.json` (permission 600; in Docker, in `/data` volume) and never goes to the browser, snapshot, logs, or URL.
- **Player name chosen at registration (reserved on the waiting list):** registration asks for the player name (3 to 20 characters, unique in the world) along with email and password, checked on the spot and, if already in use, with a warning in the field itself. It is reserved for the account while waiting on the list (waiting screen shows "Your player name: X (reserved)") and becomes the character's name, which is born with it without asking for the name again (can change later, once every 30 days); old accounts, without reservation, continue choosing the name when creating the character. `docs/world/privacidade.md` now states that the world server stores, besides the country, the IP of registration and the last login with password, for auditing (only administration sees; deleted with the account; included in "Download my data"), and no other.
- **Release popups:** three modal window warnings, above the office (and Settings). **New: Habblaud World**, for those who don't have an account yet, with the **Create account** button: "Not now" brings it back in 3 days (max 3 times), "Don't show again" ends it, and with the account created, it does not return. **You are on the waiting list**, right after registration (or upon opening the page already on the waiting list), once per browser. **Access granted!**, when your turn arrives and the character does not exist yet, with **Create character** taking you straight to his screen. None of them appear via mobile port, in timelapse, or in demo mode.
- **Character:** player name, visual tip, the same appearance editor as the agent drawer, 2 or 3 personality traits (those that don't combine are disabled), and a presentation phrase from the list; can be created while still on the waiting list. If moderation changes the name, the section asks for a new name, which enters without waiting 30 days.
- **Building visibility:** live or discrete, closed to visits, hide country, tokens (only in ranges), leaderboard, compacts, and **Notify when knocking on the door** (disabled by default).
- **Account and data** (new Habblaud World window screen): **Notify via email before removing my building for inactivity** switch; **Download my data**, which saves `habblaud-world-dados.json` with what the world stores about the account (once a day); and **Delete account** in three steps: what disappears and when (the building and profile immediately; the account, likes, blocks, reports made, and database devices in 7 days; backups in up to 30), confirmation, which sends a code to the email, and the code. With the account deleted (from here or another computer), the building connection closes and `world.json` disappears from this computer; the section warns that the account was deleted.
- **Your building in the world:** with access granted and character created, **Your building** card shows if the building is connected, reconnecting, paused, or outside the world (or if character is still missing), how many floors and agents it has, when the last shipment went out and, if the world rejects a shipment, the reason. When the world server stops the building, the card says why: **Update Habblaud** (old version), **Connected on another computer** (with **Bring to this computer**), account suspended or banned (with **Appeal via email**, which opens an email to privacidade@habblaud.com with the account id in the subject), or account deleted. A building marked as **unverified** shows the stamp and **Contest via email**, and the world in maintenance appears as **Under maintenance** (Habblaud retries by itself, with wait). **Pause** stops sending immediately and deletes the building, saving the lot; **Resume** turns it on again. **Leave world** (in two clicks, with the difference to pause next to it) removes the building immediately and frees the lot; the account and character continue, and **Back to world** creates a new building, in another lot (leaving on another computer also works here). **See what was sent** opens the exact JSON of the last shipment, with time, size in bytes, world response (with the bytes it counted), and a copy button: it is everything that left the computer. The theme chosen in **Appearance › Office theme** also applies to the building (and the theme saved for the building applies to the office), and the top bar gets the "🏙️ in world" / "⏸ paused" / "⚠️ stopped" stamp, which opens the section (disappears on narrow bar and mobile).
- **The building goes up to the world:** with account granted and character created, Habblaud opens a connection (WebSocket) with the world server and sends the building live: one floor per room with someone present and, per agent, only a random id, main or subagent, the tool, status, a random name, and appearance; plus theme, tasks completed in the day in a range, building tokens rounded (disable-able) and, if you enable, compacts. Floor and agent ids are random and change every 24 h (±6 h); paths, room names, titles, activities, model, branch, account, and edited names never leave. Sends upon change (at most once every 5 s), reconnects by itself with increasing wait (2 s to 60 s, also in world maintenance), and stops when the server asks (account suspended, banned or deleted, old version, connected elsewhere). Demo mode agents never go up. Tasks and compacts are also counted with the building paused or without connection, and go in the next shipment.
- **The city (World button):** with scene available (`meta.world.scene.available`), **World** button next to Timelapse switches the office to Habblaud World city, in 3/4 pixel art in the same style: 6-lot blocks with sidewalk, curb, poles, trees, crosswalks, and central square with fountain, benches, and totem; empty lots become gardens (park, lake, orchard, cafe). Each building has the height of open projects (up to 12 floors drawn, with "+N" plate above that), windows lit in proportion to agents working and blinking amber for those waiting, owner's theme (pumpkins, webs, and bats at Halloween; snow, lights, garland, and tree at Christmas), everything off with "Closed" sign when the building is out, color and finish by lot seed and plate with flag, owner's name, and ❤️ likes. The bottom row of each block shows the facade with showcase and door; the top row, with the door facing north, shows the roof with the entrance marquee and the back. At night the poles and windows light up. Walk with arrows/WASD (Shift runs) or clicking (office A*); the camera follows, with the usual zoom and pulling back until seeing about 200 buildings; near a door **Enter (E)** appears (see "Visit a building", below). Hovering over a building opens the card (owner, country, status, floors up to "24+", agents working, waiting, and idle or "discrete mode", likes, "in world since"); clicking a player opens the profile (character, country, traits, phrase, building, and likes received). Other players walk smoothly, a bit behind, at the pace positions arrive (5 per second for the 20 closest, 2.5 for others), with name on top; who stops on a bench appears sitting (you too), and away your character stands where he is. The minimap in the corner shows surrounding blocks, brighter the more buildings connected, and takes the camera where you click. Esc or **Office** return, and reopening the city returns exactly where you were (character, camera, and zoom, without blinking); Settings remains open in the city, and the office stops drawing during this time. The scene is loaded only when opened. **Paused or outside the world, your building is off, but you can walk around the city**: with the scene open, the connection carries only the first message, life signal, and scene commands, never the building packet, and closes along with the scene. Account banned, suspended, or deleted (or building stopped by old version or another computer): World button disappears; it also only appears via the computer's own page (never via mobile port nor without local-only access).
- **The city via local server:** with the scene open, Habblaud asks the world server for the piece of city around your character (`view`) via the same building connection and passes it to the browser via `GET /api/world/stream` (SSE: entire state upon opening, then every change in order); closed the scene, warns (`view.off`) and nothing else descends. Buildings by chunk with revision (a jump requests the area again), players nearby, minimap, and your position stay only in memory. Character commands (`POST /api/world/cmd`: walk, profile, resync, view, view.off, enter, leave, like, unlike, greet, block, unblock, and report) are checked field by field, max 5 batches per second, and only the last step of each batch; max 4 tabs with the city. Only via the computer itself and only via the page itself (never via another site). City geometry (lots, blocks, doors, chunks, and what is walkable) stays in `shared/world/city.ts`, same as the world server. Your character enters the street at the position the world server validated (on the sidewalk of your door or in the square).
- **Visit a building:** within 2 tiles of a building's door, **Enter (E)** takes you inside: the owner's office as he sees his, with his theme, rooms with the day's fictional names ("Ipê Project", "Jade Project"...) and agents in current status (typing, hand raised, eyeing terminal or idle, with fake social life in your browser), changing on the spot with every owner packet. You enter by elevator with your **visitor** badge and walk with keyboard or clicking (without sitting at desks). The top bar says whose building it is, how many floors and agents, and if it's in discrete mode (empty rooms, with light on) or off (paused: everything dark); panel on the side lists rooms and agents (name, role, tool, and status; clicking opens a card with this and nothing else). Nothing coming from the world has time, so inside there is no popcorn, web, timer, nor "waiting for X". **Exit** via button, Esc, or reception elevator returns to the sidewalk in front of the door. In the panel, **Like** (with total; from inside, without the door distance) and **Leave a stamp** (one of the 8 reception stamps, one per building per day); the corkboard in reception shows the stamp you left today and, in your own building, those from "While you were away". Building closed to visits, full (20 visitors), blocked, or too far away gives a warning on screen. Nothing that acts in the office exists in the visit (no terminal, drawer, feed, warnings, permission requests, messages, My day, timelapse, editor, or renaming room): it runs in a separate world, which only speaks to `/api/world/*`, and no step of yours inside leaves the computer. The little coins of the visited agents' social life stay in a separate key and disappear upon exit. **See how others see** (on **Your building** card and your building door) enters your own building. **For the owner:** top stamp gets "👀 N" and **Your building** card, "N visitors now" (count only, never who); first visitor of each connection gives warning "Someone entered your building", disable-able in **Habblaud World › Notify when someone visits**. Via local server, scene stream passes the interior (`building`, `building.patch` with checked revision and `resync {building}` on jump) and visitors (`visitors`, also in `meta.world.building.visitors`).
- **The light social, without any free text:** in the city, **L** (or the ❤️ button that appears near the door, up to 4 steps) likes a building, and the heart flies to the plate, whose counter jumps; **G** opens the wheel with the 10 greetings (keys 1–9 and 0, arrows or touch), for whoever just greeted you, whoever is on the card, or whoever is closest, with 5 s balloons over heads (one doesn't cover the other) and "G to reply" when someone greets you; **K** knocks on the door of whoever accepts (up to 2 steps). Player card gets **Greet**, **Block** (in two clicks: you stop seeing each other), and **Report** (fixed reasons, "Report sent"); building card, **Like**, **Knock**, building code, and "unverified" stamp. On minimap, **Go to HB-XXXX** and **Visit a random building**, with a fade while the character goes to the door sidewalk. In the square, the thermometer of the weekly collective goal ("10k hours of agents working") and the town hall plate (lit buildings and "the city consumed ≈ X this week", only with 10 buildings or more); goal met, 20 s of fireworks (sometimes heart-shaped) and, for all, little flags with little lights and the ornament of the season. On facades, the day's token meter next to the door, the sign with 5 intensities by the week's range (from off to neon with sparks), and confetti when a building finishes the turn. On mobile, buttons are in the corner, with icons only. **In the office:** bar chip gets "❤️ N today"; upon connecting, **While you were away** card (visits, likes, and stamps left at reception, without who) appears in the corner and also in **Your building**, with the building code to send to a friend; **Notify when knocking on the door** (Visibility, disabled by default) shows "Someone knocked on your building's door"; **Habblaud World › Blocked** lists whom you blocked, with **Unblock**. **Via local server:** `POST /api/world/summary/seen` and `/api/world/unblock`, and the `like`, `unlike`, `greet`, `block`, `unblock`, `report`, `stamp`, `teleport`, `knock` and `summary.seen` commands in scene, checked field by field.
- **Local routes** (`/api/world/*`, only via computer itself): account (registration, code, login, logout, resend, change password, character, visibility with optional inactivity warning, devices); building (`POST /api/world/pause` and `/resume`, which stop sending before replying; `/leave`, which only replies after world server removes building; `/join`, which requests return before reconnecting; `PUT /api/world/theme`, with automatic becoming day theme; `GET /api/world/last-uplink`, last shipment saved in `~/.habblaud/world-last-uplink.json`, permission 600); and account and data (`POST /api/world/delete-account` and `/delete-account/confirm`, which only replies after closing building and deleting `world.json`; `GET /api/world/export`, account JSON as attachment, only via page itself, because it consumes daily quota; `HEAD` does not call world server). A resume that the world server did not confirm retries with reconnection wait. World status and snapshot (`meta.world.building`) bring building summary: connected, paused, outside world, stopped, floors, agents, and last shipment.
- **Open protocol and transparency:** `shared/world/protocol.ts` and `schema.json` define everything Habblaud swaps with the World (Phase 4 adds door warnings, owner's visitors, and building `resync`; Phase 5, light social names: stamps, city goals, today's likes, "while you were away" summary, knocking on door, and building code; Phase 6, `goodbye` `deleted`, `maintenance` error, `implausible` refusal of packet, `notifyInactivity` of visibility, building `unverified` stamp, and deletion/export formats); rules of player name, 14 traits, 20 presentation phrases, 10 greetings, and 60 fictional floor names ("Ipê Project", "Jade Project"...) stay in `shared/world/`. `docs/world/privacidade.md` lists every packet and connection field, with a test that checks page against `schema.json`; projection tests check every key and that no office text appears in the packet. The warning about true data, for people and AI agents, is in `CLAUDE.md`, `AGENTS.md`, `shared/world/README.md`, and World files, and `CONTRIBUTING.md` has the rule for PR review that touch it.
- **Demo mode:** `?mock=1&world=logged_out` (or `waiting`, `approved`) simulates the server (code is 123456), with the building and sample shipment from `docs/world/privacidade.md`; `?mock=1&world=approved&scene=city` opens a fake city (20 buildings, yours at lot (3,1), 5 people walking and one sitting on a square bench; `&perf=N` fills N lots), with buildings to visit (live, discrete, and off) and light social (bots that greet and reply, goal at 80% and, with `&fireworks=1`, fireworks test button). `npm run shots:world` redo captures `docs/screenshots/world-predio.png`, `world-enviado.png`, `world-cidade.png`, `world-cartao.png`, `world-visita.png`, `world-visita-painel.png`, `world-social.png` and `world-praca.png`.

## [0.11.0] - 2026-10-13

To update: `git pull` and `npm run docker:up` (it also updates the Habblaud mod in accounts). Access by mobile is optional and remains disabled until you run `npm run remote:setup`; the step-by-step is in the README, under "Mobile with login and HTTPS". New agent needs `HABBLAUD_PTY=1` in `.env`.

### Added

- **Mobile with login and HTTPS (optional, disabled until configured):** `npm run remote:setup` asks for user, password (stored only as scrypt hash in `.env`), a name for address (`https://<name>.local`) and, if desired, own address (e.g., `myclaude.home`). It creates a local CA and server certificate and leaves the `<name>.local` announcement running as a service. Mobile enters on a **second port** (443 if free, otherwise 4748), which is only published after setup: every request on it requires login, and by default mobile **approves and refuses permission requests**; messages, terminal (with **Deliveries**: what each agent finished, with summary and attachments), and New agent only with `HABBLAUD_REMOTE_ALLOW`. Port 4747 continues only on computer and without login. **Settings › Mobile access › Logout** ends login from that device (a cookie copy also stops working). Contribution by @jasminaladdn (#96).
- **New agent (button + on top bar, opt-in with `HABBLAUD_PTY=1`):** starts a Claude Code session in the background on the computer (`claude --bg`), in the chosen folder (recent projects come suggested), with written request and attachments; it appears in the office and receives messages and permissions via Habblaud. In a folder Claude Code does not know yet, opens the new session screen of the Claude app filled. In Docker, who starts is the host helper (`npm run codex:bridge`, which now also runs without Codex). From mobile, also needs `spawn` in `HABBLAUD_REMOTE_ALLOW`.
- **Dictation** in New agent and message box: browser records and **local Whisper** transcribes (`whisper-cli` + `ffmpeg` + a multilingual model); voice does not leave the computer. Without them, button does not appear.
- **Wait for up to 24 h via office:** `HABBLAUD_PERMISSION_TIMEOUT` accepts up to 86400 s (before 1800, and the plugin cut at 330 s). Default remains 5 min. On long wait, without any page answering for 5 min (and without mobile with login configured to answer), request returns to terminal.
- **Messages to Claude desktop app sessions:** `habblaud-mensagens` plugin also asks Habblaud in sessions with `CLAUDE_CODE_ENTRYPOINT=claude-desktop` (before only in those with terminal on screen).
- Request waiting without buttons in office (hook already returned to terminal, or session opened without plugin): terminal footer says to answer in Claude Code (or Codex).

### Security

- On remote port, what separates "from computer itself" from "from network" is the port connection arrived on, never Host header. Hook, plugin, and host helper routes, interactive terminal, character editor, and renaming rooms never count via it, not even with login.
- Local CA only signs `localhost`, `.local` names, own address, and private network IPs (`nameConstraints` critical): even with leaked key, certificate for another site is refused. Key never goes to container.
- Session in `HttpOnly`, `SameSite=Strict`, and `Secure` cookie, signed with HMAC (changing password logs out all). One password check at a time, counted before scrypt; after 5 wrong passwords in a row, each attempt waits from 1 s to 5 min.
- In Docker, host helper only reads delivery files of known project folders (those Claude Code has in `<account>/projects`), temporary folder, and attachments, and nothing like a secret. Files and dictation use rounds with wait (server only replies when work arrives), instead of asking every half second.

### Fixed

- Mobile: touching a text field no longer zooms (iPhone Safari enlarges fields with letter smaller than 16 px).
- In timelapse, corner warnings stay above playback bar, instead of covering timeline and buttons.
- With many accounts or narrow window, top usage cards go to a second line of the top bar, instead of covering buttons on the right (zoom, My day, Settings, Help).
- On mobile (up to 480 px), top bar no longer cuts logo and side panel button: counters move to usage card line.
- "My day" on mobile: Demo | Real data selector no longer leaves the screen (in French, not even at 390 px).
- Two permission requests from same agent at same instant: detail of the newer one no longer says there is another request waiting behind it.
- "My day": the limit of 1,000 waits per day also counts when all are open (before list and daily file grew without ceiling).
- A transcript file rewritten in same place (instead of just growing) is read from beginning; before new content was ignored or read from middle.
- On Windows, with Node 23 to 24.19, plugin hook `habblaud-permissoes` crashed on exit (code 0xC0000409, a Node bug: nodejs/node#56645) right after receiving office reply. Decision arrived before crash, but without decision (like in "Answer in terminal") session could register hook error. Now hook exits without crashing.
- `npm install` changed `package-lock.json` (repository one was outdated compared to `package.json`), and that's why `git pull` of next version stopped with "Your local changes … would be overwritten". Now the file is the same. Those who already have the change run `git checkout -- package-lock.json` once before `git pull`.
- On Windows, installers (`usage:install`, `hooks:install`, `codex:install`, and `mod:install`) showed user folder paths entirely (`C:\Users\...`) instead of `~/...`.
- Test suite (`npm test`) passes on Windows: tests assuming Linux/macOS paths, shell, or permissions now hold on all three systems, and the few depending on something Windows lacks are skipped on it.

## [0.10.0] - 2026-10-13

To update: `git pull` and `npm run docker:up`. Interface follows browser language (or Settings › Language). Server-assembled texts remain in Portuguese; for other language, define `HABBLAUD_LANG` (`en`, `es` or `fr`) in `.env` before `docker:up`. In October, automatic theme already puts office in Halloween mood; for usual look, choose **None** in Settings › Appearance.

### Added

- **Office themes** in Settings › Appearance: pixel art decoration (trees with gifts, garlands, and snow in windows at Christmas; pumpkins, ghosts, webs, and bats at Halloween), lights, rugs, and accessories on characters. **Automatic**, default, follows calendar: Halloween from Oct 1 to 31 and Christmas from Nov 1 to Dec 26 (rest of year, usual look). **None** leaves usual look all year, and **Christmas** and **Halloween** fix a theme. Choice stays saved in browser.
- **Interface in English, Spanish, and French.** Texts go through `tr()` (`shared/i18n.ts`), with Portuguese as source language: text without translation remains in PT. Interface follows browser and can be fixed in **Settings › Language**. Texts assembled by server (activities, warnings, terminal, logs, and installation scripts) follow `HABBLAUD_LANG` (`pt-BR`, `en`, `es` or `fr`) and, without it, system language, except English (many machines and every container come in English by default): for English server, `HABBLAUD_LANG=en`. `npm run i18n:check` lists texts still without translation. French came from community (#67).
- **README in English**, with versions in Portuguese (`README.pt-BR.md`), Spanish, and French, and language line at top of each.

## [0.9.0] - 2026-10-13

To update: `git pull` and `npm run docker:up`. Interactive terminal comes disabled and only works outside Docker: `npm install`, `npm run build` and `HABBLAUD_PTY=1 npm start` (read warning in "Privacy and security" in README first).

### Added

- **Interactive terminal (opt-in, `HABBLAUD_PTY=1`):** real Claude Code in an office window, with tabs for agents of same project. **New session** opens Claude Code in room folder; **Take over from here** ends session open in another terminal and continues same conversation here (`claude --resume`); **End** and tab X close session, here or in another terminal. Only for Claude Code sessions (neither Codex nor demo). Before ending an outside process, Habblaud checks PID is still that Claude Code. Uses `node-pty` and `@xterm/headless` (optional dependencies); screen returns entirely upon reconnecting or switching tabs, with modes Claude enabled. Upon starting, opens test terminal: if `node-pty` or `claude` don't work, feature stays disabled, with reason in log (on macOS, before it fixes execution permission missing in `node-pty` 1.1.0 spawn-helper).
- **Terminal tabs and shortcut:** terminal window gained tabs with main agents of same project (with beginning of what each does), and side list, a shortcut next to each agent that opens his terminal. With terminal open, clicking another agent in list switches window to his. Valid also for live terminal, with interactive disabled.

### Fixed

- Message sent via office no longer goes to wrong conversation: if agent switches conversation (`/clear`, `/resume` or another thread in Codex) before retrieving it, it fails with reason instead of entering new conversation.
- Old tasks and their states are preserved when recovering sessions with long history that gained new tasks.
- Activity detail no longer shows webhook secrets (Slack, Discord, Telegram) nor `npm_` and `hf_` tokens pasted in a command.
- Codex messages in Docker are now delivered one at a time per session and confirmed individually, reducing premature failures and duplicate retries.
- Malformed task lists from Claude Code do not interrupt reading; office preserves other activities of same batch, including in subagents.
- Image from Codex recorded on Windows (C: drive or network folder `\\server\...`) appeared with wrong path in activity and terminal (`/C:/...`, or folder without server). Now path is that of source file.
- Saving character or back to drawing no longer closes another open edition while reply arrives, nor shows an error from previous edition.
- Huge line in conversation, or line that never closed, stayed entirely in memory and reading slowed down. Line above 8 MB is now ignored, and Habblaud follows in next line.
- Reverted Codex sessions now show current turn in office and terminal, even when old conversation file remains on disk.
- In timelapse, agent timeline stops showing what happened after reproduced moment when going back in time. History reply still on its way also doesn't enter during replay.
- In timelapse, panel times follow reproduction and stand still upon pausing, along with office and replay stamp.
- Paused feed saves only 50 most recent events and releases old session data, maintaining count of novelties.
- In timelapse, arrows on playback control switch speed, instead of moving office camera.
- Office avoids duplicate live connections and releases network and source resources when closed.
- `usage:install`, `hooks:install`, `mod:install` and `codex:install` stop when config file changes in middle of installation, instead of deleting that edition (it also disappeared from backup). Run command again; backup becomes replaced file.

## [0.8.0] - 2026-10-09

To update: `git pull` and `npm run docker:up`. Renaming rooms and editing character work only via computer itself (same terminal lock). Room names stay in `rooms.json` and characters in `names.json`, in Habblaud data folder; reverting to 0.7 makes chosen characters disappear upon first recording.

### Added

- Side list and character tip show session title (in subagents, task) below name. In list, main agent idle for 1 minute or more shows **idle 12 min** instead of "Main"; in tip, state comes with how long he has been like this (**12 min ago**).
- **Movable windows:** terminal and agent drawer detach by dragging bar, change size by any border or corner, and return to spot with double click on bar. Terminal gains **Expand full screen** button. Position and size stay saved in browser; in narrow screen everything remains fixed. Detached, drawer stops reserving office side.
- **Reorder side list:** dragging a main agent line changes order of agents in room, and dragging room header changes order of rooms (in building they stay where they are). Order saved in browser; agent order goes via Claude Code session and survives session resume.
- **Rename room:** right-click a room (in side list or office) opens a field to name it; empty returns to folder name. Name stays on server (`rooms.json`, in Habblaud data folder), per folder: valid in any browser and survives restarts. In room drawer, pencil next to name opens same field. Only via computer itself; demo rooms do not change.
- **Edit project character.** In main agent details, pencil next to name opens editor with name, **Draw**, and parts (skin, hair, beard, eyes, clothes, shoes, accessory), with preview. Choice holds for project: next session in same room arrives with same character, and **Back to drawing** undoes. Only works via computer itself, like terminal.

### Altered

- Agent timeline shows 15 most recent items, with **Show more** (15 more per click, up to 200 saved) and **Show less** (back to 15). Before it was 80 at once.

### Fixed

- On Windows, messages to Codex searched `codex` in PATH and found script npm installs next to executable: Habblaud said messages were enabled, but each delivery failed because script doesn't run without shell. Now search is for `codex.exe`. With Codex installed only by npm, point `HABBLAUD_CODEX_BIN` to a `codex.exe`.
- On Windows, statusline command that already existed before `npm run usage:install` (Habblaud keeps it and continues running) was executed by `cmd.exe`, and what worked in Claude Code (single quotes, variables, pipes) broke. Now it runs in Git Bash, like in Claude Code: `CLAUDE_CODE_GIT_BASH_PATH` one or installation's Git one. Without Git Bash, continues in `cmd.exe`.
- On Windows, installers (`usage:install`, `hooks:install`, `codex:install`, and `mod:install`) showed user folder paths entirely (`C:\Users\...`) instead of `~/...`.
- Test suite (`npm test`) passes on Windows: tests assuming Linux/macOS paths, shell, or permissions now hold on all three systems, and the few depending on something Windows lacks are skipped on it.

## [0.7.0] - 2026-10-09

To update: `git pull` and `npm run docker:up` (it also updates Habblaud mod in accounts). Access by mobile is optional and disabled until you run `npm run remote:setup`; step-by-step is in README, under "Mobile with login and HTTPS". New agent needs `HABBLAUD_PTY=1` in `.env`.

### Added

- **Codex in office.** OpenAI Codex sessions (CLI `codex` and app) enter office like Claude Code's: each project is a room (same as Claude Code, when both in same project), each session a character with **CODEX** stamp, with activity, subagents, terminal, history, usage of 5 hours and weekly (with data age and "no quota" when credits end), and My day (tokens only: Codex does not inform cost). Without installing anything, Habblaud reads Codex files (`~/.codex`, `CODEX_HOME` or `~/.codex*`; `HABBLAUD_CODEX_DIRS` chooses folders and `HABBLAUD_CODEX=0` disables). A session enters with first message, which is when Codex says project folder (CLI open and still without conversation doesn't appear). In Docker, only `sessions/`, `archived_sessions/`, and `thread-writer-locks/` are mounted, read-only.
- **Live Codex and approve via office:** `npm run codex:install` adds Habblaud hooks in `~/.codex/hooks.json` (with backup; hooks of other apps stay in same place) and, after approving them in `/hooks` in Codex, activity is current one (not just when each step finishes) and approval requests wait for your answer in office for up to 25 s (`-- --espera <s>`) before going to terminal. `codex:status` checks and `codex:uninstall` removes.
- **Messages to Codex** via same **Send message** box, via `codex queue` (enter when session finishes what it is doing). In Docker, leave `npm run codex:bridge` running on Mac.

### Altered

- Codex folder never becomes Claude Code account, nor listed in `HABBLAUD_CLAUDE_DIRS` or `CLAUDE_CONFIG_DIR`; server and `docker:up` warn.
- With four accounts or more, top usage cards become narrower and zoom buttons disappear until 1700 px width, not to invade buttons on right.

## [0.6.0] - 2026-10-09

To update: `git pull`, `npm run docker:up` and `npm run mod:install` (brings new permission and message plugins); in already open sessions, `/reload-plugins`.

### Added

- **Answer agent questions via office.** When agent asks question (`AskUserQuestion`), questions card shows each with options and descriptions: choose one (or several, when question allows), write yours in "Other", or refuse. As in permissions, dialog continues in terminal and whatever you answer first wins; `P` key and "needs you" counter also lead to questions. Needs `habblaud-permissoes` plugin of this version.
- **Send messages to agents via office.** Each main agent's details gain "Send message" section: text enters session as if typed in terminal (with agent busy, enters when he finishes turn), and box shows if message is in queue, delivered, or not. Comes from new plugin, `habblaud-mensagens` (Claude Code 2.1.287+), installed by `npm run mod:install` (`-- --sem-mensagens` leaves it out); `npm run docker:up` does not install it alone, only warns. Follows terminal lock (only local access) and `HABBLAUD_MENSAGENS=0` disables. Read warning in "Privacy and security" in README: any program on this machine can send message to sessions that have the plugin.

### Altered

- **Terminal (`T` key) accepts typing.** Stopped being "read-only": in main agents, footer became message box (`Enter` sends, `Shift+Enter` line break). Subagents and history sessions remain read-only.
- `npm run mod:install`, `mod:status` and `mod:uninstall` handle also `habblaud-mensagens` plugin, and `mod:status` says if Habblaud has messages enabled.

## [0.5.0] - 2026-10-09

### Added

- "Needs you" card shows full `AskUserQuestion` questions, with options and descriptions (up to 4 questions, with 6 options each). Read-only: response continues to be given in Claude Code.
- Automatic check on GitHub (Actions): every push to `main` and every pull request, project runs `typecheck`, tests, and build on Node 22.12, minimum version declared in `package.json`.

### Fixed

- When transcript file was deleted and another, larger, created in place, Habblaud might not notice swap: some file systems reuse number (inode) of deleted file, and only inode was compared. Now they also count file creation time (when system reports it) and beginning, and reading restarts from start of new file.
- On Windows, with Node 23 until 24.19, `habblaud-permissoes` plugin hook crashed on exit (code 0xC0000409, a Node bug: nodejs/node#56645) right after receiving office reply. Decision arrived before crash, but without decision (like in "Answer in terminal") session could register hook error. Now hook exits without crashing.
- `npm install` changed `package-lock.json` (repository one was outdated compared to `package.json`), and that's why `git pull` of next version stopped with "Your local changes … would be overwritten". Now the file is the same. Those who already have the change run `git checkout -- package-lock.json` once before `git pull`.
- On Windows, mod did not record 5h and weekly usage when `HOME` was not defined (normal outside Git Bash): now uses `USERPROFILE`. And `CLAUDE_CONFIG_DIR` with `\` (e.g., `C:\Users\you\.claude-account2`) became an invalid file name; now gives same account, including Habblaud in Docker.

## [0.4.0] - 2026-10-08

### Altered

- **CodeTown is now Habblaud.** Name changes everywhere: interface, logo, reception plate, entry totem, link preview, repository (`github.com/marmottajr/habblaud`), marketplace, and Claude Code plugins (`habblaud` and `habblaud-permissoes`, with `/habblaud` command), environment variables (`HABBLAUD_*`), state folder (`~/.habblaud`), and Docker (container and image `habblaud`, volume `habblaud-data`).
- For those coming from CodeTown: run `npm run mod:install` once (swaps marketplace and old plugins for new ones in each account) and `npm run docker:up` (removes old container and copies names, timeline, and stats from `codetown_codetown-data` volume to new one, without deleting old). `~/.codetown` folder and preferences and little coins saved in browser move to new names by themselves. `CODETOWN_*` variables are no longer valid: rename to `HABBLAUD_*` in `.env` (server and `docker:up` warn). Details in README, under "Coming from CodeTown".

## [0.3.2] - 2026-10-08

### Fixed

- When terminal closed and its room was dismantled, a garden remained in the middle of the building, between rooms. Now the farthest room moves to the slot: is mounted there, still off; first to arrive turns on light and each returns to same desk. Old address is deleted and dismantled, and building shrinks. A room that opens occupies first free slot, and initial load already arrives without holes.
- Whoever was on the way to something that ceased to exist, like the water cooler of a corridor column that disappeared when building shrunk, was teleported. Now changes plan and keeps walking.

## [0.3.1] - 2026-10-08

### Fixed

- Whoever was napping at desk (idle for more than 10 minutes) and got up for a wheel, party, or stroll started walking with "zzz" on head. Now "zzz" only appears while character sleeps.

## [0.3.0] - 2026-10-08

### Added

- **Habblaud Mod for Claude Code** (2.1.287 or newer): `npm run mod:install` installs, in each account, this folder's marketplace with `habblaud` mod (live 5h and weekly usage, a line in terminal when another session needs you, and `/habblaud` command) and `habblaud-permissoes` plugin (answer permissions via office; `-- --sem-permissoes` leaves out). `npm run mod:status` shows what each account has and `npm run mod:uninstall` removes everything. `npm run docker:up` updates mod of those who already installed.

### Changed

- Statusline tap (`npm run usage:install`) and permission hook (`npm run hooks:install`) become the old way, for Claude Code prior to 2.1.287. `npm run mod:install` removes both from account (with backup), because mod does same. Interface and README start teaching `npm run mod:install`.
- Permission hook script changed to `mod/habblaud-permissoes/hooks/permission-hook.mjs`. Old path (`scripts/permission-hook.mjs`) became shortcut, so whoever installed hook before continues working.
- In Accounts and usage, data source says when coming from mod ("live (Habblaud mod)").
- Live usage reader ignores half-read file and stays with last good number, instead of hiding account for one cycle.

## [0.2.0] - 2026-10-08

First published version.

### Added

- **Version and updates:** version in use appears on top bar and Settings › About. Every 6 hours Habblaud checks releases on GitHub; when new version comes out, **New version** stamp appears, with warning and link to what changed. `HABBLAUD_UPDATE_CHECK=0` disables query.
- **My day** (M key): where agents' time went, how long they waited for you, tokens and cost, with 30 days of history.
- **GitHub in office:** PR opened or merged and release published become party in room; red CI turns on alarm, until green CI.
- **Answer via office** (P key): with hook installed (`npm run hooks:install`), approve, refuse, or "always allow" permission requests without going to terminal. Only with local access.
- **Timelapse of day** (L key): office reproduces day in high speed.
- **Read-only terminal** (T key): each agent's conversation, live, in Claude Code style, with search, filter, copy button, and history of sessions from last 7 days. Only with local access.
- **Day and night** by local time and synthesized **sounds** in browser (disabled by default).
- **Social life:** who is idle joins wheels (TV, videogame, ping-pong, chat in breakroom, rock-paper-scissors for little coins), with personalities, friendships, and rivalries.
- **Waiting for shell:** agent waiting for long command stays at desk with hourglass, and wait becomes a gag.
- Session forks appear in office.
- Open page reloads itself when server starts serving another version.
- Container uses computer timezone.
- **The office:** each project open in Claude Code becomes a room and each session, a character with own name. Subagents arrive, work, and deliver to main one. Shows both accounts, with 5h and weekly usage of each (statusline tap), plus activity feed, warnings, and demo mode. Runs on Node or local Docker.
