# Habblaud World: what leaves your computer

Habblaud World is an online city where every Habblaud becomes a building: people walking by can see, in real-time, how many projects and agents you are running and what each character is doing. The rule that guides everything here:

> **From the data that leaves, it is impossible to know who you are or what you work on.**

**Current status:** the World is online and comes **enabled by default**, pointing to `server.habblaud.com` (or the `HABBLAUD_WORLD_URL` you define; see the README). **Nothing leaves the computer before you create an account and log in**; `HABBLAUD_WORLD=0` disables everything. This page is the complete list of what can leave; any change to it must be included in the code and on this page in the same pull request.

## What leaves: account and character

When using the World, the following data is sent via HTTPS to the world server:

| Leaves | When | Why |
| --- | --- | --- |
| Email and password | During registration, login, and when changing the password | For the account to exist. The password is not stored on the computer; on the server, only a hash (Argon2id) |
| Nickname | During registration | It is your character's name (3 to 20 characters, unique in the world, case-insensitive, no accents): it is reserved for you while the account waits on the waitlist, and the character is created with it |
| 6-digit code | When confirming email or changing the password | To prove the email belongs to you |
| Interface language (`pt-BR`, `en`, `es`, or `fr`) | During registration | So emails are sent in your language |
| Terms of Use acceptance (version, `v1`) and invite code, if you have one | During registration | To register acceptance; the invite puts the account in the next batch of the waitlist |
| Anti-bot challenge solution (ALTCHA) | During registration, email requests, and if the server asks, upon login | It is a number calculated by your Habblaud, instead of a captcha |
| Character: appearance (colors and styles), 2 or 3 traits, presentation phrase and, when changing it, the nickname (when creating, the name is the one reserved during registration: it is not sent in the request) | When saving the character | What other players will see |
| Visibility preferences (live or discrete, closed to visitors, hide country, show tokens, scoreboard, compaction) and email warning before removing the building due to inactivity | When saving | So the world respects your choice |
| Device token | In every account call | To prove it is you, without sending the password again |
| Which device to disconnect | When disconnecting one | Only the ID the server gave to the device |
| Pause and resume the building | When clicking Pause or Resume (`POST /v1/me/building/pause` and `/resume`, with token) | So the building turns off instantly for everyone and comes back when you want |
| Exit the world | When confirming "Exit the world" (`DELETE /v1/me/building`, with token) | So the building exits the world instantly and the plot becomes free; the account and character remain |
| Return to the world | When clicking "Return to the world" after exiting (`POST /v1/me/building/join`, with token) | So the server accepts the building again (a new building, on another plot) |
| Delete the account | When requesting deletion and typing the code received by email (`POST /v1/me/delete` and `/v1/me/delete/confirm`, with token and code) | For the server to delete the account: the building and profile disappear from the world instantly; the account, likes, blocks, reports made, and devices leave the database in 7 days and backups in up to 30. Here, `world.json` is deleted |
| Download my data | When clicking "Download my data" (`GET /v1/me/export`, with token; once a day) | The server returns, in a JSON file, what it stores about your account (including the reserved name, country, and IPs from registration and last login); nothing new leaves the computer |
| Habblaud version | In every call, in the `User-Agent` header (`Habblaud/1.0.0`) | Compatibility and diagnostics |

While the account is on the waitlist, the open Habblaud asks the world server, every 30 minutes, if access has been granted (`GET /v1/me`, with device token only). Once granted or logged out, it stops.

The world server sees the connection IP (like any website). It stores the **country** (which can be hidden) and, in clear text, **two addresses only**: the registration IP and the last login IP with password, for auditing and fraud prevention. Only the administration team sees these IPs; they appear in "Download my data" (`signupIp`, `lastLoginIp`, and `lastLoginAt`) and are deleted with the account. The daily summary by IP that limits attempts (registration, login, codes) continues as before. No other IP is stored: neither the building's connection IP, nor those of walks around the city.

## What leaves: the building (the closed list)

With the account granted and character created, your Habblaud opens a connection (WebSocket, via TLS) to the world server and your building enters the city. Through the connection, **only** the following leaves:

