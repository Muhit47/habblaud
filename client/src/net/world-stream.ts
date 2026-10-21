// The World scene in the browser (Phase 3): city stream (GET /api/world/stream, SSE) and player commands
// (POST /api/world/cmd), plus a FakeWorldStream for demo mode (?mock=1&world=approved&scene=city) and
// tests. The scene only uses `createWorldStream({mock})`:
//
//   const ws = createWorldStream({ mock: store.mock });
//   const off = ws.on((ev) => { ... });   // 'snapshot' (replaces entire state), 'message' (applies in order), 'status'
//   ws.send([{ t: 'move', x, y, dir, moving }]);  // queue: one batch every 200 ms, only the last move per batch
//   ws.close();                                    // closes SSE (local server sends `view.off` if it was the last)
//
// The local server has already verified the `rev` of patches and discarded what does not belong to the scene: the browser applies each `message`
// in the order it arrives (scene uses client/src/world/city/state.ts, starting from snapshot). The world server is never
// called from here, and the token never reaches the page.
//
// The fake city (mock data only, nothing from the office): 20 buildings in the first spiral lots, mine in lot
// (3,1) with door on south sidewalk (where I spawn, as the server does), 5 people walking around blocks and one
// sitting on a park bench, one building changing every 3 s and `afk` after 60 s without walking; `?perf=N` fills N lots.
// Visit (Phase 4): `enter` at the door (up to 3 tiles, like the server; my building from anywhere) responds with
// sample interior (shared/world/visit-sample.ts: live, muted, or off, depending on building), a
// `building.patch` every 3 s (agents changing status) and visitor count; closed to visits, `closed`;
// far, `too_far`. Inside, nothing from the street descends; `leave` responds with `pos` at the door and areas again.
// Light social (Phase 5), with server rules: like up to 4 steps from door (never on mine), stamp and knock up to
// 2 (like and stamp also from inside building), one stamp per building per day (with `stamped`, like `blocked_ok` and
// `reported` for blocking and reporting), bots greeting each other (and replying to whoever greets them), blocking removes
// person from the street, "Go to HB-XXXX" and random building, city goal at 80 %, and with `celebrate()` (test button
// for `?fireworks=1`), fireworks.
import type { WorldSceneCommand, WorldSceneMe, WorldSceneMessage, WorldSceneSnapshot } from '../../../shared/world/api';
import { WORLD_SCENE_LIMITS, WORLD_SCENE_MESSAGES } from '../../../shared/world/api';
import { flattenAppearance } from '../../../shared/world/appearance-flat';
import { mulberry32 } from '../../../shared/hash';
import {
  BLOCK_TILES,
  FOUNTAIN,
  PLAZA,
  blockAt,
  blockOf,
  blockOrigin,
  chunkId,
  chunkOf,
  isWalkable,
  lotDoor,
  lotSpiral,
  spawnPoint,
  type CityPoint,
} from '../../../shared/world/city';
import type {
  CityGoal,
  Direction,
  GreetingId,
  WorldBuildingDetail,
  IntroId,
  TokenBand,
  TraitId,
  WorldBuildingPublic,
  WorldPlayerPublic,
  WorldPosition,
  WorldTheme,
} from '../../../shared/world/protocol';
import { GREETING_IDS } from '../../../shared/world/protocol';
import { reduceSceneBatch } from '../../../shared/world/scene';
import { sampleBuildingDetail } from '../../../shared/world/visit-sample';
import { reconnectDelay, type EventSourceLike } from './store';
import { FAKE_SUMMARY } from './world';

export type { WorldSceneCommand, WorldSceneMessage, WorldSceneSnapshot } from '../../../shared/world/api';

/** connecting: opening (or browser retrying); open: snapshot received; retrying: waiting to reopen. */
export type WorldStreamStatus = 'connecting' | 'open' | 'retrying' | 'closed';

export type WorldStreamEvent =
  | { type: 'snapshot'; snapshot: WorldSceneSnapshot }
  | { type: 'message'; msg: WorldSceneMessage }
  | { type: 'status'; status: WorldStreamStatus }
  /** A command batch rejected by local server (`no_stream`, `not_connected`, `invalid`...). */
  | { type: 'error'; code: string };

export interface WorldStream {
  on(listener: (ev: WorldStreamEvent) => void): () => void;
  send(cmds: WorldSceneCommand[]): void;
  close(): void;
}

/** One batch every 200 ms (local server accepts 5 per second per stream). */
export const CMD_BATCH_MS = 200;
/** Commands queued while stream is not open (except the last move). */
const QUEUE_MAX = WORLD_SCENE_LIMITS.cmdsPerBatch - 1;
/** EventSource.CLOSED (EventSource does not exist in Node test environment). */
const ES_CLOSED = 2;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Merges new commands into queue: latest move replaces previous ones; remainder up to limit (oldest dropped). */
export function enqueueCommands(queue: readonly WorldSceneCommand[], cmds: readonly WorldSceneCommand[]): WorldSceneCommand[] {
  const all = reduceSceneBatch([...queue, ...cmds]);
  const others: WorldSceneCommand[] = all.filter((c) => c.t !== 'move');
  const kept = new Set<WorldSceneCommand>(others.slice(Math.max(0, others.length - QUEUE_MAX)));
  return all.filter((c) => c.t === 'move' || kept.has(c));
}

class Listeners {
  private readonly set = new Set<(ev: WorldStreamEvent) => void>();
  add(cb: (ev: WorldStreamEvent) => void): () => void {
    this.set.add(cb);
    return () => void this.set.delete(cb);
  }
  emit(ev: WorldStreamEvent): void {
    for (const cb of [...this.set]) {
      try {
        cb(ev);
      } catch (err) {
        console.error('[world-stream]', err);
      }
    }
  }
  clear(): void {
    this.set.clear();
  }
}

