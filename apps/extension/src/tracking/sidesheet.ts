import type { CartDraft } from "../messages";
import { removedItems, type RemovedItem } from "./removal";

// Amazon's nav cart flyout. On wide product pages it stays open as a sidebar
// listing the whole cart, with +/- and delete controls per item (seen on a
// real saved product page). Removing an item there doesn't reload the page.
export const MINI_CART = "#nav-flyout-ewc";

export const MINI_CART_DEBOUNCE_MS = 500;

export interface MiniCartDiff {
  // Items gone or with a lower quantity.
  removed: RemovedItem[];
  // Items new to the cart or with a higher quantity (e.g. the + stepper).
  added: RemovedItem[];
}

export interface MiniCartHandlers {
  onChange(before: CartDraft, after: CartDraft, diff: MiniCartDiff): void;
}

// Watches the mini cart and reports what changed between two good readings.
// `read` returns the cart in the flyout, or null when it can't be read
// reliably (still rendering, or not adding up). A null reading never fires and
// never replaces the last good one, so a change is always measured from a cart
// we trust. The flyout may be added after load, so the whole body is
// observed, but only changes inside the flyout (or the flyout appearing)
// trigger a re-read. Returns a function that stops watching.
export function watchMiniCart(
  doc: Document,
  read: () => CartDraft | null,
  handlers: MiniCartHandlers,
  options: { debounceMs?: number; selector?: string } = {},
): () => void {
  const selector = options.selector ?? MINI_CART;
  const debounceMs = options.debounceMs ?? MINI_CART_DEBOUNCE_MS;
  let baseline = safeRead(read);
  let scope = doc.querySelector(selector);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const check = () => {
    const after = safeRead(read);
    if (!after) return;
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

  const observer = new MutationObserver((mutations) => {
    const current = doc.querySelector(selector);
    const appeared = current !== scope;
    scope = current;
    if (!appeared && !(current && mutations.some((mutation) => current.contains(mutation.target)))) return;

    clearTimeout(timer);
    timer = setTimeout(check, debounceMs);
  });
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, characterData: true });

  return () => {
    observer.disconnect();
    clearTimeout(timer);
  };
}

function safeRead(read: () => CartDraft | null): CartDraft | null {
  try {
    return read();
  } catch {
    return null;
  }
}
