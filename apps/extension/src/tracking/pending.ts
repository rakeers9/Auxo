import type { CartDraft, ClickSignal, PageType } from "../messages";

// A buy-intent click usually loads a new page, so it's remembered in the
// tab's sessionStorage (same origin, same tab, cleared when the tab closes)
// until a page reads it. There's no timer: the next page read uses it.

const CLICK_KEY = "auxo:pending-click";
const PURCHASE_KEY = "auxo:pending-purchase";

export interface PendingClick {
  signal: ClickSignal;
  // The page the click happened on.
  pageType: PageType;
  at: string;
}

// Saved on a "Place your order" click, so the confirmation page can report
// what was bought and which decision it followed (the place-order decision,
// else the checkout decision, else null). The next place-order click
// replaces it.
export interface PendingPurchase {
  decisionId: string | null;
  draft: CartDraft;
  at: string;
}

export interface PendingStore {
  saveClick(click: PendingClick): void;
  // Returns the remembered click, if any, and clears it.
  takeClick(): PendingClick | null;
  savePurchase(purchase: PendingPurchase): void;
  // Returns the remembered purchase, if any, and clears it.
  takePurchase(): PendingPurchase | null;
}

// storage is null when sessionStorage is unavailable; then nothing is kept.
export function createPendingStore(storage: Storage | null): PendingStore {
  return {
    saveClick: (click) => write(storage, CLICK_KEY, click),
    takeClick: () => {
      const click = take(storage, CLICK_KEY);
      return isPendingClick(click) ? click : null;
    },
    savePurchase: (purchase) => write(storage, PURCHASE_KEY, purchase),
    takePurchase: () => {
      const purchase = take(storage, PURCHASE_KEY);
      return isPendingPurchase(purchase) ? purchase : null;
    },
  };
}

function write(storage: Storage | null, key: string, value: unknown): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: tracking is best effort.
  }
}

function take(storage: Storage | null, key: string): unknown {
  try {
    const raw = storage?.getItem(key) ?? null;
    storage?.removeItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPendingClick(value: unknown): value is PendingClick {
  return (
    isObject(value) &&
    typeof value.at === "string" &&
    typeof value.pageType === "string" &&
    isObject(value.signal) &&
    typeof value.signal.intent === "string" &&
    typeof value.signal.source === "string"
  );
}

function isPendingPurchase(value: unknown): value is PendingPurchase {
  return (
    isObject(value) &&
    typeof value.at === "string" &&
    (typeof value.decisionId === "string" || value.decisionId === null) &&
    isObject(value.draft) &&
    Array.isArray(value.draft.items)
  );
}
