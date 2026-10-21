// Terminal utilities: conversation search (case- and accent-insensitive matching,
// navigation with "3/17" counter), filter "All / Prompts only / No tools", and copied entry text.
// Model functions are pure and tested in ui/termtools.test.ts. Result highlighting replaces text nodes
// with spans created via createElement/textContent: no transcript text touches innerHTML.
import type { TerminalEntry } from '../../../shared/types';
import type { TerminalItem } from './terminal';
import { tr } from '../../../shared/i18n';

// ---------------------------------------------------------------- filter

export type TerminalFilter = 'all' | 'prompts' | 'noTools';

export const TERMINAL_FILTERS: readonly [TerminalFilter, string, string][] = [
  ['all', tr('Tudo'), tr('Toda a conversa')],
  ['prompts', tr('Só prompts'), tr('Só os seus prompts e as respostas finais do agente')],
  ['noTools', tr('Sem ferramentas'), tr('Esconde as ferramentas e os resultados')],
];

/**
 * Final answers of each turn: agent response texts without trailing tools before next prompt
 * (or end of conversation). Intermediate texts ("Reading file…") are excluded.
 */
export function finalAnswerKeys(items: Iterable<TerminalItem>): Set<string> {
  const finals = new Set<string>();
  let pending: string[] = [];
  for (const item of items) {
    if (item.type !== 'entry') {
      // Tool (or orphan result) followed the text: it was merely an intermediate step.
      pending = [];
      continue;
    }
    const kind = item.entry.kind;
    if (kind === 'assistant') pending.push(item.key);
    else if (kind === 'user') {
      for (const k of pending) finals.add(k);
      pending = [];
    }
  }
  for (const k of pending) finals.add(k);
  return finals;
}

/** Is the item visible under the filter? (`finals` = finalAnswerKeys, used only by "Prompts only".) */
export function itemVisible(item: TerminalItem, filter: TerminalFilter, finals: ReadonlySet<string>): boolean {
  if (filter === 'all') return true;
  if (item.type !== 'entry') return false;
  if (filter === 'noTools') return true;
  return item.entry.kind === 'user' || (item.entry.kind === 'assistant' && finals.has(item.key));
}

// ---------------------------------------------------------------- search

/** "Folded" text for search (lowercased, accents removed) and origin map for each character. */
export interface FoldedText {
  text: string;
  /** Start and end offsets (in original text) generating each `text` position; absent = identity (ASCII). */
  starts?: number[];
  ends?: number[];
}

const ASCII = /^[\x00-\x7f]*$/;
const COMBINING = /[̀-ͯ]/g;

/** Lowercase and accent-stripped ("Ação" -> "acao"), recording original character positions for highlights. */
export function foldText(s: string): FoldedText {
  if (ASCII.test(s)) return { text: s.toLowerCase() };
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const ch of s) {
    const f = ch.normalize('NFD').replace(COMBINING, '').toLowerCase();
    // Combining accent (e + U+0301): omitted from folded text, but previous letter highlight includes it.
    if (!f && ends.length) ends[ends.length - 1] = i + ch.length;
    for (let k = 0; k < f.length; k++) {
      starts.push(i);
      ends.push(i + ch.length);
    }
    text += f;
    i += ch.length;
  }
  return { text, starts, ends };
}

/** Folded text only, without position mapping (for fast preliminary search discard). */
function foldPlain(s: string): string {
  return ASCII.test(s) ? s.toLowerCase() : s.normalize('NFD').replace(COMBINING, '').toLowerCase();
}

/** Pre-folded search query; whitespace-only = no search (''). */
export function foldQuery(query: string): string {
  return query.trim() ? foldText(query).text : '';
}

/** Non-overlapping original text [start, end) slices matching query (pre-folded via foldQuery). */
export function findMatches(text: string, folded: string): [number, number][] {
  if (!folded || !text) return [];
  const f = foldText(text);
  const out: [number, number][] = [];
  for (let i = f.text.indexOf(folded); i !== -1; i = f.text.indexOf(folded, i + folded.length)) {
    const end = i + folded.length;
    out.push(f.starts ? [f.starts[i], f.ends![end - 1]] : [i, end]);
  }
  return out;
}

/** Next (dir = 1) or previous (-1) match wrapping around; without active match (-1), starts at first or last. */
export function stepMatch(current: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return -1;
  if (current < 0 || current >= total) return dir === 1 ? 0 : total - 1;
  return (current + dir + total) % total;
}

/** Global index of current match in [rowKey, matchCount] list (in display order); -1 if not found. */
export function globalIndex(counts: readonly (readonly [string, number])[], ref: { key: string; index: number } | null): number {
  if (!ref) return -1;
  let base = 0;
  for (const [key, n] of counts) {
    if (key === ref.key) return ref.index < n ? base + ref.index : -1;
    base += n;
  }
  return -1;
}

/** Match at position `index` (0 = first) within the same list. */
export function refAt(counts: readonly (readonly [string, number])[], index: number): { key: string; index: number } | null {
  if (index < 0) return null;
  let rest = index;
  for (const [key, n] of counts) {
    if (rest < n) return { key, index: rest };
    rest -= n;
  }
  return null;
}

/** Search counter string: "3/17"; without active match, "0/17". */
export function searchCounter(index: number, total: number): string {
  return `${index >= 0 && index < total ? index + 1 : 0}/${total}`;
}

// ---------------------------------------------------------------- copy

/** Content placed on clipboard by entry copy button (command string for tools). */
export function copyTextOf(e: TerminalEntry): string {
  switch (e.kind) {
    case 'tool':
      return e.input?.trim() ? e.input.replace(/\s+$/, '') : e.title;
    case 'thinking':
      return e.text ?? '';
    case 'system':
      return e.detail?.trim() ? `${e.text}\n${e.detail.replace(/\s+$/, '')}` : e.text;
    default:
      return e.text.replace(/\s+$/, '');
  }
}

// ---------------------------------------------------------------- highlight (DOM)

export const HIT_CLASS = 'ui-term__hit';

/** Non-conversation elements: buttons, decorative markers, and status labels (e.g. "Thinking…", "$", "⎿"). */
function isChrome(el: Element): boolean {
  return el.tagName === 'BUTTON' || el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('data-chrome') || el.classList.contains('ui-md__lang');
}

/** Removes match highlights (`hits`) from a row, rejoining adjacent text nodes. */
export function clearHits(hits: readonly HTMLElement[]): void {
  const parents = new Set<Node>();
  for (const span of hits) {
    const parent = span.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(span.textContent ?? ''), span);
    parents.add(parent);
  }
  for (const p of parents) p.normalize();
}

/**
 * Highlights matches of folded query inside `root` and returns span elements in document order.
 * Scans conversation text nodes only (including collapsed hidden blocks); cross-element matches
 * (e.g. **bo**ld) are not matched.
 */
export function highlightHits(root: HTMLElement, folded: string): HTMLElement[] {
  if (!folded || !foldPlain(root.textContent ?? '').includes(folded)) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT : isChrome(n as Element) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP),
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  const out: HTMLElement[] = [];
  for (const node of nodes) {
    const text = node.data;
    const ranges = findMatches(text, folded);
    if (!ranges.length) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const [a, b] of ranges) {
      if (a > last) frag.append(text.slice(last, a));
      const span = document.createElement('span');
      span.className = HIT_CLASS;
      span.textContent = text.slice(a, b);
      frag.append(span);
      out.push(span);
      last = b;
    }
    if (last < text.length) frag.append(text.slice(last));
    node.replaceWith(frag);
  }
  return out;
}