| Leaves | How | Why |
| --- | --- | --- |
| First message of the connection (`hello`) | The device `token`, Habblaud `version`, `build` (`commit` of the code in use and `dirty`, the "modified copy" flag) and the interface `locale` | Authenticate, check if it is an official version, and send notifications in your language. The token goes only here, never in the URL; the language does not go in the building package. Never the folder path or anything from the machine |
| The building package | When connecting and, later, when the office changes: at most once every 5 seconds, and nothing if the package hasn't changed | It is the live building |
| Heartbeat (`ping`, and `pong` when the server asks) | Every 30 seconds, no content | To keep the building lit while Habblaud is open (paused or out of the world, it doesn't light anything: it only maintains the World scene connection) |
| World scene opened or closed (`view` and `view.off`) | When opening and closing the city in the browser, no content | For the server to send the piece of the city around your character only while you are looking; with the scene closed, nothing is sent down |
| Your character's steps (`move`) | While you walk in the city (at most 5 per second): the position in the city (`x`, `y`, in tiles), the direction (`dir`: `n`, `s`, `e`, or `w`) and if walking (`moving`) | It is your character on the street; the position is in the world's city, never anything from the office. With the tab in the background, one static step every 30 s |
| Request for area again (`resync`) | When a building change arrives out of order: only the piece of the city ID (`chunk`) or, inside a building you visit, that building ID (`building`) | So your Habblaud shows the right buildings |
| Profile request (`profile`) | When clicking on someone in the street: only the ID (`playerId`) the world itself gave to that person | To show the card of who is nearby |
| Enter and leave a building (`enter` and `leave`) | When pressing E on the door (or "See how others see") and when leaving: only the building ID the world gave (`buildingId`). Inside, no steps leave: your character walks only on your screen | To see the interior of someone's building (rooms with fictional names and agents in current status, no terminal, messages, permission requests, or anything that acts) |
| Light social, when you press (`like`/`unlike`, `greet`, `block`/`unblock`, `report`, `stamp`, `knock`, `teleport`, `summary.seen`) | Only IDs and list items: the `buildingId` or `playerId` the world gave, the `greetingId`, `stampId`, and the `reason` for the report from fixed lists, and the building code ("HB-XXXX", as you typed) in "Go to". No free text | Like, greet, block, report, leave a stamp, knock on the door, go to a building, and say you saw the "While you were away" |

The building package has these fields and no others (the exact format is in [`shared/world/schema.json`](../../shared/world/schema.json); a test verifies that every field in it is on this page):

| Field | What it is | Why |
| --- | --- | --- |
| `v` | Package format version (`1`) | Compatibility |
| `version` | Habblaud version (`1.0.0`) | Protocol compatibility |
| `theme` | `none`, `halloween`, or `christmas`, already resolved: "Automatic" turns into the calendar theme (Halloween in October, Christmas from November 1st to December 26th), by the computer date (in Docker, UTC) | The building and interior with your theme |
| `floors` | One floor per room with someone present, in shuffled order | Building height and interior rooms |
| `id` (of the floor) | A random ID per room (`f_` and 10 characters), which does not come from the folder path, **changes every 24 h** (±6 h) and changes also when the room disappears and returns or when Habblaud restarts. No time information | Who visits today and tomorrow doesn't know if it is the same project |
| `agents` (of the floor) | One per main or subagent working, waiting, idle, or watching a shell | The character doing the right thing at the right desk |
| `id` (of the agent) | Random ID (`a_` and 8 characters), with the same changes as the floor ID | Knowing who is who in the package |
| `kind` and `parentId` | Main (`main`) or subagent (`sub`) and, for the subagent, the world ID **of the agent** that called it (absent if that agent has already left) | The subagent near who called it |
| `provider` | `claude` or `codex` | Tool visual |
| `status` | `working`, `waiting`, `idle`, or `shell`. **Without** "since when" | What the character is doing |
| `look` | Character visual hint (`f` or `m`) | Body and name matching |
| `name` | A random name from the Habblaud name list based on the random world ID (never the office name, edited or not) | Character having a name |
| `parts` | Appearance colors and styles (`skin`, `hair`, `hairStyle`, `eyes`, `top`, `topAccent`, `topStyle`, `bottom`, `bottomStyle`, `shoes`, `accessory`, `accessoryColor`, `facialHair`), randomized from the random world ID, with the pieces you chose in the editor on top | Character with the right face |
| `tasksDone` | Tasks completed today by that agent, only the range: `0` (none), `1` (1 or 2), `2` (3 to 5), `3` (6 or more). Never the title | The "+1" above the character's head |
| `compacted` | Only if you enabled "compaction": `true` when the agent compacted the context since the previous package (`/clear` doesn't count) | The room's trash bin fills up |
| `tokens` | Only if "show tokens" is enabled (enabled by default; can be disabled): `day` (today) and `week` (today and the 6 previous days), the building total (input + output of all agents, from "My day", without demo mode), rounded to 2 significant figures (e.g., 1.2M). Others only see the **range** (up to 100k, 1M, 10M, 100M, above) | Facade gauge |

Nothing else. The package of an office with 3 projects and 5 agents is about 2 KB. Limits are 64 floors, 64 agents per floor, 256 in total and 64 KB (in practice, about 170 agents); above that, Habblaud cuts the last ones and warns in the log. The server checks each field (names within the name list, colors within the palettes, IDs in the format) and refuses the entire package if any field appears outside the list.

### Real example of a package

```json
{
  "v": 1,
  "version": "1.0.0",
  "theme": "halloween",
  "floors": [
    {
      "id": "f_8c1e5f7a2b",
      "agents": [
        { "id": "a_3f9d2c7e", "kind": "main", "provider": "claude", "status": "working",
          "look": "f", "name": "Marina",
          "parts": { "skin": "#e8b48c", "hair": "#2b1d14", "hairStyle": "bob", "eyes": "#3b5a7a", "top": "#4a6fa5",
                     "topStyle": "hoodie", "bottom": "#2f3542", "bottomStyle": "pants", "shoes": "#ffffff",
                     "accessory": "glasses", "accessoryColor": "#222222", "facialHair": "none" } },
        { "id": "a_71c0b5a9", "kind": "sub", "parentId": "a_3f9d2c7e", "provider": "claude", "status": "working",
          "look": "m", "name": "Caio", "parts": { "...": "..." } }
      ]
    },
    { "id": "f_02aa91c4de",
      "agents": [ { "id": "a_b2e74d10", "kind": "main", "provider": "codex", "status": "idle",
                    "look": "m", "name": "Rafael", "parts": { "...": "..." } } ] }
  ]
}
```

(`"...": "..."` abbreviates pieces identical to Marina's. A test verifies this example against [`schema.json`](../../shared/world/schema.json).)

## What never leaves

| Never leaves | Examples |
| --- | --- |
| Project path and name, room name | `/Users/you/projects/client-x`, "Secret project" |
| Session title, branch, permission mode, model | "Fix login", `feat/payments`, `opus` |
| What agents do | Activities, tasks, commands, shells, permission requests, questions, messages, terminal |
| Cost and work numbers | Money spent, lines of code, tool calls, tokens per agent (tokens leave only as the building total, rounded) |
| Your Claude or Codex account | Email, organization, plan, 5-hour and weekly usage |
| The name you gave a character | Can be your real name: in the world, the character gets another random name |
| Character seed | Appearance in the world is randomized from a random ID; only pieces chosen in the editor go up as-is |
| Times | When the session started, when status changed, when the room was born: the package has no time |
| Machine details | Computer name, system user, time zone. The device appears only as "Device 1/2/3" |
| Your history | My day statistics, timelapse timeline, session history |
| Demo mode agents | Left out before assembling the package |

## Live, without identifying anyone

What appears to visitors: **visitors to the world see, in real-time, how many projects and agents you are running and what each character is doing (working, waiting, idle). Nobody sees which projects they are, what agents do, or who you are: only the nickname and avatar you chose.**

- **Nobody is identified:** only the nickname (chosen at registration) and the avatar you chose and the IP country (can be hidden). No email, real name, account name, or machine name. Registration and last login IPs remain only with the administration, never appearing in the world.
- **No project is identifiable:** floor IDs are random and change every 24 h (±6 h), with the room order shuffled.
- **No office time leaves:** the package has no "since when" or any time information. Visiting shows status, never "how long ago".
- **No building history stays:** for the building, the server stores only the day of the last signal and the month it entered the world. There is no building timeline or "last seen".
- **No global feed:** each person only receives the piece of the city around their character; no route lists buildings or players.
- **Nothing proves you are at the computer:** agents work by themselves. The card says "lit" or "off" over the building, never "online" over the person.
- **Discrete mode:** only lit or off and number of floors, without counters or statuses. **Closed to visits:** nobody enters.
- **Visits:** whoever enters your building sees rooms with fictional names and agents in their current status; in discrete mode, empty rooms with lights on; paused, everything off. You see only "N visitors now", never who. And what you see inside others' buildings stays on your screen: nothing from the interior goes up, not even your character's position.
- **Block in both directions:** who you block disappears to you and you disappear to that person, including the building.
- **Light social doesn't count who it was:** the owner sees how many visits, likes, and stamps they received ("While you were away") and how many likes they got today, never from whom; knocking on the door arrives without a name, and only if the owner turned on "Notify when someone knocks". City aggregates (the week's goal, the total token range) only appear with 10 buildings or more.

Clearly stated: whoever observes the same building for a long time may notice patterns (more agents on weekdays, for example). Whoever doesn't want even that uses discrete mode or pauses.

## On this computer

- The World account is in `~/.habblaud/world.json` (in Docker, in the `/data` volume), with permission only for your user. The device token leaves there only for the world server, via HTTPS and in the first message of the building connection, and never goes to the browser, logs, or URL. The same file stores the chosen theme for the building (which remains even after logging out of the account) and if the building is paused or out of the world.
- The last building upload (the exact package, time, size, and server response) is in `~/.habblaud/world-last-uplink.json`, also only for your user, and disappears upon logging out.
- Random world IDs live only in Habblaud memory: restarting Habblaud generates new IDs.
- What the world sends to the owner (today's likes, "While you were away", door knocks, and blocked list) stays only in Habblaud memory; in the snapshot (which also goes to the phone) only today's likes, how many knocks occurred, and if there is an unseen summary enter. The stamp you left today in a building stays in the browser (`localStorage`), so the button knows it was already done.
- The World section only works via the computer itself (`http://localhost`), never via the phone, and only with Habblaud accessible only by the computer itself. As with messages via the office, any program on this computer that reaches `localhost` can act on behalf of the account.
- **Pause** stops sending the building package before responding and notifies the world server: the building turns off instantly for everyone and the plot is saved. **Resume** starts sending again (without server response, Habblaud tries to notify again).
- **Paused: your building is off, but you can walk around the city.** With the World scene open, the connection continues (or opens) carrying only the first message (`hello`), the heartbeat (`ping`/`pong`), and scene commands (`view`, `view.off`, `move`, `profile`, `resync`, `enter`, `leave`): no building package leaves, and the heartbeat does not light up the building. Once the scene is closed, the connection closes and nothing leaves. The same applies outside the world.
- **Exit the world** stops the building package sending and only responds after the world server removes the building and frees the plot. The account and character continue (you can walk around the city, like paused); no building package leaves until you click **Return to the world**, which requests return to the world server and creates a new building, on another plot. If the account exits the world on another computer, this one also remains outside the world, without sending packages, until **Return to the world**.
- **The city** (World scene) only comes down with it open in the browser: the buildings and people nearby that the world server sends stay in Habblaud memory and go to the page via `localhost`, never to disk or logs, and are forgotten when closing the scene or losing the connection. The scene only opens via the Habblaud page itself, never via another site.
- Tasks completed and compaction counts in Habblaud memory also with the building paused or without connection; only the day range (and "compacted since the previous package") leaves, in the next upload.
- **Logout** deletes this computer's token and disconnects it on the server. The device list shows where the account is connected (up to 3) and disconnects one by one.

## How the guarantee is maintained

1. **The protocol is public and closed:** [`shared/world/protocol.ts`](../../shared/world/protocol.ts) and [`schema.json`](../../shared/world/schema.json) define every field; the server refuses any other.
2. **One file assembles the building package:** [`shared/world/projection.ts`](../../shared/world/projection.ts), which receives from rooms only the ID and never receives accounts, usage, or statistics. Tests check every package key against the `schema.json` list, that no office text (paths, room names, titles, activities, commands, tasks, branch, model, account, email, edited names) appears in it, and that no number looks like a time.
3. **You see what was sent:** Habblaud World › See what was sent (the city button in the top bar) shows the exact JSON of the last upload, time, size, and server response (accepted, or reason for refusal). It is the same object that went onto the wire.
4. **Open code:** whoever reviews a pull request that touches `shared/world/` or `server/world/` checks this list against what the code sends ([`CONTRIBUTING.md`](../../CONTRIBUTING.md)).