// ------------------------------------------------------------------------------------------------ o de verdade

export interface HttpWorldStreamOptions {
  eventSource?: (url: string) => EventSourceLike;
  fetch?: typeof fetch;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
  now?: () => number;
  base?: string;
}

export class HttpWorldStream implements WorldStream {
  private readonly listeners = new Listeners();
  private readonly open: (url: string) => EventSourceLike;
  private readonly fetchImpl: typeof fetch;
  private readonly setT: (cb: () => void, ms: number) => unknown;
  private readonly clearT: (t: unknown) => void;
  private readonly now: () => number;
  private readonly base: string;
  private es: EventSourceLike | null = null;
  private stream: string | null = null;
  private queue: WorldSceneCommand[] = [];
  private flushTimer: unknown = null;
  private retryTimer: unknown = null;
  private inflight = false;
  private lastPostAt = -Infinity;
  /** Delay requested by local server (429). */
  private holdUntil = 0;
  private attempts = 0;
  private closed = false;
  private status: WorldStreamStatus = 'connecting';

  constructor(o: HttpWorldStreamOptions = {}) {
    this.open = o.eventSource ?? ((url) => new EventSource(url));
    this.fetchImpl = o.fetch ?? ((input, init) => fetch(input, init));
    this.setT = o.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearT = o.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.now = o.now ?? Date.now;
    this.base = o.base ?? '/api/world';
    this.connect();
  }

  on(listener: (ev: WorldStreamEvent) => void): () => void {
    return this.listeners.add(listener);
  }

  send(cmds: WorldSceneCommand[]): void {
    if (this.closed || !cmds.length) return;
    this.queue = enqueueCommands(this.queue, cmds);
    this.schedule();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.es?.close();
    this.es = null;
    if (this.flushTimer) this.clearT(this.flushTimer);
    if (this.retryTimer) this.clearT(this.retryTimer);
    this.flushTimer = this.retryTimer = null;
    this.queue = [];
    this.setStatus('closed');
    this.listeners.clear();
  }

  private setStatus(s: WorldStreamStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.listeners.emit({ type: 'status', status: s });
  }

  private connect(): void {
    if (this.closed) return;
    this.stream = null;
    let es: EventSourceLike;
    try {
      es = this.open(`${this.base}/stream`);
    } catch {
      return this.retry();
    }
    this.es = es;
    const current = () => this.es === es && !this.closed;
    es.addEventListener('world.snapshot', (ev) => {
      if (!current()) return;
      const snap = parse(ev);
      if (!isObj(snap) || typeof snap.stream !== 'string' || !Array.isArray(snap.chunks) || !Array.isArray(snap.players)) return;
      this.stream = snap.stream;
      this.attempts = 0;
      this.setStatus('open');
      this.listeners.emit({ type: 'snapshot', snapshot: snap as unknown as WorldSceneSnapshot });
      this.schedule();
    });
    es.addEventListener('world', (ev) => {
      if (!current()) return;
      const msg = parse(ev);
      if (!isObj(msg) || !(WORLD_SCENE_MESSAGES as readonly unknown[]).includes(msg.t)) return;
      this.listeners.emit({ type: 'message', msg: msg as unknown as WorldSceneMessage });
    });
    es.addEventListener('error', () => {
      if (!current()) return;
      // CONNECTING: browser retries automatically (and server sends a new snapshot, with another stream id).
      // CLOSED: gave up (429, 403, 409...): reconnection is handled here, with increasing backoff.
      this.stream = null;
      if (es.readyState === ES_CLOSED) {
        es.close();
        this.es = null;
        this.retry();
      } else {
        this.setStatus('connecting');
      }
    });
  }

  private retry(): void {
    if (this.closed || this.retryTimer) return;
    this.setStatus('retrying');
    const delay = reconnectDelay(this.attempts++);
    this.retryTimer = this.setT(() => {
      this.retryTimer = null;
      this.setStatus('connecting');
      this.connect();
    }, delay);
  }

  /** One batch every CMD_BATCH_MS, one at a time, only when stream is open. */
  private schedule(): void {
    if (this.closed || this.flushTimer || this.inflight || !this.queue.length || !this.stream) return;
    const wait = Math.max(0, this.lastPostAt + CMD_BATCH_MS - this.now(), this.holdUntil - this.now());
    this.flushTimer = this.setT(() => {
      this.flushTimer = null;
      void this.flush();
    }, wait);
  }

  private async flush(): Promise<void> {
    const stream = this.stream;
    if (this.closed || !stream || !this.queue.length) return;
    const cmds = this.queue;
    this.queue = [];
    this.inflight = true;
    this.lastPostAt = this.now();
    let status = 0;
    let code = 'offline';
    let retryAfter = 1;
    try {
      const res = await this.fetchImpl(`${this.base}/cmd`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stream, cmds }),
      });
      status = res.status;
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: unknown; retryAfter?: unknown } } | null;
        if (typeof body?.error?.code === 'string') code = body.error.code;
        if (typeof body?.error?.retryAfter === 'number') retryAfter = body.error.retryAfter;
      }
    } catch {
      status = 0;
    }
    this.inflight = false;
    if (this.closed) return;
    if (status === 429 && code === 'rate_limited') {
      // Returns to queue (newest move, if any, takes precedence) and waits as requested by server.
      this.queue = enqueueCommands(cmds, this.queue);
      this.holdUntil = this.now() + retryAfter * 1000;
    } else if (status < 200 || status >= 300) {
      this.listeners.emit({ type: 'error', code });
    }
    this.schedule();
  }
}

