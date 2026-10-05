import type { CartItem } from "@auxo/shared";

// Remembers recent decisions and the cart each one was about, so that:
// - a later removal (e.g. from the cart sidebar on another page or tab) can
//   be linked to the decision about that item, and
// - "Save for later" can put that decision's items on the wishlist, even
//   when the answer was shown on a different page than the one that asked.
// Kept in the worker's session storage because the worker's memory is wiped
// when it goes idle. Bounded, newest first.
export const DECISION_MEMORY_LIMIT = 50;
const KEY = "auxo:decision-memory";

export interface RememberedCart {
  merchant: string;
  currency: string;
  url: string;
  items: CartItem[];
}

interface Remembered {
  decisionId: string;
  cart: RememberedCart;
}

export interface KeyValueArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface DecisionMemory {
  remember(decisionId: string, cart: RememberedCart): Promise<void>;
  // The most recent decision whose cart included any of these items
  // (matched by name and unit price, the identity removedItems uses).
  decisionFor(items: Array<Pick<CartItem, "name" | "price_minor">>): Promise<string | null>;
  // The cart a decision was about, if it's still remembered.
  cartFor(decisionId: string): Promise<RememberedCart | null>;
}

export function createDecisionMemory(area: KeyValueArea, limit = DECISION_MEMORY_LIMIT): DecisionMemory {
  // Serialize writes so two quick decisions can't overwrite each other.
  let queue: Promise<unknown> = Promise.resolve();

  const load = async (): Promise<Remembered[]> => {
    try {
      const value = (await area.get(KEY))[KEY];
      return Array.isArray(value) ? value.filter(isRemembered) : [];
    } catch {
      return [];
    }
  };

  return {
    remember(decisionId, cart) {
      const next = queue.then(async () => {
        const list = (await load()).filter((entry) => entry.decisionId !== decisionId);
        list.unshift({
          decisionId,
          cart: {
            merchant: cart.merchant,
            currency: cart.currency,
            url: cart.url,
            items: cart.items.map(({ name, price_minor, qty }) => ({ name, price_minor, qty })),
          },
        });
        try {
          await area.set({ [KEY]: list.slice(0, limit) });
        } catch {
          // Best effort: losing the link only loses attribution.
        }
      });
      queue = next.catch(() => {});
      return next.catch(() => {});
    },

    async decisionFor(items) {
      await queue;
      const wanted = new Set(items.map((item) => key(item)));
      const match = (await load()).find((entry) => entry.cart.items.some((item) => wanted.has(key(item))));
      return match?.decisionId ?? null;
    },

    async cartFor(decisionId) {
      await queue;
      return (await load()).find((entry) => entry.decisionId === decisionId)?.cart ?? null;
    },
  };
}

function key(item: Pick<CartItem, "name" | "price_minor">): string {
  return JSON.stringify([item.name, item.price_minor]);
}

function isRemembered(value: unknown): value is Remembered {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { decisionId?: unknown; cart?: unknown };
  if (typeof entry.decisionId !== "string" || typeof entry.cart !== "object" || entry.cart === null) return false;
  const cart = entry.cart as Partial<Record<keyof RememberedCart, unknown>>;
  return (
    typeof cart.merchant === "string" &&
    typeof cart.currency === "string" &&
    typeof cart.url === "string" &&
    Array.isArray(cart.items) &&
    cart.items.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as CartItem).name === "string" &&
        Number.isSafeInteger((item as CartItem).price_minor) &&
        Number.isSafeInteger((item as CartItem).qty),
    )
  );
}
