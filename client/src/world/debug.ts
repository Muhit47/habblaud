// World debug API (console: `habblaud.world.debug`), used in visual tests to
// simulate scenarios: mock sessions joining/leaving, rooms closing, time of day, camera, and
// shell job waiting (running shells, aging wait time, finishing with success/failure).
import type { Activity, AgentInfo, AgentStatus, RoomInfo, ShellJob } from '../../../shared/types';
import { SPECIAL, type ShellOutcome } from '../../../shared/activity';
import { hash32 } from '../../../shared/hash';
import { TILE } from '../art/api';
import type { Camera } from './camera';
import type { Renderer } from './render/renderer';
import { oldestShell } from './sim/shell';
import type { Sim } from './sim/sim';
import type { GatherKind } from './social/gathering';

/** A shell job for debug scenarios: optional ShellJob fields + relative age. */
export interface ShellJobInput extends Partial<ShellJob> {
  /** How many minutes ago command started (ignored if `startedAt` provided). */
  ageMinutes?: number;
  ageSeconds?: number;
}

export interface SpawnOptions {
  /** Project name (room). Default: a new name; if room exists, reuses it. */
  project?: string;
  name?: string;
  /** Account ID (AccountInfo.id). */
  account?: string;
  status?: AgentStatus;
  /** How many subagents (working) to trigger concurrently. */
  subs?: number;
  /**
   * Starts waiting for shell(s): status 'shell' (or 'working' with `background: false`, a
   * long foreground command). `count` > 1 creates multiple (the "×N" badge on hourglass).
   */
  shell?: { label?: string; command?: string; ageMinutes?: number; count?: number; background?: boolean; kind?: 'shell' | 'monitor' };
}

export interface WorldDebug {
  /** State summary: rooms (phase, light) and characters (mode, step, position). */
  state(): unknown;
  /** Opens a mock session (creates new room if needed). Returns main agent id. */
  spawnSession(opts?: SpawnOptions): string;
  /** Changes status of a mock session (e.g. 'waiting', 'idle') or mock subagent. */
  setStatus(agentId: string, status: AgentStatus, waitingFor?: string): void;
  /** Closes a mock session (agent disappears from snapshot along with subagents). */
  endSession(agentId: string): void;
  /** Simulates closing a real session (walks away; if last one, turns off lights). */
  closeSession(agentId: string): void;
  /** Simulates end of all sessions in a room: all depart and room disappears from snapshot. */
  closeRoom(roomId: string): void;
  /** Reverts simulated closures and removes mock sessions. */
  reset(): void;
  /** Overrides time of day (0–24) for day/night cycle; null restores local time. */
  setHour(hour: number | null): void;
  /** Centers camera at a tile point with optional zoom, without animation. */
  lookAt(tx: number, ty: number, zoom?: number): void;
  /** Centers camera on a room (id or name). */
  lookAtRoom(idOrName: string, zoom?: number): void;
  /** Fast-forwards all behaviors to destination (like returning from hidden tab). */
  fastForward(): void;
  /** Triggers all idle agents to roam immediately. */
  wanderNow(): void;
  /**
   * Starts a gathering immediately with idle/shell-waiting agents (or specified `ids`): all return to table
   * immediately and depart together. Returns participant names or null.
   */
  socialize(kind: GatherKind, ids?: string[]): string[] | null;
  /** Rodas em andamento: tipo, fase, participantes, placar e aposta. */
  gatherings(): unknown;
  /** Soma (ou tira) moedinhas da carteira de um agente. Retorna o saldo. */
  coins(agentId: string, delta: number): number;
  /**
   * Sets shell jobs an agent waits for (mock session or real agent; real stays overlaid
   * until reset()). Any in background -> status 'shell'; foreground only -> 'working';
   * empty list -> 'idle' (if currently in 'shell').
   */
  setShells(agentId: string, jobs: ShellJobInput[]): void;
  /** Ages shells (all sessions with shells, or just one agent) by `minutes` — to test stages. */
  ageShells(minutes: number, agentId?: string): void;
  /**
   * Terminates oldest shell (or all, `opts.all`) of an agent: records 'ShellDone' Activity
   * (error for 'failed'/'killed'), triggering confetti or rain. Without background shells
   * remaining, status becomes `opts.then` (default 'working': agent wakes up with notification).
   */
  finishShell(agentId: string, result?: 'completed' | 'failed' | 'killed', opts?: { all?: boolean; then?: AgentStatus }): void;
  /**
   * Activates celebration (~12 s) or alarm (until cleared with `null`) in a room (id or name), matching GitHub
   * events; `agentId` = responsible agent (star in celebration, "!" bubble in alarm).
   */
  roomEffect(idOrName: string, kind: 'party' | 'alarm' | null, opts?: { text?: string; agentId?: string }): void;
  readonly sim: Sim;
  readonly camera: Camera;
}

