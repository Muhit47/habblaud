// Reusable UI components across panels: account chip (and "Codex" tag), status dot, role badge, progress bar.
import type { AccountInfo, Activity, AgentInfo, AgentStatus, Provider } from '../../../shared/types';
import { h, setAttr, setHidden, setStyleVar, setText, setTitle, setVariant } from './dom';
import { ANTIGRAVITY_CHIP_SVG, KILO_CHIP_SVG, WORDMARK } from './icons';
import { shellDoneKind, shellLine, shellStage, statusLabel, type ShellWait } from './model';
import { accountChipLabel, accountProvider, fallbackShort, showsProviderTag } from './provider';
import { tr } from '../../../shared/i18n';

/**
 * Square chip showing account initial ("C", "D") in account color, or official logos (Antigravity, Kilo).
 * Codex accounts: chip renders hollow (dark fill, colored border/letter, stepped corners): `data-provider="codex"`.
 */
export function createAccountChip(size: 'sm' | 'md' | 'lg' = 'sm'): HTMLElement {
  return h('span', { class: `ui-acc-chip ui-acc-chip--${size}` });
}

/** `provider` = hint for sessions where account is not in snapshot (e.g. historical sessions). */
export function updateAccountChip(chip: HTMLElement, account: AccountInfo | undefined, fallbackId = '', provider?: Provider): void {
  const p = accountProvider(account, fallbackId, provider);
  if (p === 'antigravity') {
    chip.innerHTML = ANTIGRAVITY_CHIP_SVG;
  } else if (p === 'kilo') {
    chip.innerHTML = KILO_CHIP_SVG;
  } else {
    setText(chip, account?.short ?? fallbackShort(fallbackId, p));
  }
  setStyleVar(chip, '--acc', account?.color ?? (p === 'antigravity' ? '#2563eb' : p === 'kilo' ? '#7c3aed' : '#8b98b3'));
  setAttr(chip, 'data-provider', p === 'codex' ? 'codex' : p === 'antigravity' ? 'antigravity' : p === 'kilo' ? 'kilo' : null);
  const label = accountChipLabel(account, fallbackId, p);
  setTitle(chip, label);
  setAttr(chip, 'aria-label', label);
}

/** Text badge "Codex" beside account label (in spacious views: drawer, terminal, usage card, tooltips). */
export function createProviderTag(extra = ''): HTMLElement {
  return h('span', { class: `ui-prov${extra ? ` ${extra}` : ''}`, text: 'Codex', hidden: true, title: tr('Agente do Codex (OpenAI)') });
}

/** Shows badge only for Codex (and omits repetition when account name already states "Codex"). */
export function updateProviderTag(tag: HTMLElement, provider: Provider, accountName = ''): void {
  setHidden(tag, !showsProviderTag(provider, accountName));
}

/** Pixel status dot with pulse animation when user input is required. */
export function createStatusDot(): HTMLElement {
  return h('span', { class: 'ui-status-dot', role: 'img' });
}

export function updateStatusDot(dot: HTMLElement, status: AgentStatus): void {
  setVariant(dot, 'is-', status);
  const label = statusLabel(status);
  setAttr(dot, 'aria-label', label);
  setTitle(dot, label);
}

export function createRoleBadge(): HTMLElement {
  return h('span', { class: 'ui-role' });
}

export function updateRoleBadge(badge: HTMLElement, agent: Pick<AgentInfo, 'kind' | 'role' | 'background'>): void {
  setText(badge, agent.kind === 'main' ? tr('Principal') : agent.role || tr('Subagente'));
  setVariant(badge, 'ui-role--', agent.kind);
  setTitle(badge, agent.kind === 'main' ? tr('Agente principal') : tr('Subagente: {0}{1}', [agent.role, agent.background ? tr(' (em segundo plano)') : '']));
}

/** Thin progress bar; `value` 0–1. */
export function createProgress(label: string): HTMLElement {
  const bar = h('span', { class: 'ui-progress', role: 'progressbar', attrs: { 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100 } });
  bar.append(h('span', { class: 'ui-progress__fill' }));
  return bar;
}

export function updateProgress(bar: HTMLElement, done: number, total: number, partial = 0): void {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const partialPct = total > 0 ? Math.round(((done + partial) / total) * 100) : 0;
  setStyleVar(bar, '--p', `${pct}%`);
  setStyleVar(bar, '--pp', `${partialPct}%`);
  setAttr(bar, 'aria-valuenow', String(pct));
  setAttr(bar, 'aria-valuetext', `${done} de ${total}`);
  bar.classList.toggle('is-complete', total > 0 && done === total);
}

/**
 * Activity line with icon and truncated text. Also includes stopwatch elapsed time and "×N" counter
 * (hidden unless waiting on shell), ensuring elapsed time is never truncated by text overflow.
 */
export function createActivityLine(): HTMLElement {
  const el = h('span', { class: 'ui-activity' });
  el.append(
    h('span', { class: 'ui-activity__icon', attrs: { 'aria-hidden': 'true' } }),
    h('span', { class: 'ui-activity__text' }),
    h('span', { class: 'ui-activity__time', hidden: true }),
    h('span', { class: 'ui-activity__count', hidden: true }),
  );
  return el;
}

function activityParts(el: HTMLElement): [HTMLElement, HTMLElement, HTMLElement, HTMLElement] {
  return el.children as unknown as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
}

export function updateActivityLine(el: HTMLElement, activity: Activity | undefined, fallback = tr('Sem atividade ainda')): void {
  const [icon, text, time, count] = activityParts(el);
  setText(icon, activity?.icon ?? '·');
  setText(text, activity?.text ?? fallback);
  setHidden(time, true);
  setHidden(count, true);
  el.classList.remove('is-shell');
  el.classList.toggle('is-error', !!activity?.error);
  // Shell completion (server ✅/❌): highlighted status to distinguish from routine activities.
  const done = shellDoneKind(activity);
  el.classList.toggle('is-shell-ok', done === 'ok');
  el.classList.toggle('is-shell-fail', done === 'fail');
  setTitle(el, activity ? (activity.detail ? `${activity.text}\n${activity.detail}` : activity.text) : fallback);
}

/** Activity line for agents waiting on shell: "⏳ <label> · 12:31 ×2" with active timer. */
export function updateShellActivityLine(el: HTMLElement, wait: ShellWait, now: number): void {
  const [icon, text, time, count] = activityParts(el);
  const line = shellLine(wait, now);
  setText(icon, '⏳');
  setText(text, line.label);
  setText(time, line.time);
  setHidden(time, false);
  setText(count, line.count);
  setHidden(count, !line.count);
  el.classList.add('is-shell');
  el.classList.remove('is-error', 'is-shell-ok', 'is-shell-fail');
  const stage = shellStage(now - wait.since);
  const main = wait.main;
  setTitle(
    el,
    [line.text, main?.command && main.command !== main.label ? main.command : '', `${stage.emoji} ${stage.text}`].filter(Boolean).join('\n'),
  );
}

/** Product wordmark rendered as pixel typography (text preserved for screen readers). */
export function wordmark(cls = 'ui-brand__name'): HTMLElement {
  const el = h('span', { class: cls });
  el.innerHTML = WORDMARK;
  el.append(h('span', { class: 'ui-sr', text: 'Habblaud' }));
  return el;
}
