// Shared context between UI components.
import type { AccountInfo, AgentInfo } from '../../../shared/types';
import type { OfficeStore } from '../net/store';
import type { Selection, WorldApi } from '../world/api';
import type { UiPrefs } from './prefs';

export interface UiComponent {
  /** Called at most once per frame when something changes (snapshot, selection, clock...). */
  render(): void;
}

export type PanelName = 'sidebar' | 'feed';

/**
 * A single terminal window per agent: interactive when session runs inside Habblaud (pty); otherwise
 * read-only (with "Take over here" to become interactive). Mounted in ui/index.ts.
 */
export interface TerminalRouter {
  /** Agent with opened terminal (either type), or null. */
  readonly openAgentId: string | null;
  open(agentId: string, opener?: HTMLElement | null): void;
  toggle(agentId: string, opener?: HTMLElement | null): void;
  /** Whether this agent's terminal would be interactive. */
  interactive(agentId: string): boolean;
  /** Whether any terminal can be opened right now (local access, outside timelapse). */
  readonly available: boolean;
  /** Interactive terminal enabled (launch new sessions, takeover, terminate). */
  readonly interactiveEnabled: boolean;
  /** New Claude Code session in folder, launched in interactive terminal. */
  newSession(cwd: string, account?: string): Promise<void>;
}

export type HelpSection = 'usage' | 'codex';

export interface UiContext {
  readonly store: OfficeStore;
  /** Terminal router (defined after panels exist). */
  terminals?: TerminalRouter;
  readonly world: WorldApi;
  readonly root: HTMLElement;
  readonly prefs: Readonly<UiPrefs>;
  updatePrefs(patch: Partial<UiPrefs>): void;
  /** Server clock (corrects time skew between client and server). */
  now(): number;
  account(id: string): AccountInfo | undefined;
  agent(id: string): AgentInfo | undefined;
  selection(): Selection;
  /**
   * Selects an object in the world (UI syncs via onSelect). With `focus`, camera pans to target
   * within unobstructed area (outside panels) and focus is maintained across panel changes until user pans camera.
   */
  select(sel: Selection, opts?: { focus?: boolean }): void;
  /** Refocuses camera on current selection (Center button). */
  focusSelection(): void;
  /** Camera commands from buttons/hotkeys (cancels maintained focus). */
  camera(action: 'overview' | 'zoomIn' | 'zoomOut'): void;
  /** Schedules a render on the next frame. */
  invalidate(): void;
  /** Opens/closes a panel (without argument: toggles). */
  togglePanel(name: PanelName, open?: boolean): void;
  isPanelOpen(name: PanelName): boolean;
  /** Narrow viewport: panels become overlay drawers. */
  isNarrow(): boolean;
  /** Announces text to screen readers. */
  announce(text: string): void;
  focusSearch(): void;
  /** Opens help; with `section`, scrolls to it (e.g. "usage" = Accounts and usage). */
  openHelp(section?: HelpSection): void;
  toggleSettings(): void;
  /** Opens/closes Habblaud World dialog (top bar button; ui/world/world-dialog.ts). */
  toggleWorld(): void;
  /** Opens room renaming input near coords (window px); right-click on room (ui/roomrename.ts). */
  renameRoom?(roomId: string, at: { x: number; y: number }): void;
  /**
   * (Optional) "See how others see": opens Habblaud World city and enters own building (Visit scene). Only
   * available when World scene is mounted (app.ts).
   */
  visitOwnBuilding?(): void;
  /** Opens settings in "About" section (active version and new version). */
  openAbout(): void;
  /** Opens/closes daily timelapse (ui/timelapse.ts). */
  toggleTimelapse(): void;
  isTimelapseOpen(): boolean;
}
