import { CartItemSchema, CartSchema } from "@auxo/shared";

import type { CartChange, CartDraft } from "../messages";
import { removedItems } from "../tracking/removal";
import type { KeyValueArea } from "./decision-memory";

// The last cart the extension knows for each merchant, kept in the worker's
// storage.local so it survives restarts. Every fresh page load compares its
// cart with it, which catches changes made in another tab or outside Auxo
// (the store's app, another device). Only fresh page loads may compare:
// other tabs' DOM isn't updated by the store, so re-reading on tab focus
// would read a stale cart and report changes backwards.
export const CART_STATE_KEY = "auxo:cart-state";

// Like the shared Cart, minus cart_hash, and an empty cart is allowed (it
// can be emptied elsewhere).
const CartSnapshotSchema = CartSchema.omit({ cart_hash: true }).extend({
  items: CartItemSchema.array().max(250),
});

export interface CartState {
  // This tab saw this cart and already reported any change: store it, no diff.
  record(merchant: string, cart: CartDraft): Promise<void>;
  // A fresh page-load reading. Returns what changed since the last known
  // cart (including a price-only change), or null if nothing did or there was
  // none. Stores the new cart.
  compareAtLoad(merchant: string, cart: CartDraft): Promise<CartChange | null>;
}

// Never throws: broken storage or bad data reads as "nothing known", and a
// failed write is ignored. Writes are serialized so two tabs loading at once
// are compared one after the other.
export function createCartState(area: KeyValueArea): CartState {
  let queue: Promise<unknown> = Promise.resolve();

  const load = async (): Promise<Record<string, CartDraft>> => {
    try {
      const value = (await area.get(CART_STATE_KEY))[CART_STATE_KEY];
      if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
      const carts: Record<string, CartDraft> = {};
      for (const [merchant, cart] of Object.entries(value)) {
        const parsed = parseCartDraft(cart);
        if (parsed) carts[merchant] = parsed;
      }
      return carts;
    } catch {
      return {};
    }
  };

  // One read-compare-write at a time.
  const run = <T>(step: (carts: Record<string, CartDraft>) => { carts: Record<string, CartDraft>; result: T }, fallback: T) => {
    const next = queue.then(async () => {
      const { carts, result } = step(await load());
      try {
        await area.set({ [CART_STATE_KEY]: carts });
      } catch {
        // Best effort: the next load compares against the older cart.
      }
      return result;
    });
    queue = next.catch(() => {});
    return next.catch(() => fallback);
  };

  return {
    async record(merchant, cart) {
      const parsed = parseCartDraft(cart);
      if (!merchant || !parsed) return;
      await run((carts) => ({ carts: { ...carts, [merchant]: parsed }, result: undefined }), undefined);
    },

    async compareAtLoad(merchant, cart) {
      const after = parseCartDraft(cart);
      if (!merchant || !after) return null;
      return run<CartChange | null>((carts) => {
        const before = carts[merchant];
        const next = { carts: { ...carts, [merchant]: after } };
        if (!before) return { ...next, result: null };
        const diff = diffCarts(before, after);
        const changed = diff.removed.length > 0 || diff.added.length > 0 || diff.repriced.length > 0;
        return { ...next, result: changed ? { before, after, diff } : null };
      }, null);
    },
  };
}

// What changed between two readings of a whole cart. Lines are matched by
// name first: carts compared hours or days apart often see price changes, and
// a new price on the same item is not a removal plus an add. A name that
// appears more than once in either cart (e.g. variants sharing a title) falls
// back to matching by name and unit price, so nothing is guessed.
export function diffCarts(before: CartDraft, after: CartDraft): CartChange["diff"] {
  const beforeLines = linesByName(before);
  const afterLines = linesByName(after);
  const repriced: CartChange["diff"]["repriced"] = [];
  // name -> [before price, after price] for items that only changed price.
  const prices = new Map<string, [number, number]>();
  for (const [name, [was, ...moreWas]] of beforeLines) {
    const [now, ...moreNow] = afterLines.get(name) ?? [];
    if (was === undefined || now === undefined || moreWas.length > 0 || moreNow.length > 0 || was === now) continue;
    prices.set(name, [was, now]);
    repriced.push({ name, before_minor: was, after_minor: now });
  }

  // Give a repriced line the other reading's price so removedItems sees one
  // item, and report each side at the price it had then.
  const withPrice = (cart: CartDraft, side: 0 | 1): CartDraft => ({
    ...cart,
    items: cart.items.map((item) => {
      const pair = prices.get(item.name);
      return pair ? { ...item, price_minor: pair[side] } : item;
    }),
  });
  return {
    removed: removedItems(before, withPrice(after, 0)),
    added: removedItems(after, withPrice(before, 1)),
    repriced,
  };
}

function linesByName(cart: CartDraft): Map<string, number[]> {
  const lines = new Map<string, number[]>();
  for (const item of cart.items) lines.set(item.name, [...(lines.get(item.name) ?? []), item.price_minor]);
  return lines;
}

// A cart from storage or a message, checked, or null.
export function parseCartDraft(value: unknown): CartDraft | null {
  const parsed = CartSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
