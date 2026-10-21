// What Visit scene displays, DOM-free (testable): top banner, lateral panel (rooms and agents, read-only),
// agent card, and building lighting. Derived from `WorldBuildingDetail` received from world: fictional
// room names, name, role, tool, and status of each agent, without timestamps ("how long ago" is not exposed in visits).
import { tr } from '../../../../shared/i18n';
import { floorLabel } from '../../../../shared/world/floor-labels';
import { hidesAgents, WORLD_TOOL_ACCOUNTS, worldId } from '../../../../shared/world/office-from-world';
import type { WorldAgent, WorldBuildingDetail, WorldBuildingPublic } from '../../../../shared/world/protocol';
import { floorsLabel } from '../city/cards';
import type { VisitLight } from '../sim/sim';

/** Building lighting in visit: away (paused, offline), discreet (empty rooms lit), or live. */
export function visitLightOf(b: Pick<WorldBuildingPublic, 'state' | 'discreet'>): VisitLight {
  if (b.state === 'away') return 'away';
  return b.discreet === true ? 'discreet' : 'live';
}

/** "1 agent", "6 agents". */
export function agentsLabel(n: number): string {
  return n === 1 ? tr('1 agente') : tr('{0} agentes', [n]);
}

/** "1 visitor now", "3 visitors now". */
export function visitorsLabel(n: number): string {
  return n === 1 ? tr('1 visitante agora') : tr('{0} visitantes agora', [n]);
}

/** Agents displayed (in discreet and away mode, none, even if inadvertently included in payload). */
function shownAgents(d: WorldBuildingDetail): number {
  if (hidesAgents(d.building)) return 0;
  return d.floors.reduce((n, f) => n + (Array.isArray(f.agents) ? f.agents.length : 0), 0);
}

export interface VisitBanner {
  /** "Helena's building" (or "Your building, as seen by others"). */
  title: string;
  /** "3 floors · 6 agents · quiet mode". */
  details: string[];
  /** Selo do estado: null ao vivo. */
  mode: 'discreet' | 'away' | null;
}

/** Top banner: owner, floor count, agents, and discreet/away indicator. */
export function visitBanner(d: WorldBuildingDetail, mine: boolean): VisitBanner {
  const b = d.building;
  const light = visitLightOf(b);
  const details = [floorsLabel(d.floors.length)];
  if (light === 'live') details.push(agentsLabel(shownAgents(d)));
  else details.push(light === 'away' ? tr('apagado') : tr('modo discreto'));
  return {
    title: mine ? tr('Seu prédio, como os outros veem') : tr('Prédio de {0}', [b.owner.name]),
    details,
    mode: light === 'live' ? null : light,
  };
}

export type VisitStatus = 'working' | 'waiting' | 'idle' | 'shell';

export interface VisitAgentRow {
  /** Agent ID in visit office (`world:` + world ID): matches rendered character. */
  id: string;
  name: string;
  role: string;
  tool: string;
  status: VisitStatus;
  statusText: string;
}

export interface VisitRoomRow {
  id: string;
  name: string;
  agents: VisitAgentRow[];
}

export interface VisitPanel {
  rooms: VisitRoomRow[];
  /** Why rooms are empty (discreet, away), or null. */
  empty: string | null;
}

const STATUS: readonly VisitStatus[] = ['working', 'waiting', 'idle', 'shell'];

/** "working", "waiting for owner", "idle", "watching terminal". */
export function statusText(s: VisitStatus): string {
  switch (s) {
    case 'working':
      return tr('trabalhando');
    case 'waiting':
      return tr('esperando o dono');
    case 'shell':
      return tr('de olho no terminal');
    default:
      return tr('à toa');
  }
}

/** Panel row (name, role, tool, and status: nothing else exists in visit). */
export function agentRow(a: WorldAgent): VisitAgentRow {
  const status: VisitStatus = STATUS.includes(a.status) ? a.status : 'idle';
  const provider = a.provider === 'codex' ? 'codex' : 'claude';
  return {
    id: worldId(a.id),
    name: typeof a.name === 'string' && a.name ? a.name : tr('Agente'),
    role: a.kind === 'sub' ? tr('Subagente') : tr('Agente principal'),
    tool: WORLD_TOOL_ACCOUNTS[provider].name,
    status,
    statusText: statusText(status),
  };
}

/** Side panel: each room (translated fictional name) with its agents. */
export function visitPanel(d: WorldBuildingDetail): VisitPanel {
  const hidden = hidesAgents(d.building);
  const rooms = d.floors.map((f) => ({
    id: f.id,
    name: floorLabel(typeof f.label === 'string' ? f.label : ''),
    agents: hidden || !Array.isArray(f.agents) ? [] : f.agents.map(agentRow),
  }));
  const light = visitLightOf(d.building);
  const empty =
    light === 'away'
      ? tr('Prédio apagado: o dono pausou ou não está com o Habblaud aberto. As salas ficam escuras e vazias.')
      : light === 'discreet'
        ? tr('Modo discreto: o dono não mostra os agentes. As salas aparecem vazias, com a luz acesa.')
        : null;
  return { rooms, empty };
}

/** Panel agent by visit office ID (`world:...`), for card view. */
export function findAgent(d: WorldBuildingDetail, id: string): (VisitAgentRow & { room: string }) | null {
  if (hidesAgents(d.building)) return null;
  for (const f of d.floors) {
    for (const a of Array.isArray(f.agents) ? f.agents : []) {
      if (worldId(a.id) === id) return { ...agentRow(a), room: floorLabel(f.label) };
    }
  }
  return null;
}