function parse(ev: Event): unknown {
  try {
    return JSON.parse(String((ev as MessageEvent).data));
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------------------------------------ o de mentira

/** Fake city (demo mode, screenshots, and tests): same events, without server. Everything runs off provided clock. */
export interface FakeWorldStreamOptions {
  now?: () => number;
  /** Advances automatically (one step every 200 ms) and delivers snapshot on next microtask. Default: true. */
  autoplay?: boolean;
  /** How many buildings in initial spiral lots (default 20; `?perf=N` benchmarks hundreds on screen; ceiling 2000). */
  buildings?: number;
  /**
   * Last position between consecutive streams on the same page (as server persists on `view.off` or
   * disconnect): closing and reopening city spawns where user was. Without it, spawns at building door.
   */
  memory?: FakeStreamMemory;
}

/** What the fake retains across streams on the same page (`FakeWorldStreamOptions.memory`). */
export interface FakeStreamMemory {
  pos?: WorldPosition;
}

const DISTRICT = 'centro';
/** Without `move` for this duration, fake sends `afk` (like the server). */
const FAKE_AFK_MS = 60_000;
/** Server accepts `enter` up to this distance in front of door (2 tiles + 1 tolerance). */
const FAKE_ENTER_MAX = 3;
/**
 * Statuses that sample interior agents cycle through, one patch every 3 s (by patch index, modulo 4; the
 * 4th of each cycle only updates visitors): sample status, Beatriz replies, Thiago and Larissa return to work.
 */
const FAKE_STATUS_CYCLE: ReadonlyArray<Readonly<Record<string, WorldBuildingDetail['floors'][number]['agents'][number]['status']>>> = [
  {},
  { Beatriz: 'waiting', Larissa: 'idle', Thiago: 'shell' },
  { Beatriz: 'working', Larissa: 'idle', Thiago: 'shell' },
  { Beatriz: 'working', Larissa: 'working', Thiago: 'working' },
];

/** Me in the fake city: sample account character from FakeWorldApi (net/world.ts), same as in Settings. */
export const FAKE_ME: WorldSceneMe = {
  id: 'p_voce',
  name: 'Pixel Dev',
  look: 'f',
  parts: {
    skin: '#d69f78', hair: '#2b2530', hairStyle: 'bob', eyes: '#2f5f9e', top: '#4a86d8', topAccent: '#f4f4f0',
    topStyle: 'hoodie', bottom: '#2c2c35', bottomStyle: 'pants', shoes: '#ececec', accessory: 'glasses',
    accessoryColor: '#2b2b33', facialHair: 'none',
  },
  traits: ['cafeina', 'games'],
  intro: 'night_owl',
  country: 'BR',
  buildingId: 'p_voce',
};
/** My building is the 4th spiral lot: (3,1), with door on south sidewalk of block (1,0). */
const MY_LOT_INDEX = 3;
/** My building code in the fake city (same as FakeWorldApi). */
export const FAKE_MY_CODE = 'HB-4F2K';
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Deterministic mock code for each fake city lot ("HB-" + 4 unambiguous alphabet chars). */
export function fakeBuildingCode(i: number): string {
  let v = (Math.imul(i + 7, 2654435761) >>> 0) % CODE_ALPHABET.length ** 4;
  let out = '';
  for (let k = 0; k < 4; k++) {
    out = CODE_ALPHABET[v % CODE_ALPHABET.length] + out;
    v = Math.floor(v / CODE_ALPHABET.length);
  }
  const code = `HB-${out}`;
  return code === FAKE_MY_CODE ? 'HB-7777' : code;
}

/** Building code as entered, in canonical format (or null), matching world server behavior. */
function normalizeCode(raw: string): string | null {
  const s = raw.trim().toUpperCase().replace(/[\s_]+/g, '');
  const body = s.startsWith('HB-') ? s.slice(3) : s.startsWith('HB') && s.length === 6 ? s.slice(2) : s;
  return /^[2-9A-HJKMNP-TV-Z]{4}$/.test(body) ? `HB-${body}` : null;
}

/** A response that matches the greeting (bots respond). */
const REPLY: Readonly<Record<GreetingId, GreetingId>> = {
  hello: 'nice_to_meet', wave: 'hello', nice_building: 'thanks', congrats: 'thanks', clap: 'thanks', good_luck: 'thanks',
  coffee: 'coffee', bye: 'bye', thanks: 'clap', nice_to_meet: 'wave',
};

/** Mock owners (fictional player names). */
const OWNERS: ReadonlyArray<readonly [string, string | undefined]> = [
  ['Ana Pixel', 'BR'], ['Bruno Byte', 'PT'], ['Camille Code', 'FR'], ['Diego Deploy', 'MX'], ['Emma Stack', 'US'],
  ['Felipe Fork', 'AR'], ['Gabi Git', 'BR'], ['Hiro Hash', 'JP'], ['Inês Infra', 'ES'], ['Jonas Json', 'DE'],
  ['Kai Kernel', 'CA'], ['Lia Lambda', 'IT'], ['Marco Merge', 'CL'], ['Nina Node', 'CO'], ['Oscar Ops', 'GB'],
  ['Priya Patch', 'IN'], ['Quim Query', undefined], ['Rosa Regex', 'BR'], ['Sami Shell', 'KR'], ['Téo Test', 'PT'],
];
const FLOORS = [2, 6, 13, 4, 9, 3, 16, 5, 0, 11, 4, 7, 2, 20, 8, 3, 12, 1, 6, 10] as const;
const THEMES: readonly WorldTheme[] = ['none', 'halloween', 'none', 'christmas', 'none', 'halloween'];
const TRAITS: readonly (readonly TraitId[])[] = [['games', 'piadas'], ['leitura', 'calma'], ['competicao', 'esporte', 'cafeina'], ['series', 'fofoca'], ['esporte', 'cafeina'], ['timidez', 'leitura']];
const INTROS: readonly IntroId[] = ['coffee', 'tabs', 'pixel_art', 'cats', 'ship_fast', 'music'];

/**
 * The 5 roaming players (block circled, direction, speed in tiles/s, start position) and which
 * building each owns (spiral index; player id matches building id). The 6th sits on a park bench.
 */
const WALKERS: ReadonlyArray<{ name: string; look: 'f' | 'm'; block: CityPoint; cw: boolean; speed: number; phase: number; owns?: number }> = [
  { name: 'Luna Loop', look: 'f', block: { x: 1, y: 0 }, cw: true, speed: 3.0, phase: 12, owns: 1 },
  { name: 'Max Merge', look: 'm', block: { x: 1, y: 0 }, cw: false, speed: 3.2, phase: 70 },
  { name: 'Zoe Zip', look: 'f', block: { x: 0, y: 0 }, cw: true, speed: 2.9, phase: 40, owns: 7 },
  { name: 'Rafa Runtime', look: 'm', block: { x: 1, y: 1 }, cw: false, speed: 3.1, phase: 110 },
  { name: 'Yuki Yarn', look: 'f', block: { x: 0, y: 1 }, cw: true, speed: 5.6, phase: 25, owns: 13 },
];
const SITTER = { name: 'Ravi Repo', look: 'm' as const };
/** Country code for each player (4th does not display). */
const COUNTRY_OF_WALKER: readonly string[] = ['BR', 'US', 'FR', 'ES', 'JP', 'IN'];

/** Center of sidewalk around a block (2 tiles wide: center is the seam between them). */
function sidewalkLoop(block: CityPoint): { x0: number; y0: number; x1: number; y1: number; length: number } {
  const o = blockOrigin(block);
  const x0 = o.x - 1;
  const y0 = o.y - 1;
  const x1 = o.x + BLOCK_TILES.w + 1;
  const y1 = o.y + BLOCK_TILES.h + 1;
  return { x0, y0, x1, y1, length: 2 * (x1 - x0 + (y1 - y0)) };
}

/** Position of entity walking `dist` tiles around the loop (clockwise: east, south, west, north). */
export function loopPosition(block: CityPoint, dist: number, cw: boolean): WorldPosition {
  const l = sidewalkLoop(block);
  const w = l.x1 - l.x0;
  const h = l.y1 - l.y0;
  let d = ((cw ? dist : -dist) % l.length + l.length) % l.length;
  const round = (v: number) => Math.round(v * 100) / 100;
  const at = (x: number, y: number, dirCw: Direction, dirCcw: Direction): WorldPosition => ({ x: round(x), y: round(y), dir: cw ? dirCw : dirCcw, moving: true });
  if (d < w) return at(l.x0 + d, l.y0, 'e', 'w');
  d -= w;
  if (d < h) return at(l.x1, l.y0 + d, 's', 'n');
  d -= h;
  if (d < w) return at(l.x1 - d, l.y1, 'w', 'e');
  d -= w;
  return at(l.x0, l.y1 - d, 'n', 's');
}

/** Seat of bench south of fountain, on the right (tiles): where the 6th player sits. */
export function fakeBenchSeat(): CityPoint {
  const o = blockOrigin(PLAZA);
  return { x: o.x + FOUNTAIN.x + FOUNTAIN.w / 2 + 5, y: o.y + FOUNTAIN.y + FOUNTAIN.h + 2 + 0.85 };
}

/** Spawn point: on sidewalk in front of my building door (as server does for building owners). */
export function fakeMyDoor(): CityPoint {
  return lotDoor(fakeLots(MY_LOT_INDEX + 1)[MY_LOT_INDEX]!).front;
}

const chunkOfPos = (x: number, y: number) => chunkId(DISTRICT, chunkOf(blockAt(x, y)));

/** Fake city weekly goal: first milestone (10k agent hours), at 80 %, until next Monday (UTC). */
export function fakeGoal(now: number): CityGoal {
  const d = new Date(now);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * 86_400_000;
  return { id: `${new Date(monday).toISOString().slice(0, 10)}:agent_hours_10k`, label: 'agent_hours_10k', target: 10_000, progress: 8_000, until: monday + 7 * 86_400_000 };
}

function fakeLots(n: number): CityPoint[] {
  const lots: CityPoint[] = [];
  for (const lot of lotSpiral()) {
    if (lots.length >= n) break;
    lots.push(lot);
  }
  return lots;
}

/** Fake city buildings across first `n` spiral lots (mine in 4th); fully mock and deterministic. */
export function fakeCityBuildings(n = 20): WorldBuildingPublic[] {
  const rng = mulberry32(0xc17c17);
  const count = Math.max(1, Math.min(2000, Math.floor(n)));
  const owners = new Map<number, number>();
  WALKERS.forEach((w, k) => w.owns !== undefined && owners.set(w.owns, k));
  return fakeLots(count).map((lot, i) => {
    const mine = i === MY_LOT_INDEX;
    const [name, country] = OWNERS[i % OWNERS.length]!;
    const walker = owners.get(i);
    const floors = mine ? 4 : FLOORS[i % FLOORS.length]!;
    const total = Math.max(1, Math.round(floors * (1 + rng() * 1.5)));
    const working = Math.round(total * rng());
    const waiting = Math.min(total - working, rng() < 0.4 ? 1 + Math.floor(rng() * 2) : 0);
    const away = !mine && (i % 7 === 5 || i % 11 === 9);
    const discreet = !mine && i % 9 === 7;
    const id = mine ? FAKE_ME.id : walker !== undefined ? `p_${walker + 1}` : `b_${i.toString(36).padStart(3, '0')}`;
    const owner = mine
      ? { id, name: FAKE_ME.name, country: FAKE_ME.country }
      : walker !== undefined
        ? { id, name: WALKERS[walker]!.name, country: COUNTRY_OF_WALKER[walker] }
        : { id, name: count > OWNERS.length ? `${name} ${Math.floor(i / OWNERS.length) + 1}` : name, ...(country ? { country } : {}) };
    const b: WorldBuildingPublic = {
      id,
      lot: { district: DISTRICT, x: lot.x, y: lot.y },
      owner,
      state: away ? 'away' : 'online',
      theme: mine ? 'halloween' : THEMES[i % THEMES.length]!,
      floors,
      rev: 1,
      likes: Math.floor(rng() * 240),
      sinceMonth: `2026-${String(8 + (i % 3)).padStart(2, '0')}`,
    };
    if (!discreet) b.agents = { total, working, waiting, idle: total - working - waiting };
    if (i % 4 !== 1) b.tokens = { day: (i % 5) as TokenBand, week: Math.min(5, (i % 5) + 1) as TokenBand };
    if (i % 8 === 6) b.closed = true;
    // Phase 5: building code, knock acceptance, and an "unverified" building (Phase 6)
    b.code = mine ? FAKE_MY_CODE : fakeBuildingCode(i);
    if (i % 3 === 1 || i === 4) b.knocks = true;
    if (i === 10) (b as WorldBuildingPublic & { unverified?: true }).unverified = true;
    return b;
  });
}

export class FakeWorldStream implements WorldStream {
  private readonly listeners = new Listeners();
  private readonly now: () => number;
  private readonly start: number;
  private readonly buildings: WorldBuildingPublic[];
  private readonly revs = new Map<string, number>();
  private readonly walkers: WorldPlayerPublic[];
  private me: WorldPosition;
  private viewing = true;
  private closed = false;
  private ticks = 0;
  private lastMoveAt: number;
  private afkSent = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Command responses: sent on next step, simulating round-trip. */
  private pending: WorldSceneMessage[] = [];
  /** Inside a building (visit): interior and its `rev`. */
  private inside: { id: string; rev: number; detail: WorldBuildingDetail; patches: number } | null = null;
  /** Delayed messages (bot replies to greetings). */
  private later: Array<{ at: number; msg: WorldSceneMessage }> = [];
  /** Social random generators (deterministic, like rest of fake city). */
  private readonly social = mulberry32(0x50c1a1);
  private readonly memory?: FakeStreamMemory;
  /** Owner saw "While you were away" (`summary.seen`): snapshot no longer includes it. */
  private summarySeen = false;
  /** Quem eu bloqueei (some da rua). */
  private readonly hidden = new Set<string>();
  /** Today's stamps (one per building). */
  private readonly stamped = new Set<string>();
  /** Last time each bot greeted me. */
  private readonly greetedMe = new Map<string, number>();
  /** Weekly goal (agent hours): starts at 80 % of first milestone. */
  private goal: CityGoal;

  constructor(o: FakeWorldStreamOptions = {}) {
    this.now = o.now ?? Date.now;
    this.start = this.now();
    this.lastMoveAt = this.start;
    this.buildings = fakeCityBuildings(o.buildings ?? 20);
    for (const b of this.buildings) this.revs.set(this.chunkOfBuilding(b), 1);
    const mine = this.buildings.find((b) => b.id === FAKE_ME.id);
    const door = mine ? lotDoor(mine.lot).front : spawnPoint();
    this.memory = o.memory;
    // back to city: spawns where previously located (last position saved in `view.off` or closure)
    const last = o.memory?.pos;
    this.me = last ? { x: last.x, y: last.y, dir: last.dir, moving: false } : { x: door.x, y: door.y, dir: 's', moving: false };
    this.goal = fakeGoal(this.start);
    const prng = mulberry32(0x9e1a);
    const player = (k: number, name: string, look: 'f' | 'm', pos: WorldPosition): WorldPlayerPublic => {
      const owns = WALKERS[k]?.owns;
      const id = `p_${k + 1}`;
      return {
        id,
        name,
        ...(k === 3 ? {} : { country: COUNTRY_OF_WALKER[k]! }),
        look,
        parts: flattenAppearance(1_000 + k * 97, undefined, look),
        traits: [...TRAITS[k % TRAITS.length]!],
        intro: INTROS[k % INTROS.length]!,
        ...(owns !== undefined && owns < this.buildings.length ? { buildingId: id } : {}),
        likesReceived: Math.floor(prng() * 60),
        pos,
        where: 'street',
      };
    };
    this.walkers = WALKERS.map((w, k) => player(k, w.name, w.look, loopPosition(w.block, w.phase, w.cw)));
    // seated on bench south of fountain: stationary atop bench, scene renders seated
    const seat = fakeBenchSeat();
    this.walkers.push(player(WALKERS.length, SITTER.name, SITTER.look, { x: seat.x, y: seat.y, dir: 's', moving: false }));
    if (o.autoplay !== false) {
      this.timer = setInterval(() => this.tick(), CMD_BATCH_MS);
    }
  }

  on(listener: (ev: WorldStreamEvent) => void): () => void {
    const off = this.listeners.add(listener);
    // Like real server: snapshot arrives after opening (never inside `on`).
    void Promise.resolve().then(() => {
      if (this.closed) return;
      listener({ type: 'status', status: 'open' });
      listener({ type: 'snapshot', snapshot: this.snapshot() });
    });
    return off;
  }

  /** Entire state, matching local server `world.snapshot`. */
  snapshot(): WorldSceneSnapshot {
    const byChunk = new Map<string, WorldBuildingPublic[]>();
    for (const b of this.buildings) {
      const c = this.chunkOfBuilding(b);
      if (!byChunk.has(c)) byChunk.set(c, []);
      byChunk.get(c)!.push(b);
    }
    return structuredClone({
      stream: 'fake',
      connected: true,
      viewing: this.viewing,
      district: DISTRICT,
      me: FAKE_ME,
      pos: this.me,
      afk: this.afkSent,
      chunks: this.viewing ? [...byChunk.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([chunk, buildings]) => ({ chunk, rev: this.revs.get(chunk) ?? 1, buildings })) : [],
      players: this.viewing && !this.inside ? this.walkers.filter((p) => !this.hidden.has(p.id)) : [],
      minimap: this.viewing ? this.minimap() : null,
      ...(this.inside ? { inside: { id: this.inside.id, rev: this.inside.rev, detail: this.inside.detail } } : {}),
      ...(this.viewing ? { city: this.cityStatus() } : {}),
      likesToday: 3,
      // "While you were away" summary sent to owner on connect (same as FakeWorldApi)
      ...(this.summarySeen ? {} : { summary: structuredClone(FAKE_SUMMARY) }),
    });
  }

  /** City (↓ `city`): illuminated buildings, weekly goal, and token banner. */
  private cityStatus(): { lit: number; goal: CityGoal; tokensBand: TokenBand } {
    return { lit: this.buildings.filter((b) => b.state === 'online').length, goal: { ...this.goal }, tokensBand: 4 };
  }

  /** City reached goal (test button for `?fireworks=1`): fireworks and next goal. */
  celebrate(): void {
    if (this.closed) return;
    const reached = this.goal;
    this.emit({ t: 'city.fireworks', goalId: reached.id });
    const next = reached.label === 'agent_hours_10k' ? 'agent_hours_50k' : 'agent_hours_100k';
    const target = next === 'agent_hours_50k' ? 50_000 : 100_000;
    this.goal = { id: reached.id.replace(reached.label, next), label: next, target, progress: Math.max(reached.target, reached.progress), until: reached.until };
    this.emit({ t: 'city', ...this.cityStatus() });
  }

  send(cmds: WorldSceneCommand[]): void {
    if (this.closed) return;
    for (const c of reduceSceneBatch(cmds)) this.command(c);
  }

  close(): void {
    if (this.closed) return;
    this.remember();
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.emit({ type: 'status', status: 'closed' });
    this.listeners.clear();
  }

  /** Saves last position (stopped) for next `view`, on this stream or subsequent on same page. */
  private remember(): void {
    if (this.memory) this.memory.pos = { x: this.me.x, y: this.me.y, dir: this.me.dir, moving: false };
  }

  /** One step (200 ms): pending responses, the 5 walking, building update every 3 s, and `afk`. */
  tick(): void {
    if (this.closed) return;
    this.ticks++;
    const out = this.pending;
    this.pending = [];
    for (const m of out) this.emit(m);
    if (!this.viewing) return;
    // inside a building, nothing from street streams down: only interior updating every 3 s
    if (this.inside) {
      if (this.ticks % 15 === 0) this.patchInside();
      return;
    }
    const now = this.now();
    const due = this.later.filter((l) => l.at <= now);
    if (due.length) {
      this.later = this.later.filter((l) => l.at > now);
      for (const l of due) this.emit(l.msg);
    }
    const t = (now - this.start) / 1000;
    const byChunk = new Map<string, Array<{ id: string; pos: WorldPosition }>>();
    WALKERS.forEach((w, i) => {
      const p = this.walkers[i]!;
      p.pos = loopPosition(w.block, w.phase + w.speed * t, w.cw);
      if (this.hidden.has(p.id)) return;
      const c = chunkOfPos(p.pos.x, p.pos.y);
      if (!byChunk.has(c)) byChunk.set(c, []);
      byChunk.get(c)!.push({ id: p.id, pos: { ...p.pos } });
    });
    for (const [chunk, players] of byChunk) this.emit({ t: 'players', chunk, players });
    if (this.ticks % 15 === 0) this.changeBuilding(this.ticks / 15);
    if (this.ticks % 300 === 0) this.emit({ t: 'minimap', blocks: this.minimap() });
    if (this.ticks % 300 === 0) {
      // goal advances a bit each minute (agents working across entire city)
      this.goal = { ...this.goal, progress: Math.min(this.goal.target - 1, this.goal.progress + 7) };
      this.emit({ t: 'city', ...this.cityStatus() });
    }
    if (this.ticks % 25 === 0) this.botsGreet(now);
    if (!this.afkSent && now - this.lastMoveAt >= FAKE_AFK_MS) {
      this.afkSent = true;
      this.emit({ t: 'afk' });
    }
  }

  /**
   * Bots greet each other (two who see each other, respondent replies in 1.6 s) and occasionally greet whoever is near
   * them (me), at most once every 30 s each.
   */
  private botsGreet(now: number): void {
    const bots = this.walkers.filter((p) => !this.hidden.has(p.id));
    if (bots.length >= 2) {
      const a = bots[Math.floor(this.social() * bots.length)]!;
      const others = bots.filter((p) => p !== a).sort((x, y) => Math.hypot(x.pos.x - a.pos.x, x.pos.y - a.pos.y) - Math.hypot(y.pos.x - a.pos.x, y.pos.y - a.pos.y));
      const b = others[0]!;
      const g = GREETING_IDS[Math.floor(this.social() * GREETING_IDS.length)]!;
      this.emit({ t: 'greeting', from: a.id, to: b.id, greetingId: g, until: now + 5_000 });
      this.later.push({ at: now + 1_600, msg: { t: 'greeting', from: b.id, to: a.id, greetingId: REPLY[g], until: now + 6_600 } });
    }
    for (const p of bots) {
      if (Math.hypot(p.pos.x - this.me.x, p.pos.y - this.me.y) > 7 || now - (this.greetedMe.get(p.id) ?? -Infinity) < 30_000) continue;
      if (this.social() < 0.5) continue;
      this.greetedMe.set(p.id, now);
      const g: GreetingId = this.social() < 0.5 ? 'hello' : 'wave';
      this.emit({ t: 'greeting', from: p.id, to: FAKE_ME.id, greetingId: g, until: now + 5_000 });
      break;
    }
  }

  /** Agents start/stop work and likes arrive at a building (area.patch with `rev` + 1). */
  private changeBuilding(n: number): void {
    const b = this.buildings[(n * 7) % this.buildings.length]!;
    if (!b.agents || b.state !== 'online') return;
    // occasionally all stop at once (end of shift: confetti on facade)
    const working = n % 4 === 0 && b.agents.working > 0 ? 0 : (b.agents.working + 1) % (b.agents.total + 1);
    const waiting = Math.min(b.agents.total - working, n % 2);
    b.agents = { total: b.agents.total, working, waiting, idle: b.agents.total - working - waiting };
    if (n % 3 === 0) b.likes++;
    b.rev++;
    const chunk = this.chunkOfBuilding(b);
    const rev = (this.revs.get(chunk) ?? 1) + 1;
    this.revs.set(chunk, rev);
    this.emit({ t: 'area.patch', chunk, rev, changes: [{ id: b.id, agents: { ...b.agents }, likes: b.likes, rev: b.rev }] });
  }

  private command(c: WorldSceneCommand): void {
    switch (c.t) {
      case 'move': {
        // Like server: walkable destination near previous one (200 ms run step is ~1.2 tiles).
        const far = Math.hypot(c.x - this.me.x, c.y - this.me.y) > 6;
        if (!isWalkable(c.x, c.y, () => true) || far) {
          this.pending.push({ t: 'pos', x: this.me.x, y: this.me.y });
          return;
        }
        const changed = c.x !== this.me.x || c.y !== this.me.y || c.dir !== this.me.dir || c.moving !== this.me.moving;
        this.me = { x: c.x, y: c.y, dir: c.dir, moving: c.moving };
        if (changed) {
          this.lastMoveAt = this.now();
          this.afkSent = false;
        }
        return;
      }
      case 'profile': {
        const p = this.walkers.find((w) => w.id === c.playerId);
        this.pending.push(p ? { t: 'profile', player: structuredClone(p) } : { t: 'notice', level: 'info', text: 'not_found' });
        return;
      }
      case 'like':
      case 'unlike': {
        // like server: up to 4 steps from door, never on own building
        const b = this.near(c.buildingId, 4);
        if (typeof b === 'string') return void this.pending.push({ t: 'notice', level: 'warn', text: b });
        const liked = c.t === 'like';
        if (!!b.likedByMe !== liked) b.likes += liked ? 1 : -1;
        b.likedByMe = liked;
        this.pending.push({ t: 'like.update', buildingId: b.id, likes: b.likes, likedByMe: liked });
        // from inside: interior as well (like `building` in server's next `building.patch`)
        if (this.inside?.id === b.id) Object.assign(this.inside.detail.building, { likes: b.likes, likedByMe: liked });
        return;
      }
      case 'greet': {
        const to = this.walkers.find((p) => p.id === c.playerId && !this.hidden.has(p.id));
        if (!to) return void this.pending.push({ t: 'notice', level: 'info', text: 'not_found' });
        const now = this.now();
        this.pending.push({ t: 'greeting', from: FAKE_ME.id, to: c.playerId, greetingId: c.greetingId as GreetingId, until: now + 5_000 });
        // o bot responde
        this.later.push({ at: now + 1_200, msg: { t: 'greeting', from: c.playerId, to: FAKE_ME.id, greetingId: REPLY[c.greetingId as GreetingId] ?? 'wave', until: now + 6_200 } });
        return;
      }
      case 'stamp': {
        const b = this.near(c.buildingId, 2);
        if (typeof b === 'string') return void this.pending.push({ t: 'notice', level: 'warn', text: b });
        if (this.stamped.has(b.id)) return void this.pending.push({ t: 'notice', level: 'info', text: 'already_done' });
        this.stamped.add(b.id);
        this.pending.push({ t: 'notice', level: 'info', text: 'stamped' });
        return;
      }
      case 'knock': {
        // knocker never knows if owner is there: no reply, only distant rejection
        const b = this.near(c.buildingId, 2);
        if (typeof b === 'string') this.pending.push({ t: 'notice', level: 'warn', text: b });
        return;
      }
      case 'teleport': {
        const code = c.code === undefined ? null : normalizeCode(c.code);
        let target: WorldBuildingPublic | undefined;
        if (c.code !== undefined) target = code ? this.buildings.find((b) => b.code === code && !this.hidden.has(b.id)) : undefined;
        else {
          const lit = this.buildings.filter((b) => b.state === 'online' && b.id !== FAKE_ME.id && !this.hidden.has(b.id));
          target = lit[Math.floor(this.social() * lit.length)];
        }
        if (!target) return void this.pending.push({ t: 'notice', level: 'info', text: 'not_found' });
        const d = lotDoor(target.lot);
        this.me = { x: d.front.x, y: d.front.y, dir: d.side, moving: false };
        this.lastMoveAt = this.now();
        this.afkSent = false;
        this.pending.push({ t: 'pos', x: d.front.x, y: d.front.y });
        // area around new location (scene only retains 3x3 chunks around player)
        for (const ch of this.snapshot().chunks) this.pending.push({ t: 'area', chunk: ch.chunk, rev: ch.rev, buildings: ch.buildings });
        return;
      }
      case 'block': {
        const p = this.walkers.find((x) => x.id === c.playerId);
        if (!p) return void this.pending.push({ t: 'notice', level: 'info', text: 'not_found' });
        this.hidden.add(p.id);
        this.pending.push({ t: 'player.leave', id: p.id }, { t: 'notice', level: 'info', text: 'blocked_ok' });
        return;
      }
      case 'unblock': {
        const p = this.walkers.find((x) => x.id === c.playerId);
        if (!p || !this.hidden.delete(p.id)) return;
        this.pending.push({ t: 'player.join', player: structuredClone(p) });
        return;
      }
      case 'resync':
        for (const ch of this.snapshot().chunks) {
          if (c.chunk === undefined || ch.chunk === c.chunk) this.pending.push({ t: 'area', chunk: ch.chunk, rev: ch.rev, buildings: ch.buildings });
        }
        return;
      case 'view':
        this.viewing = true;
        void Promise.resolve().then(() => !this.closed && this.listeners.emit({ type: 'snapshot', snapshot: this.snapshot() }));
        return;
      case 'view.off':
        this.remember();
        this.viewing = false;
        this.inside = null;
        return;
      case 'enter':
        this.enter(c.buildingId);
        return;
      case 'leave': {
        const b = this.inside ? this.buildings.find((x) => x.id === this.inside!.id) : undefined;
        this.inside = null;
        if (b) {
          const d = lotDoor(b.lot);
          this.me = { x: d.front.x, y: d.front.y, dir: d.side === 's' ? 's' : 'n', moving: false };
        }
        this.lastMoveAt = this.now();
        this.pending.push({ t: 'pos', x: this.me.x, y: this.me.y });
        for (const ch of this.snapshot().chunks) this.pending.push({ t: 'area', chunk: ch.chunk, rev: ch.rev, buildings: ch.buildings });
        return;
      }
      default:
        // report: `reported`; summary.seen: nothing returned (summary omitted from snapshot).
        if (c.t === 'report') this.pending.push({ t: 'notice', level: 'info', text: 'reported' });
        if (c.t === 'summary.seen') this.summarySeen = true;
        return;
    }
  }

  /** `enter`: like server (does not exist, far, closed), and sample interior appropriate for building. */
  private enter(id: string): void {
    const b = this.buildings.find((x) => x.id === id);
    if (!b) {
      this.pending.push({ t: 'notice', level: 'info', text: 'not_found' });
      return;
    }
    const mine = b.id === FAKE_ME.id;
    const d = lotDoor(b.lot).front;
    if (!mine && Math.hypot(this.me.x - d.x, this.me.y - d.y) > FAKE_ENTER_MAX) {
      this.pending.push({ t: 'notice', level: 'info', text: 'too_far' });
      return;
    }
    if (!mine && b.closed) {
      this.pending.push({ t: 'notice', level: 'info', text: 'closed' });
      return;
    }
    const mode = b.state === 'away' ? 'away' : b.agents ? 'live' : 'discreet';
    const detail = sampleBuildingDetail(mode);
    const { agents: _agents, ...pub } = b;
    detail.building = { ...pub, ...(detail.building.agents ? { agents: detail.building.agents } : {}), floors: detail.floors.length, ...(mode === 'discreet' ? { discreet: true } : {}) };
    detail.visitors = mine ? 0 : 2; // owner viewing own building does not count
    this.inside = { id: b.id, rev: 1, detail, patches: 0 };
    this.pending.push({ t: 'building', rev: 1, detail: structuredClone(detail) });
  }

  /** Interior changes: agents change status (live) and occasionally someone enters or leaves. */
  private patchInside(): void {
    const ins = this.inside;
    if (!ins) return;
    ins.patches++;
    if (ins.patches % 4 === 0) {
      ins.detail.visitors = ins.detail.visitors >= 3 ? 2 : ins.detail.visitors + 1;
      ins.rev++;
      this.emit({ t: 'building.patch', rev: ins.rev, visitors: ins.detail.visitors });
      return;
    }
    if (ins.detail.building.state !== 'online' || ins.detail.building.discreet) return;
    const next = FAKE_STATUS_CYCLE[ins.patches % FAKE_STATUS_CYCLE.length]!;
    for (const f of ins.detail.floors) for (const a of f.agents) if (next[a.name]) a.status = next[a.name]!;
    ins.rev++;
    this.emit({ t: 'building.patch', rev: ins.rev, floors: structuredClone(ins.detail.floors) });
  }

  /**
   * Building up to `max` steps from door (as server verifies) or building I am in (from inside valid without
   * distance check), or warning: far, own, or none.
   */
  private near(id: string, max: number): WorldBuildingPublic | 'too_far' | 'invalid' | 'not_found' {
    if (id === FAKE_ME.id) return 'invalid';
    const b = this.buildings.find((x) => x.id === id);
    if (!b) return 'not_found';
    if (this.inside?.id === id) return b;
    const f = lotDoor(b.lot).front;
    return Math.hypot(f.x - this.me.x, f.y - this.me.y) <= max + 1e-9 ? b : 'too_far';
  }

  private emit(msg: WorldSceneMessage): void {
    this.listeners.emit({ type: 'message', msg: structuredClone(msg) });
  }

  private chunkOfBuilding(b: WorldBuildingPublic): string {
    return chunkId(DISTRICT, chunkOf(blockOf(b.lot)));
  }

  private minimap(): Array<{ x: number; y: number; lit: number }> {
    const blocks = new Map<string, { x: number; y: number; lit: number }>();
    for (const b of this.buildings) {
      const bl = blockOf(b.lot);
      const key = `${bl.x},${bl.y}`;
      if (!blocks.has(key)) blocks.set(key, { x: bl.x, y: bl.y, lit: 0 });
      if (b.state === 'online') blocks.get(key)!.lit++;
    }
    return [...blocks.values()].sort((a, b) => a.y - b.y || a.x - b.x);
  }
}

// ------------------------------------------------------------------------------------------------ factory

/** Scene stream: in demo mode, fake city; otherwise, local server. */
export function createWorldStream(opts: { mock: boolean } & HttpWorldStreamOptions & FakeWorldStreamOptions): WorldStream {
  return opts.mock ? new FakeWorldStream(opts) : new HttpWorldStream(opts);
}
