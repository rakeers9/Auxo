import type { CartDraft } from "../messages";
import { removedItems } from "./removal";
import type { MiniCartDiff } from "./sidesheet";

export const CART_API_DEBOUNCE_MS = 500;

export interface CartApiWatch {
  // Re-read now (e.g. right after an add-to-cart click). Resolves once read.
  refresh(): Promise<void>;
  // The last good reading, if any.
  current(): CartDraft | null;
  stop(): void;
}

// For stores whose cart is read over the network (Shopify's /cart.js) rather
// than from the page: re-reads after the page settles from a change (themes
// update their cart drawer or count in place) and reports what was added or
// removed since the last good reading. Reads never overlap: a change during a
// read triggers one more read after it. A failed (null) read never fires and
// never replaces the last good one, like watchMiniCart.
export function watchCartApi(
  doc: Document,
  load: () => Promise<CartDraft | null>,
  handlers: { onChange(before: CartDraft, after: CartDraft, diff: MiniCartDiff): void },
  options: { debounceMs?: number; ignore?: () => Array<Node | null | undefined> } = {},
): CartApiWatch {
  const debounceMs = options.debounceMs ?? CART_API_DEBOUNCE_MS;
  let baseline: CartDraft | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const readOnce = async () => {
    const after = await load().catch(() => null);
    if (stopped || !after) return;
    const before = baseline;
    baseline = after;
    if (!before) return;
    const diff: MiniCartDiff = { removed: removedItems(before, after), added: removedItems(after, before) };
    if (diff.removed.length === 0 && diff.added.length === 0) return;
    try {
      handlers.onChange(before, after, diff);
    } catch {
      // Tracking must never break the page.
    }
  };

  const refresh = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await readOnce();
      } while (again && !stopped);
    })().finally(() => {
      running = null;
    });
    return running;
  };

  const observer = new MutationObserver((mutations) => {
    const ignored = (options.ignore?.() ?? []).filter((node): node is Node => node != null);
    if (ignored.length > 0 && mutations.every((m) => ignored.some((node) => node.contains(m.target)))) return;
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), debounceMs);
  });
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, characterData: true });
  void refresh(); // the baseline

  return {
    refresh,
    current: () => baseline,
    stop() {
      stopped = true;
      observer.disconnect();
      clearTimeout(timer);
    },
  };
}
