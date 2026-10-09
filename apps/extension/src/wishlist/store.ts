import type { KeyValueArea } from "../api/decision-memory";

// Items the user chose to save for later instead of buying, kept in
// storage.local so they survive browser restarts. Bounded, newest first.
export const WISHLIST_LIMIT = 200;
export const WISHLIST_KEY = "auxo:wishlist";

export interface WishlistEntry {
  id: string;
  name: string;
  // Unit price in minor units.
  price_minor: number;
  qty: number;
  currency: string;
  merchant: string;
  url: string;
  // The decision the item was saved from, if any.
  decision_id?: string;
  saved_at: string;
}

export type NewWishlistEntry = Omit<WishlistEntry, "id" | "saved_at">;

export interface Wishlist {
  // Saves items (the first ends up on top). Saving an item that's already on
  // the list (same merchant, name, and unit price) moves it to the top with
  // the new quantity and time. Returns the list after the change.
  add(entries: NewWishlistEntry[]): Promise<WishlistEntry[]>;
  // Returns the list after the change.
  remove(id: string): Promise<WishlistEntry[]>;
  // Newest first.
  list(): Promise<WishlistEntry[]>;
  clear(): Promise<void>;
}

export interface WishlistOptions {
  limit?: number;
  now?: () => Date;
  newId?: () => string;
}

// Never throws: broken storage reads as an empty list, and a failed write
// leaves the list as it was. Writes are serialized so two quick saves can't
// overwrite each other (within this context; the popup and the worker each
// have their own queue).
export function createWishlist(area: KeyValueArea, options: WishlistOptions = {}): Wishlist {
  const limit = options.limit ?? WISHLIST_LIMIT;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());
  let queue: Promise<unknown> = Promise.resolve();

  const load = async (): Promise<WishlistEntry[]> => {
    try {
      const value = (await area.get(WISHLIST_KEY))[WISHLIST_KEY];
      return Array.isArray(value) ? value.filter(isEntry) : [];
    } catch {
      return [];
    }
  };

  // Runs one read-change-write after the previous one finishes.
  const update = (change: (list: WishlistEntry[]) => WishlistEntry[]): Promise<WishlistEntry[]> => {
    const next = queue.then(async () => {
      const before = await load();
      const after = change(before).slice(0, limit);
      try {
        await area.set({ [WISHLIST_KEY]: after });
        return after;
      } catch {
        return before;
      }
    });
    queue = next.catch(() => {});
    return next.catch(() => [] as WishlistEntry[]);
  };

  return {
    add(entries) {
      return update((list) => {
        const savedAt = now().toISOString();
        let next = list;
        // Last to first, so the first entry ends up on top.
        for (const entry of [...entries].reverse()) {
          const existing = next.find((item) => sameItem(item, entry));
          // The newest decision wins; saving again without one keeps the old link.
          const decisionId = entry.decision_id ?? existing?.decision_id;
          const saved: WishlistEntry = {
            id: existing?.id ?? newId(),
            name: entry.name,
            price_minor: entry.price_minor,
            qty: entry.qty,
            currency: entry.currency,
            merchant: entry.merchant,
            url: entry.url,
            ...(decisionId ? { decision_id: decisionId } : {}),
            saved_at: savedAt,
          };
          if (!isEntry(saved)) continue;
          next = [saved, ...next.filter((item) => item !== existing)];
        }
        return next;
      });
    },

    remove(id) {
      return update((list) => list.filter((item) => item.id !== id));
    },

    async list() {
      await queue;
      return load();
    },

    async clear() {
      await update(() => []);
    },
  };
}

function sameItem(a: Pick<WishlistEntry, "merchant" | "name" | "price_minor">, b: Pick<WishlistEntry, "merchant" | "name" | "price_minor">): boolean {
  return a.merchant === b.merchant && a.name === b.name && a.price_minor === b.price_minor;
}

function isEntry(value: unknown): value is WishlistEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.name === "string" &&
    entry.name.length > 0 &&
    Number.isSafeInteger(entry.price_minor) &&
    (entry.price_minor as number) >= 0 &&
    Number.isSafeInteger(entry.qty) &&
    (entry.qty as number) >= 1 &&
    typeof entry.currency === "string" &&
    typeof entry.merchant === "string" &&
    typeof entry.url === "string" &&
    (entry.decision_id === undefined || typeof entry.decision_id === "string") &&
    typeof entry.saved_at === "string"
  );
}
