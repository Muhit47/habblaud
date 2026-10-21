// User-defined room ordering in sidebar (by dragging room header), persisted in browser
// by room id (the project folder). Rooms missing from saved order sort to end in original order.
const ORDER_KEY = 'habblaud.rooms.order';
/** Retained room capacity (most recent items in list). */
const MAX_ROOMS = 100;

export function orderRooms<T>(items: readonly T[], idOf: (item: T) => string): T[] {
  const saved = loadOrder();
  if (!saved.length) return items.slice();
  const rank = new Map(saved.map((id, i) => [id, i]));
  return items
    .map((item, i) => ({ item, i, r: rank.get(idOf(item)) }))
    .sort((x, y) => (x.r ?? Infinity) - (y.r ?? Infinity) || x.i - y.i)
    .map((x) => x.item);
}

/** Places room `from` before (or after) `to` within `shown` list (ids in visual order) and persists. */
export function moveRoom(shown: readonly string[], from: string, to: string, after: boolean): boolean {
  if (from === to || !shown.includes(from) || !shown.includes(to)) return false;
  const rest = shown.filter((id) => id !== from);
  rest.splice(rest.indexOf(to) + (after ? 1 : 0), 0, from);
  // Saved rooms not currently shown (closed or filtered out) preserve relative order at the end
  const old = loadOrder().filter((id) => !rest.includes(id));
  saveOrder([...rest, ...old].slice(0, MAX_ROOMS));
  return true;
}

function loadOrder(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(ORDER_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveOrder(ids: string[]): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
  } catch {
    // storage unavailable: order persists only until page reload
  }
}
