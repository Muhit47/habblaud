// UI presentation model: rooms -> agents -> subagents grouping, filters, counters, and labels.
// Pure functions (no DOM), tested in ui/model.test.ts.
import type { AccountInfo, Activity, AgentInfo, AgentStatus, OfficeSnapshot, RoomInfo, ShellJob, TaskItem } from '../../../shared/types';
import { formatElapsed, normalizeSearch } from './format';
import { tr } from '../../../shared/i18n';

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: tr('Trabalhando'),
  waiting: tr('Precisa de você'),
  shell: tr('Esperando o shell'),
  idle: tr('Ocioso'),
  done: tr('Concluído'),
  offline: tr('Saindo'),
};

/** Urgency order (lower = more urgent), used to highlight agents needing attention. */
const STATUS_URGENCY: Record<AgentStatus, number> = { waiting: 0, shell: 1, working: 2, idle: 3, done: 4, offline: 5 };

export function statusLabel(status: AgentStatus): string {
  return STATUS_LABEL[status];
}

/** Activity line text when the agent does not yet have any (e.g. freshly opened session, no request). */
export function activityFallback(agent: Pick<AgentInfo, 'status' | 'waitingFor'>): string {
  switch (agent.status) {
    case 'working':
      return tr('Trabalhando…');
    case 'waiting':
      return agent.waitingFor ? tr('Precisa de você: {0}', [agent.waitingFor]) : tr('Precisa de você');
    case 'shell':
      return tr('Esperando o shell terminar');
    case 'done':
      return tr('Concluiu a tarefa');
    case 'offline':
      return tr('Saindo do escritório');
    default:
      return tr('Aguardando instruções');
  }
}

/** Role badge: "Main agent" or subagent type ("Explore", "Plan"...). */
export function roleLabel(agent: Pick<AgentInfo, 'kind' | 'role'>): string {
  if (agent.kind === 'main') return agent.role || tr('Agente principal');
  return agent.role || tr('Subagente');
}

/** Agent still "present" (not departing). */
export function isPresent(agent: Pick<AgentInfo, 'status'>): boolean {
  return agent.status !== 'offline';
}

export interface Counters {
  rooms: number;
  /** Present agents (main + subagents, excluding departing ones). */
  agents: number;
  /** Agents processing a request (excluding those waiting for a long-running command). */
  working: number;
  /** Active subagents (neither finished nor departing). */
  subagents: number;
  waiting: number;
  /** Shells an agent is waiting on to finish (background and long-running foreground commands). */
  shells: number;
}

/** `now` (server clock) decides when a foreground command counts as waiting. */
export function computeCounters(snap: Pick<OfficeSnapshot, 'rooms' | 'agents'> | null, now = Date.now()): Counters {
  const c: Counters = { rooms: 0, agents: 0, working: 0, subagents: 0, waiting: 0, shells: 0 };
  if (!snap) return c;
  c.rooms = snap.rooms.length;
  for (const a of snap.agents) {
    if (!isPresent(a)) continue;
    c.agents++;
    const wait = shellWaitIn(a, snap.agents, now);
    if (wait) c.shells += Math.max(1, wait.jobs.length);
    else if (a.status === 'working') c.working++;
    if (a.status === 'waiting') c.waiting++;
    if (a.kind === 'sub' && a.status !== 'done') c.subagents++;
  }
  return c;
}

/** Agents waiting on the user, sorted from longest-waiting to most recent. */
export function waitingAgents(agents: readonly AgentInfo[]): AgentInfo[] {
  return agents.filter((a) => a.status === 'waiting').sort((a, b) => a.statusSince - b.statusSince);
}

// ---------------------------------------------------------------- waiting on shell

/** A foreground command only counts as "waiting on shell" after this duration (same threshold as the world). */
export const FOREGROUND_WAIT_MS = 10_000;
/** In the drawer, foreground commands only appear after this duration (fast commands avoid flashing the list). */
export const FOREGROUND_SHOW_MS = 2_000;

