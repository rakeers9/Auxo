import type { CartDraft } from "../messages";

export interface RemovedItem {
  name: string;
  price_minor: number;
  qty: number;
}

// What left the cart between two readings: items that disappeared, or whose
// quantity went down. Items are matched by name and unit price.
export function removedItems(before: CartDraft, after: CartDraft): RemovedItem[] {
  const remaining = new Map<string, number>();
  for (const item of after.items) {
    const key = itemKey(item);
    remaining.set(key, (remaining.get(key) ?? 0) + item.qty);
  }

  const removed: RemovedItem[] = [];
  for (const item of before.items) {
    const key = itemKey(item);
    const left = remaining.get(key) ?? 0;
    const gone = item.qty - Math.min(item.qty, left);
    remaining.set(key, Math.max(0, left - item.qty));
    if (gone > 0) removed.push({ name: item.name, price_minor: item.price_minor, qty: gone });
  }
  return removed;
}

function itemKey(item: { name: string; price_minor: number }): string {
  return JSON.stringify([item.name, item.price_minor]);
}
