import type { CartItem } from "@auxo/shared";

// Remembers which recent decisions covered which items, so a later removal
// (e.g. from the cart sidebar on another page or tab) can be linked to the
// decision about that item. Kept in the worker's session storage because the
// worker's memory is wiped when it goes idle. Bounded, newest first.
export const DECISION_MEMORY_LIMIT = 50;
const KEY = "auxo:decision-memory";

interface Remembered {
  decisionId: string;
  // [name, price_minor] pairs, the same identity removedItems uses.
  items: Array<[string, number]>;
}

export interface KeyValueArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface DecisionMemory {
  remember(decisionId: string, items: Array<Pick<CartItem, "name" | "price_minor">>): Promise<void>;
  // The most recent decision whose cart included any of these items.
  decisionFor(items: Array<Pick<CartItem, "name" | "price_minor">>): Promise<string | null>;
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
    remember(decisionId, items) {
      const next = queue.then(async () => {
        const list = (await load()).filter((entry) => entry.decisionId !== decisionId);
        list.unshift({ decisionId, items: items.map((item) => [item.name, item.price_minor]) });
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
      const wanted = new Set(items.map((item) => JSON.stringify([item.name, item.price_minor])));
      const match = (await load()).find((entry) => entry.items.some((pair) => wanted.has(JSON.stringify(pair))));
      return match?.decisionId ?? null;
    },
  };
}

function isRemembered(value: unknown): value is Remembered {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { decisionId?: unknown; items?: unknown };
  return (
    typeof entry.decisionId === "string" &&
    Array.isArray(entry.items) &&
    entry.items.every((pair) => Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "number")
  );
}