export interface ShellWait {
  /** Commands the agent is waiting on, from oldest to newest. */
  jobs: ShellJob[];
  /** Command driving the wait duration and phase (oldest shell); undefined if server does not yet know the commands. */
  main?: ShellJob;
  /** Waiting since (epoch ms). */
  since: number;
  /** true = paused on a long-running foreground command (status 'working'); false = ended turn (status 'shell'). */
  foreground: boolean;
}

const byStart = (a: ShellJob, b: ShellJob) => a.startedAt - b.startedAt || a.id.localeCompare(b.id);

/**
 * Is the agent waiting for any shell to finish? True for status 'shell' (ended turn with background shells)
 * and for 'working' paused on a foreground command for more than FOREGROUND_WAIT_MS. Returns null otherwise.
 * Elapsed time is driven by the oldest shell (Bash); monitors only count if no shell is active.
 */
export function shellWait(agent: Pick<AgentInfo, 'status' | 'shells' | 'statusSince'>, now: number): ShellWait | null {
  const all = agent.shells ?? [];
  let jobs: ShellJob[];
  if (agent.status === 'shell') jobs = all.slice().sort(byStart);
  else if (agent.status === 'working') jobs = all.filter((j) => !j.background && now - j.startedAt >= FOREGROUND_WAIT_MS).sort(byStart);
  else return null;
  if (agent.status === 'working' && jobs.length === 0) return null;
  const main = jobs.find((j) => j.kind === 'shell') ?? jobs[0];
  return { jobs, main, since: Math.min(main?.startedAt ?? agent.statusSince, now), foreground: agent.status === 'working' };
}

/** Background shells launched by descendant subagents of an agent. */
function descendantShells(id: string, agents: readonly AgentInfo[]): ShellJob[] {
  const out: ShellJob[] = [];
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const a of agents) {
      if (a.parentId !== parent || seen.has(a.id)) continue;
      seen.add(a.id);
      queue.push(a.id);
      for (const j of a.shells ?? []) if (j.background) out.push(j);
    }
  }
  return out;
}

/**
 * Like `shellWait`, but office-wide: an agent in 'shell' with no direct shells may be
 * waiting for a background command launched by one of its subagents (matching server speech-bubble logic).
 */
export function shellWaitIn(agent: AgentInfo, agents: readonly AgentInfo[], now: number): ShellWait | null {
  if (agent.status === 'shell' && !agent.shells?.length) {
    const inherited = descendantShells(agent.id, agents);
    if (inherited.length) return shellWait({ status: agent.status, statusSince: agent.statusSince, shells: inherited }, now);
  }
  return shellWait(agent, now);
}

/** Display status: agents blocked on long-running foreground commands show as "Waiting on shell". */
export function displayStatus(agent: Pick<AgentInfo, 'status' | 'shells' | 'statusSince'>, now: number): AgentStatus {
  return shellWait(agent, now) ? 'shell' : agent.status;
}

/** Commands listed in the drawer ("Running shells"): all commands except recently started foreground ones. */
export function visibleShells(agent: Pick<AgentInfo, 'shells'>, now: number): ShellJob[] {
  return (agent.shells ?? []).filter((j) => j.background || j.kind === 'monitor' || now - j.startedAt >= FOREGROUND_SHOW_MS).sort(byStart);
}

/** Agents waiting on shells, sorted from longest-waiting to most recent ("⏳ N shells" button). */
export function shellWaitingAgents(agents: readonly AgentInfo[], now: number): AgentInfo[] {
  return agents
    .filter((a) => isPresent(a))
    .map((a) => ({ a, w: shellWaitIn(a, agents, now) }))
    .filter((x): x is { a: AgentInfo; w: ShellWait } => !!x.w)
    .sort((x, y) => x.w.since - y.w.since || byArrival(x.a, y.a))
    .map((x) => x.a);
}

/** Is any shell currently running? (Determines whether UI ticks elapsed time every second.) */
export function hasRunningShells(snap: Pick<OfficeSnapshot, 'agents'> | null): boolean {
  return !!snap?.agents.some((a) => isPresent(a) && (a.status === 'shell' || (a.shells?.length ?? 0) > 0));
}