const NAMES = ['Lia', 'Otavio', 'Bruna', 'Caio', 'Iara', 'Rui', 'Nina', 'Davi', 'Tais', 'Ivo'];

export function createDebug(sim: Sim, renderer: Renderer, camera: Camera, onCameraMoved: () => void): WorldDebug {
  let seq = 0;
  const now = () => Date.now();
  const reapply = () => sim.reapply(now());

  const freeSlot = (): number => {
    const used = new Set<number>([...sim.rooms.values()].map((r) => r.slot));
    for (const r of sim.injected.rooms) used.add(r.slot);
    let s = 0;
    while (used.has(s)) s++;
    return s;
  };

  const makeAgent = (base: Partial<AgentInfo> & Pick<AgentInfo, 'id' | 'name' | 'roomId' | 'kind' | 'account' | 'sessionId'>): AgentInfo => {
    const t = now();
    return {
      look: seq % 2 ? 'f' : 'm',
      role: base.kind === 'main' ? 'Agente principal' : 'Explore',
      status: 'working',
      recent: [],
      tasks: base.kind === 'main' ? [{ id: '1', title: 'Testar o mundo', status: 'in_progress' }, { id: '2', title: 'Revisar', status: 'pending' }] : [],
      startedAt: t,
      lastEventAt: t,
      statusSince: t,
      stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
      seed: hash32(base.id),
      activity: { id: `dbg-act-${++seq}`, kind: 'edit', icon: '✏️', text: 'Editando world.ts', at: t },
      ...base,
    };
  };

  const makeJobs = (jobs: readonly ShellJobInput[]): ShellJob[] =>
    jobs.map((j) => ({
      id: j.id ?? `bdbg${(++seq).toString(36)}`,
      label: j.label ?? 'Run test suite',
      command: j.command ?? 'npm test',
      startedAt: j.startedAt ?? now() - (j.ageMinutes ?? 0) * 60_000 - (j.ageSeconds ?? 0) * 1000,
      background: j.background ?? true,
      kind: j.kind ?? 'shell',
    }));

  /** Status consistent with shells: background -> 'shell'; foreground only -> 'working'. */
  const statusFor = (cur: AgentStatus, shells: readonly ShellJob[]): AgentStatus => {
    if (cur === 'waiting' || cur === 'offline' || cur === 'done') return cur;
    if (shells.some((j) => j.background)) return 'shell';
    if (shells.length) return 'working';
    return cur === 'shell' ? 'idle' : cur;
  };

  /**
   * Edits an agent as a new snapshot would (shallow clone): mock sessions directly;
   * real agents via overlay (sim.agentPatches) until reset().
   */
  const editAgent = (id: string, fn: (a: AgentInfo) => void): boolean => {
    const i = sim.injected.agents.findIndex((x) => x.id === id);
    if (i >= 0) {
      const a: AgentInfo = { ...sim.injected.agents[i] };
      fn(a);
      sim.injected.agents[i] = a;
      return true;
    }
    const ch = sim.chars.get(id);
    if (!ch) return false;
    const a: AgentInfo = { ...ch.info };
    fn(a);
    const patch: Partial<AgentInfo> = { ...sim.agentPatches.get(id) };
    for (const k of ['status', 'statusSince', 'shells', 'activity'] as const) if (a[k] !== ch.info[k]) Object.assign(patch, { [k]: a[k] });
    sim.agentPatches.set(id, patch);
    return true;
  };

  const applyShells = (a: AgentInfo, shells: ShellJob[]) => {
    const status = statusFor(a.status, shells);
    if (status !== a.status) a.statusSince = now();
    a.status = status;
    a.shells = shells;
    // like server: 'shell' status takes effect right from start of wait
    const oldest = oldestShell(shells, false);
    if (status === 'shell' && oldest) a.statusSince = Math.min(a.statusSince, oldest.startedAt);
  };

  return {
    state: () => ({
      cols: sim.building.cols,
      camera: { x: Math.round(camera.x), y: Math.round(camera.y), zoom: camera.zoom },
      rooms: [...sim.rooms.values()].map((r) => ({
        id: r.id,
        name: r.info.name,
        slot: r.slot,
        phase: r.phase,
        listed: r.listed,
        lightOn: r.lightOn,
        light: Math.round(r.light(now()) * 100) / 100,
        occupants: sim.occupants(r),
      })),
      chars: [...sim.chars.values()].map((c) => ({
        id: c.id,
        name: c.info.name,
        kind: c.info.kind,
        status: c.info.status,
        mode: c.mode,
        step: c.step?.t ?? null,
        queue: c.queue.map((s) => s.t),
        tile: [c.tx, c.ty],
        room: c.roomId,
        spot: c.atSpot,
        leaving: c.leaving,
        pose: c.pose,
        held: c.held,
        dir: c.dir,
        icon: c.icon,
        shell: c.mode === 'shell' ? { stage: c.shellStage, count: c.shellCount, label: c.shellLabel, ageMin: Math.round(((now() - c.shellSince) / 60_000) * 10) / 10 } : null,
      })),
    }),

    spawnSession: (opts = {}) => {
      const project = opts.project ?? `projeto-teste-${seq + 1}`;
      let room: RoomInfo | undefined = [...sim.rooms.values()].map((r) => r.info).find((r) => r.name === project) ?? sim.injected.rooms.find((r) => r.name === project);
      if (!room) {
        const id = `/debug/${project}`;
        room = { id, name: project, path: id, slot: freeSlot(), seed: hash32(id), createdAt: now() };
        sim.injected.rooms.push(room);
      }
      const n = ++seq;
      const sessionId = `dbg-sess-${n}`;
      const account = opts.account ?? [...sim.accounts.keys()][n % Math.max(1, sim.accounts.size)] ?? '.claude';
      const main = makeAgent({
        id: `dbg:${n}`,
        kind: 'main',
        name: opts.name ?? NAMES[n % NAMES.length],
        roomId: room.id,
        account,
        sessionId,
        status: opts.status ?? 'working',
        title: `Test session ${n}`,
      });
      if (opts.shell) {
        const sh = opts.shell;
        const n = Math.max(1, Math.floor(sh.count ?? 1));
        const jobs: ShellJobInput[] = [];
        for (let i = 0; i < n; i++) {
          jobs.push({
            label: i === 0 ? sh.label : `${sh.label ?? 'Run test suite'} (${i + 1})`,
            command: sh.command,
            // others started after the first one
            ageMinutes: Math.max(0, (sh.ageMinutes ?? 0) - i * 0.5),
            background: sh.background ?? true,
            kind: sh.kind,
          });
        }
        applyShells(main, makeJobs(jobs));
        main.activity = { id: `dbg-act-${++seq}`, kind: 'run', icon: '💻', text: 'Rodando em segundo plano', tool: 'Bash', at: now() };
      }
      sim.injected.agents.push(main);
      for (let i = 0; i < (opts.subs ?? 0); i++) {
        const k = ++seq;
        sim.injected.agents.push(
          makeAgent({ id: `${sessionId}:sub${k}`, kind: 'sub', parentId: main.id, name: NAMES[k % NAMES.length], roomId: room.id, account, sessionId, title: 'Investigar o bug' }),
        );
      }
      reapply();
      return main.id;
    },

    setStatus: (id, status, waitingFor) => {
      const i = sim.injected.agents.findIndex((x) => x.id === id);
      if (i < 0) return;
      // fresh copy (like a real snapshot) so world detects change
      const a: AgentInfo = { ...sim.injected.agents[i] };
      sim.injected.agents[i] = a;
      a.status = status;
      a.statusSince = now();
      a.waitingFor = status === 'waiting' ? (waitingFor ?? 'approve permission') : undefined;
      a.activity = {
        id: `dbg-act-${++seq}`,
        kind: status === 'idle' || status === 'done' ? 'done' : status === 'waiting' ? 'wait' : 'run',
        icon: status === 'idle' || status === 'done' ? '✅' : status === 'waiting' ? '✋' : '💻',
        text: status === 'idle' || status === 'done' ? 'Completed' : status === 'waiting' ? 'Needs you' : 'Running tests',
        at: now(),
      };
      reapply();
    },

    endSession: (id) => {
      const main = sim.injected.agents.find((x) => x.id === id);
      sim.injected.agents = sim.injected.agents.filter((x) => x.id !== id && x.parentId !== id);
      if (main && !sim.injected.agents.some((x) => x.roomId === main.roomId)) sim.injected.rooms = sim.injected.rooms.filter((r) => r.id !== main.roomId);
      reapply();
    },

    closeSession: (id) => {
      sim.forcedOffline.add(id);
      for (const c of sim.chars.values()) if (c.info.parentId === id) sim.forcedOffline.add(c.id);
      reapply();
    },

    closeRoom: (roomId) => {
      for (const c of sim.chars.values()) if (c.roomId === roomId) sim.forcedOffline.add(c.id);
      sim.hiddenRooms.add(roomId);
      reapply();
    },

    reset: () => {
      sim.agentPatches.clear();
      sim.forcedOffline.clear();
      sim.hiddenRooms.clear();
      sim.injected.agents = [];
      sim.injected.rooms = [];
      reapply();
    },

    setHour: (h) => {
      renderer.hourOverride = h;
    },

    lookAt: (tx, ty, zoom) => {
      onCameraMoved();
      camera.follow = null;
      camera.stop();
      camera.x = tx * TILE;
      camera.y = ty * TILE;
      if (zoom) camera.zoom = zoom;
      camera.clamp();
    },

    lookAtRoom: (idOrName, zoom = 2.5) => {
      const room = [...sim.rooms.values()].find((r) => r.id === idOrName || r.info.name === idOrName);
      if (!room) return;
      const r = room.layout.rect;
      onCameraMoved();
      camera.follow = null;
      camera.stop();
      camera.x = (r.x + r.w / 2) * TILE;
      camera.y = (r.y + r.h / 2) * TILE;
      camera.zoom = zoom;
      camera.clamp();
    },

    fastForward: () => sim.fastForward(now()),

    wanderNow: () => {
      for (const c of sim.chars.values()) c.nextOutingAt = 1;
    },

    socialize: (kind, ids) => {
      sim.fastForward(now());
      return sim.social.force(kind, now(), ids);
    },

    gatherings: () =>
      [...sim.social.gatherings].map((g) => ({
        kind: g.kind,
        phase: g.phase,
        program: g.program,
        bet: g.bet,
        score: g.score,
        members: g.members.map((m) => ({ name: sim.chars.get(m.id)?.info.name ?? m.id, role: m.role, arrived: m.arrived, left: m.left, pose: m.pose })),
      })),

    coins: (id, delta) => {
      const w = sim.social.wallets.get(id);
      if (!w) return 0;
      if (delta > 0) sim.social.wallets.credit(id, delta, '🛠️', 'Adjustment (debug)', now());
      else w.coins = Math.max(0, w.coins + delta);
      return w.coins;
    },

    setShells: (id, jobs) => {
      if (editAgent(id, (a) => applyShells(a, makeJobs(jobs)))) reapply();
    },

    ageShells: (minutes, agentId) => {
      const ms = minutes * 60_000;
      if (!Number.isFinite(ms) || !ms) return;
      const ids = agentId ? [agentId] : [...sim.injected.agents.map((a) => a.id), ...sim.agentPatches.keys()];
      for (const id of ids) {
        editAgent(id, (a) => {
          if (!a.shells?.length) return;
          a.shells = a.shells.map((j) => ({ ...j, startedAt: j.startedAt - ms }));
          if (a.status === 'shell') a.statusSince -= ms;
        });
      }
      reapply();
    },

    finishShell: (id, result = 'completed', opts = {}) => {
      const ok = result === 'completed';
      const done = editAgent(id, (a) => {
        const shells = [...(a.shells ?? [])].sort((x, y) => x.startedAt - y.startedAt);
        const ended = opts.all ? shells : shells.slice(0, 1);
        const rest = opts.all ? [] : shells.slice(1);
        const t = now();
        const ms = ended[0] ? t - ended[0].startedAt : undefined;
        // same texts as server ("Shell completed: <label> (<duration>)", "Shell failed: ...")
        const outcome: ShellOutcome = ok ? 'ok' : result === 'killed' ? 'killed' : 'failed';
        const detail = ended.map((j) => j.command ?? j.label).join(' | ') || undefined;
        const activity: Activity = { id: `dbg-act-${++seq}`, at: t, ...SPECIAL.shellDone(ended[0]?.label, outcome, ms, detail) };
        if (ok && ms !== undefined) activity.durationMs = ms;
        a.activity = activity;
        a.recent = [...(a.recent ?? []), activity].slice(-30);
        a.shells = rest;
        const next = rest.some((j) => j.background) ? 'shell' : rest.length ? 'working' : (opts.then ?? 'working');
        if (next !== a.status) {
          a.status = next;
          a.statusSince = t;
        }
      });
      if (done) reapply();
    },

    roomEffect: (idOrName, kind, opts = {}) => {
      const room = [...sim.rooms.values()].find((r) => r.id === idOrName || r.info.name === idOrName);
      if (!room) return;
      if (!kind) {
        sim.roomFx.active.delete(room.id);
        return;
      }
      const t = now();
      const text = opts.text ?? (kind === 'party' ? 'PR #12 mergeado!' : 'CI falhou (main)');
      const agentId = opts.agentId ?? [...sim.chars.values()].find((c) => c.roomId === room.id && !c.leaving)?.id;
      const end = t + (kind === 'party' ? 12_000 : 3_600_000);
      sim.roomFx.active.set(room.id, { roomId: room.id, kind, text, agentId, key: t, start: t, end, cheered: new Set(), sticky: true });
    },

    sim,
    camera,
  };
}
