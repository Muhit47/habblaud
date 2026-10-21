// Habblaud World › Blocked (Phase 5): players blocked by this account (via player card in city) and
// "Unblock" (POST /api/world/unblock via world bridge). Blocking is bidirectional: neither party sees
// each other on streets, in buildings, greetings, or stamps. List sourced from /v1/me.
import { tr } from '../../../../shared/i18n';
import type { WorldBlockedPlayer, WorldClient } from '../../net/world';
import { h, setAttr, setHidden, setText } from '../dom';
import { worldErrorText } from './world-model';

export interface BlockedHost {
  readonly client: WorldClient | null;
  /** Blocked list from latest status (undefined before initial response). */
  list(): WorldBlockedPlayer[] | undefined;
  /** Refetches status via /v1/me (list may have changed in city). */
  refresh(): Promise<void>;
  /** Verifies view is still active (responses received after navigating away are ignored). */
  current(): boolean;
  announce(text: string): void;
}

/** Blocked view: header (with back navigation) supplied by settings-world.ts. */
export function buildBlocked(head: HTMLElement, host: BlockedHost): { el: HTMLElement; sync(): void } {
  const list = h('ul', { class: 'ui-world__blocked' });
  const note = h('p', { class: 'ui-set__hint', text: tr('Carregando…') });
  const error = h('p', { class: 'ui-world__error', role: 'alert', hidden: true });
  /** Player IDs unblocked in current view (removed immediately prior to status refresh). */
  const gone = new Set<string>();
  let key = '';
  let loaded = false;

  const row = (p: WorldBlockedPlayer): HTMLElement => {
    const btn = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tr('Desbloquear'), attrs: { 'aria-label': tr('Desbloquear {0}', [p.name]) } });
    btn.addEventListener('click', async () => {
      const client = host.client;
      if (!client || btn.disabled) return;
      btn.disabled = true;
      setAttr(btn, 'aria-busy', 'true');
      setHidden(error, true);
      const r = await client.unblock(p.id);
      if (!host.current()) return;
      btn.disabled = false;
      setAttr(btn, 'aria-busy', null);
      if (!r.ok) {
        setText(error, worldErrorText(r.code, 'unblock'));
        setHidden(error, false);
        return;
      }
      gone.add(p.id);
      host.announce(tr('{0} desbloqueado.', [p.name]));
      sync();
    });
    return h(
      'li',
      { class: 'ui-set ui-world__blocked-row' },
      h('div', { class: 'ui-set__text' }, h('span', { class: 'ui-world__blocked-name' }, h('span', { text: '🚫', attrs: { 'aria-hidden': 'true' } }), ` ${p.name}`)),
      btn,
    );
  };

  const sync = () => {
    const all = host.list();
    const items = (all ?? []).filter((p) => !gone.has(p.id));
    const k = `${loaded}|${all ? 'y' : 'n'}|${items.map((p) => `${p.id}:${p.name}`).join(',')}`;
    if (k === key) return;
    key = k;
    if (!all && !loaded) {
      setText(note, tr('Carregando…'));
      setHidden(note, false);
      list.replaceChildren();
      return;
    }
    setText(note, items.length ? '' : tr('Ninguém bloqueado.'));
    setHidden(note, items.length > 0);
    list.replaceChildren(...items.map(row));
  };

  void host.refresh().finally(() => {
    if (!host.current()) return;
    loaded = true;
    sync();
  });
  sync();
  return {
    el: h(
      'div',
      { class: 'ui-world__stack' },
      head,
      h('p', { class: 'ui-set__hint', text: tr('Quem você bloqueia não te vê e você não vê a pessoa: na rua, nos prédios, nos cumprimentos e nos carimbos. Para bloquear alguém, abra o cartão da pessoa na cidade.') }),
      note,
      list,
      error,
    ),
    sync,
  };
}