/** Command type badge label. */
export function shellKindLabel(job: Pick<ShellJob, 'kind' | 'background'>): string {
  if (job.kind === 'monitor') return 'monitor';
  return job.background ? tr('segundo plano') : tr('primeiro plano');
}

export interface ShellLine {
  /** Main shell label (or generic fallback text). */
  label: string;
  /** Elapsed timer: "0:42", "12:31", "1:02:10". */
  time: string;
  /** "×2" when waiting on multiple commands; "" for a single one. */
  count: string;
  /** Full text for tooltips and screen readers: "⏳ Run suite · 12:31 (2 shells)". */
  text: string;
}

/** Activity line for agents waiting on a shell: "⏳ <label> · <time>" (and "×N" if multiple). */
export function shellLine(wait: ShellWait, now: number): ShellLine {
  const label = wait.main?.label?.trim() || (wait.foreground ? tr('Esperando o comando terminar') : tr('Esperando o shell terminar'));
  const time = formatElapsed(now - wait.since);
  const n = wait.jobs.length;
  const count = n > 1 ? `×${n}` : '';
  return { label, time, count, text: `⏳ ${label} · ${time}${n > 1 ? ` (${n} shells)` : ''}` };
}

/** Explanation text for "Waiting on shell" box. */
export function shellBoxText(wait: Pick<ShellWait, 'foreground' | 'jobs'>): string {
  if (wait.foreground) return tr('Está parado num comando no terminal, esperando ele terminar para continuar o turno.');
  const n = wait.jobs.length;
  return n > 1
    ? tr('Terminou o turno e está esperando {0} shells terminarem. A cada um que termina, o agente recebe o resultado.', [n])
    : tr('Terminou o turno e está esperando o shell terminar. Quando ele terminar, o agente recebe o resultado.');
}

export type ShellStage = 'popcorn' | 'spin' | 'cobweb' | 'nap';

export interface ShellStageInfo {
  stage: ShellStage;
  /** Minimum wait duration before this stage starts (ms). */
  from: number;
  emoji: string;
  /** Short phrase describing character action. */
  text: string;
  /** Help explanation text. */
  help: string;
}

const MIN = 60_000;

/** Waiting stages in the office (the "comedic escalation"), driven by oldest shell age. */
export const SHELL_STAGES: readonly ShellStageInfo[] = [
  {
    stage: 'popcorn',
    from: 0,
    emoji: '🍿',
    text: tr('Comendo pipoca e assistindo ao terminal'),
    help: tr('Até 3 min: recosta na cadeira com um balde de pipoca e assiste ao terminal como se fosse um filme.'),
  },
  {
    stage: 'spin',
    from: 3 * MIN,
    emoji: '🪑',
    text: tr('A pipoca acabou: girando na cadeira'),
    help: tr('De 3 a 10 min: a pipoca acaba; braços cruzados, dedos batendo e, de vez em quando, um giro completo na cadeira.'),
  },
  {
    stage: 'cobweb',
    from: 10 * MIN,
    emoji: '🕸️',
    text: tr('Já tem teia de aranha na cadeira'),
    help: tr('Depois de 10 min: aparece uma teia de aranha na cadeira (ela cresce depois de 20 min) e escapa um bocejo.'),
  },
  {
    stage: 'nap',
    from: 25 * MIN,
    emoji: '😴',
    text: tr('Cochilou esperando o shell'),
    help: tr('Depois de 25 min: cochila na mesa, coberto de teia.'),
  },
];

/** Current waiting stage for a shell running for `ms`, and time remaining until next stage (null if in final stage). */
export function shellStage(ms: number): ShellStageInfo & { nextIn: number | null } {
  const v = Math.max(0, ms);
  let i = 0;
  while (i + 1 < SHELL_STAGES.length && v >= SHELL_STAGES[i + 1].from) i++;
  const next = SHELL_STAGES[i + 1];
  return { ...SHELL_STAGES[i], nextIn: next ? next.from - v : null };
}

