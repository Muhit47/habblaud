// Interactive terminal: floating window running actual Claude Code session (server pty, client xterm.js).
// Unlike the live terminal (ui/terminal.ts, which mirrors the conversation), users can type, reply, and exit here.
// Sessions running in external terminals (e.g. Windows Terminal) first open in live terminal with "Take over here";
// this window only displays the "in another terminal" warning when live terminal is closed. Tabs switch
// between agents within the same project; both windows share the same floating position.
// Keypresses do not bubble up to office hotkeys (T, P, M, Esc...): Esc interrupts Claude.
// Closing the window does not terminate the session; "Stop" terminates it.
import type { AgentInfo, PtyInfo } from '../../../shared/types';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';
import { maximizeButton, Movable } from './movable';
import { closePty, createPty, stopAgent, takeoverAgent } from './ptyapi';
import type { PtyPane } from './ptypane';
import { TermActions } from './termactions';
import { TermTabs } from './termtabs';
import { createAccountChip, updateAccountChip } from './widgets';
import { tr } from '../../../shared/i18n';

/** Pty controls exposed to agent drawer and shortcuts. */
export interface PtyControl {
  /** Feature enabled (outside Docker, with node-pty and local access). */
  readonly enabled: boolean;
  /** Reason feature is disabled. */
  readonly reason: string;
  /** Running interactive terminal for this agent. */
  ptyOf(agentId: string): PtyInfo | undefined;
  /** Agent focused in window (via pty or external terminal). */
  readonly agentId: string | null;
  readonly isOpen: boolean;
  /** Opens window for agent: connects pty or offers takeover if running externally. */
  openAgent(agentId: string): void;
  close(): void;
  takeover(agentId: string): Promise<void>;
  newSession(cwd: string, account?: string): Promise<void>;
  stop(agentId: string): Promise<void>;
}

export class PtyPanel implements UiComponent, PtyControl {
  readonly el: HTMLElement;
  private pane: PtyPane | null = null;
  private loading: Promise<PtyPane> | null = null;
  private info: PtyInfo | null = null;
  /** Agent running in external terminal (no pty here), displayed with "Take over here". */
  private external: string | null = null;
  private screen: HTMLElement;
  private away: HTMLElement;
  private awayTitle: HTMLElement;
  private nameEl: HTMLElement;
  private accEl: HTMLElement;
  private roomEl: HTMLElement;
  private stateEl: HTMLElement;
  private actions: TermActions;
  private tabs: TermTabs;
  private movable: Movable;
  /** Notified when window opens (closes live terminal: both share the same slot). */
  onShow: (() => void) | null = null;
  /** Agent queued for selection upon snapshot arrival (newly created or taken-over session). */
  private pendingSelect: string | null = null;

  constructor(private ctx: UiContext) {
    const icon = h('span', { class: 'ui-term__icon', attrs: { 'aria-hidden': 'true' } });
    icon.innerHTML = ICONS.terminal;
    this.accEl = createAccountChip('sm');
    this.nameEl = h('strong', { class: 'ui-term__name' });
    this.roomEl = h('span', { class: 'ui-term__room' });
    this.stateEl = h('span', { class: 'ui-pty__state', role: 'status' });
    this.actions = new TermActions(ctx, this, false, async () => {
      if (this.info) await closePty(this.info.id);
    });
    this.tabs = new TermTabs(ctx);
    const close = iconButton(ICONS.close, tr('Fechar a janela (a sessão continua rodando)'), () => this.close(), 'ui-icon-btn--sm ui-term__close');
    const bar = h(
      'div',
      { class: 'ui-term__bar' },
      icon,
      h('span', { class: 'ui-term__kind', text: tr('terminal') }),
      h('div', { class: 'ui-term__who' }, this.accEl, this.nameEl, this.roomEl),
      this.stateEl,
      h('span', { class: 'ui-pty__live', text: tr('interativo') }),
      this.actions.el,
      maximizeButton(() => this.movable, () => requestAnimationFrame(() => this.pane?.refit(true))),
      close,
    );
    this.screen = h('div', { class: 'ui-pty__body' });
    this.awayTitle = h('p', { class: 'ui-pty__away-title' });
    this.away = h(
      'div',
      { class: 'ui-pty__away', hidden: true },
      h('strong', { text: tr('Esta sessão está aberta em outro terminal') }),
      this.awayTitle,
      h('p', { class: 'ui-muted', text: tr('Use "Assumir daqui" (no topo) para encerrar lá e continuar a mesma conversa nesta janela, podendo digitar.') }),
    );
    this.el = h('section', { class: 'ui-term ui-pty', role: 'dialog', hidden: true, attrs: { 'aria-label': tr('Terminal') } }, bar, this.tabs.el, this.screen, this.away);
    // Keys pressed in terminal belong to Claude Code, bypassing office hotkeys.
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    this.movable = new Movable(this.el, bar, { key: 'habblaud.move.term', enabled: () => !ctx.isNarrow(), onMove: () => this.pane?.refit(true) });
    this.el.addEventListener('keyup', (e) => e.stopPropagation());
  }

