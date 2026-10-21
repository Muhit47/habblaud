// Do usage cards fit on the same row as other top bar items (brand, counters, action buttons)?
// Pure (DOM-free): tested in ui/usage-row.test.ts. UsageCards (ui/usage.ts) measures DOM and applies result:
// when they don't fit, top bar wraps them into a dedicated second row.

export interface UsageRowInput {
  /** Usable width of bar (excluding padding). */
  barWidth: number;
  /** Widths of other visible top bar items. */
  others: number[];
  /** Gap between top bar items. */
  gap: number;
  /** Gap between cards. */
  cardGap: number;
  /** Minimum width per card (lowest allowable before content clips). */
  cards: number[];
}

export function usageRowFits(i: UsageRowInput): boolean {
  if (i.cards.length === 0) return true;
  // One gap between each bar item: remaining items plus cards cluster.
  const used = i.others.reduce((sum, w) => sum + w, 0) + i.gap * i.others.length;
  const need = i.cards.reduce((sum, w) => sum + w, 0) + i.cardGap * (i.cards.length - 1);
  return need <= i.barWidth - used;
}