/** Server marker for shell termination (Activity with tool 'ShellDone'; error = failed or aborted). */
export function shellDoneKind(activity: Pick<Activity, 'tool' | 'error'> | undefined): 'ok' | 'fail' | null {
  if (activity?.tool !== 'ShellDone') return null;
  return activity.error ? 'fail' : 'ok';
}

export interface TaskProgress {
  completed: number;
  inProgress: number;
  total: number;
}

export function taskProgress(tasks: readonly Pick<TaskItem, 'status'>[]): TaskProgress {
  const p: TaskProgress = { completed: 0, inProgress: 0, total: tasks.length };
  for (const t of tasks) {
    if (t.status === 'completed') p.completed++;
    else if (t.status === 'in_progress') p.inProgress++;
  }
  return p;
}

/** Sums tasks across multiple agents (aggregated progress for a room). */
export function aggregateTasks(agents: readonly Pick<AgentInfo, 'tasks'>[]): TaskProgress {
  return taskProgress(agents.flatMap((a) => a.tasks));
}

// ---------------------------------------------------------------- grouping and filters

export interface AgentFilter {
  /** Free text: name, role, title, room, path, or account. */
  query: string;
  /** Hidden accounts (AccountInfo.id). */
  hiddenAccounts: ReadonlySet<string>;
}

export interface AgentNode {
  agent: AgentInfo;
  /** Visible subagents (after filters), sorted by arrival. */
  subs: AgentInfo[];
  /** Total subagents present in snapshot (regardless of filter). */
  subTotal: number;
}

export interface RoomGroup {
  room: RoomInfo;
  /** Accounts present in room (ids, ordered matching snapshot `accounts`). */
  accounts: string[];
  nodes: AgentNode[];
  /** All agents in the room (unfiltered). */
  agents: AgentInfo[];
  tasks: TaskProgress;
  /** How many room agents match the active filter. */
  matches: number;
}

function accountText(account: AccountInfo | undefined): string {
  if (!account) return '';
  // Provider tool name participates in search: "codex" matches Codex agents.
  return [account.short, account.name, account.email ?? '', account.id, account.provider === 'codex' ? 'Codex' : ''].join(' ');
}

/** True if agent matches text search query (accent-insensitive, case-insensitive). */
export function matchesQuery(agent: AgentInfo, room: RoomInfo | undefined, account: AccountInfo | undefined, query: string): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  const hay = normalizeSearch(
    [
      agent.name,
      roleLabel(agent),
      agent.title ?? '',
      room?.name ?? '',
      room?.path ?? '',
      accountText(account),
      agent.activity?.text ?? '',
      // Agents waiting on shell also match when searching for "shell" (or command label).
      agent.status === 'shell' ? STATUS_LABEL.shell : '',
      ...(agent.shells ?? []).map((j) => `shell ${j.label}`),
    ].join(' \u0001 '),
  );
  return q.split(/\s+/).every((term) => hay.includes(term));
}

const byArrival = (a: AgentInfo, b: AgentInfo) => a.startedAt - b.startedAt || a.id.localeCompare(b.id);

/**
 * Groups snapshot into rooms (sorted by slot) -> main agents -> subagents.
 * Subagents whose parent is in a different room become top-level items.
 * With filter: a main agent appears if it or any subagent matches; if main matches, all subs appear.
 * Rooms with zero visible agents are omitted (unless no filter is active).
 */