  get enabled(): boolean {
    return !!this.ctx.store.snapshot?.meta.pty?.enabled && !this.ctx.store.replaying;
  }

  get reason(): string {
    if (this.ctx.store.replaying) return tr('Sem terminal no timelapse');
    return this.ctx.store.snapshot?.meta.pty?.reason ?? tr('Terminal interativo desligado');
  }

  get isOpen(): boolean {
    return this.info !== null || this.external !== null;
  }

  get agentId(): string | null {
    return this.info?.agentId ?? this.external;
  }

  ptyOf(agentId: string): PtyInfo | undefined {
    return this.ctx.store.snapshot?.ptys?.find((p) => p.agentId === agentId && p.exitedAt === undefined);
  }

  openAgent(agentId: string): void {
    const p = this.ptyOf(agentId);
    if (p) return this.show(p);
    this.pane?.detach();
    this.info = null;
    this.external = agentId;
    this.reveal();
    this.render();
    this.ctx.invalidate();
  }

  close(): void {
    if (!this.isOpen) return;
    this.pane?.detach();
    this.info = null;
    this.external = null;
    this.el.hidden = true;
    this.ctx.invalidate();
  }

  async takeover(agentId: string): Promise<void> {
    const p = await takeoverAgent(agentId);
    if (p) this.show(p, true);
  }

  async newSession(cwd: string, account?: string): Promise<void> {
    const p = await createPty(cwd, account);
    if (p) this.show(p, true);
  }

  async stop(agentId: string): Promise<void> {
    await stopAgent(agentId);
    this.ctx.announce(tr('Sessão encerrada.'));
  }

  render(): void {
    if (this.external) return this.renderExternal(this.external);
    const info = this.info;
    if (!info) return;
    // Snapshot list reflects latest lifecycle status (terminated, exit code).
    const fresh = this.ctx.store.snapshot?.ptys?.find((p) => p.id === info.id);
    if (fresh) this.info = fresh;
    const cur = this.info ?? info;
    const agent: AgentInfo | undefined = this.ctx.agent(cur.agentId);
    if (agent && this.pendingSelect === cur.agentId) {
      this.pendingSelect = null;
      this.ctx.select({ type: 'agent', id: agent.id });
    }
    setText(this.nameEl, agent?.name ?? 'Claude Code');
    updateAccountChip(this.accEl, this.ctx.account(cur.account), cur.account);
    setText(this.roomEl, agent?.title ?? cur.cwd);
    const ended = cur.exitedAt !== undefined;
    setText(this.stateEl, ended ? tr('encerrado') : agent ? '' : cur.resumed ? tr('retomando…') : tr('iniciando…'));
    this.actions.withTakeover = false;
    this.actions.render(ended ? null : (agent ?? null));
    this.tabs.render(agent ? agent.id : null);
    this.setMode(false);
  }

  /** Session running in another terminal: identity, topic, and "Take over here" action. */
  private renderExternal(id: string): void {
    // Taken over (locally or via another browser tab): converts into active interactive terminal.
    const own = this.ptyOf(id);
    if (own) return this.show(own);
    const agent = this.ctx.agent(id);
    setText(this.nameEl, agent?.name ?? tr('Agente'));
    if (agent) updateAccountChip(this.accEl, this.ctx.account(agent.account), agent.account);
    const room = agent ? this.ctx.store.room(agent.roomId) : undefined;
    setText(this.roomEl, room?.name ?? '');
    setText(this.stateEl, agent ? tr('em outro terminal') : tr('saiu do escritório'));
    setText(this.awayTitle, agent?.title ?? '');
    setHidden(this.awayTitle, !agent?.title);
    this.actions.withTakeover = true;
    this.actions.render(agent ?? null);
    this.tabs.render(agent ? id : null);
    this.setMode(true);
  }

  private setMode(away: boolean): void {
    setHidden(this.away, !away);
    setHidden(this.screen, away);
    this.el.classList.toggle('is-away', away);
  }

  private reveal(): void {
    if (this.el.hidden) this.movable.restore();
    this.el.hidden = false;
    this.onShow?.();
  }

  private show(p: PtyInfo, fresh = false): void {
    this.info = p;
    this.external = null;
    if (fresh) this.pendingSelect = p.agentId;
    this.reveal();
    this.render();
    void this.ensurePane().then((pane) => {
      if (this.info?.id !== p.id) return;
      pane.attach(p.id);
      requestAnimationFrame(() => {
        pane.refit(true);
        pane.focus();
      });
    });
    this.ctx.invalidate();
  }

  private ensurePane(): Promise<PtyPane> {
    if (this.pane) return Promise.resolve(this.pane);
    this.loading ??= import('./ptypane').then(({ PtyPane }) => {
      this.pane = new PtyPane(() => this.ctx.invalidate());
      this.screen.append(this.pane.el);
      return this.pane;
    });
    return this.loading;
  }
}