export function groupRooms(snap: Pick<OfficeSnapshot, 'rooms' | 'agents' | 'accounts'> | null, filter?: AgentFilter): RoomGroup[] {
  if (!snap) return [];
  const accounts = new Map(snap.accounts.map((a) => [a.id, a]));
  const accountOrder = new Map(snap.accounts.map((a, i) => [a.id, i]));
  const query = filter?.query.trim() ?? '';
  const hidden = filter?.hiddenAccounts ?? new Set<string>();
  const filtering = query.length > 0 || hidden.size > 0;

  const byRoom = new Map<string, AgentInfo[]>();
  for (const a of snap.agents) {
    let list = byRoom.get(a.roomId);
    if (!list) byRoom.set(a.roomId, (list = []));
    list.push(a);
  }

  const groups: RoomGroup[] = [];
  for (const room of [...snap.rooms].sort((a, b) => a.slot - b.slot)) {
    const agents = (byRoom.get(room.id) ?? []).slice().sort(byArrival);
    const visible = (a: AgentInfo) => !hidden.has(a.account) && matchesQuery(a, room, accounts.get(a.account), query);
    const ids = new Set(agents.map((a) => a.id));
    const subsOf = new Map<string, AgentInfo[]>();
    const top: AgentInfo[] = [];
    for (const a of agents) {
      if (a.kind === 'sub' && a.parentId && ids.has(a.parentId)) {
        let list = subsOf.get(a.parentId);
        if (!list) subsOf.set(a.parentId, (list = []));
        list.push(a);
      } else {
        top.push(a);
      }
    }

    const nodes: AgentNode[] = [];
    let matches = 0;
    for (const a of top) {
      const subs = subsOf.get(a.id) ?? [];
      const selfVisible = visible(a);
      const visibleSubs = selfVisible ? subs.filter((s) => !hidden.has(s.account)) : subs.filter(visible);
      if (!selfVisible && visibleSubs.length === 0) continue;
      matches += (selfVisible ? 1 : 0) + visibleSubs.length;
      nodes.push({ agent: a, subs: visibleSubs, subTotal: subs.length });
    }
    if (filtering && nodes.length === 0) continue;

    const present = [...new Set(agents.map((a) => a.account))].sort((x, y) => (accountOrder.get(x) ?? 99) - (accountOrder.get(y) ?? 99));
    groups.push({ room, accounts: present, nodes, agents, tasks: aggregateTasks(agents), matches });
  }
  return groups;
}

/** Distinct accounts present in agent list, ordered matching snapshot accounts. */
export function accountsOf(agents: readonly Pick<AgentInfo, 'account'>[], accounts: readonly Pick<AccountInfo, 'id'>[]): string[] {
  const present = new Set(agents.map((a) => a.account));
  const ordered = accounts.map((a) => a.id).filter((id) => present.has(id));
  for (const id of present) if (!ordered.includes(id)) ordered.push(id);
  return ordered;
}

/** Sorts by urgency and then arrival order (for subagent lists in the drawer). */
export function sortByUrgency(agents: readonly AgentInfo[]): AgentInfo[] {
  return agents.slice().sort((a, b) => STATUS_URGENCY[a.status] - STATUS_URGENCY[b.status] || byArrival(a, b));
}

/** Shell shortcuts for empty state hint: ["c", "d"] -> "shortcut c or d". */
export function shortcutHint(accounts: readonly Pick<AccountInfo, 'short'>[]): string {
  const keys = accounts.map((a) => a.short.toLowerCase()).filter((s) => /^[a-z0-9]{1,3}$/.test(s));
  if (keys.length === 0) return '';
  if (keys.length === 1) return tr('atalho {0}', [keys[0]]);
  return tr('atalhos {0} ou {1}', [keys.slice(0, -1).join(', '), keys[keys.length - 1]]);
}

/**
 * Merges long server history with recent activities, deduplicated, from oldest to newest.
 * `until` (replay timestamp) discards subsequent events — rewinding prevents drawer from showing the future.
 */
export function mergeHistory<T extends { id: string; at: number }>(history: readonly T[], recent: readonly T[], limit = 200, until?: number): T[] {
  const seen = new Map<string, T>();
  const keep = (a: T) => until === undefined || a.at <= until;
  for (const a of history) if (keep(a)) seen.set(a.id, a);
  for (const a of recent) if (keep(a)) seen.set(a.id, a);
  return [...seen.values()].sort((a, b) => a.at - b.at).slice(-limit);
}
