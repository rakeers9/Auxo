import type { TriggerPageType } from "@auxo/shared";

import type { CartDraft, ClickSignal } from "../messages";

// A buy-intent click usually loads a new page, so it's remembered in the
// tab's sessionStorage (same origin, same tab) for the next page to use.
export const CLICK_MAX_AGE_MS = 30_000;
// The order confirmation page can take a while (payment checks, redirects).
export const PURCHASE_MAX_AGE_MS = 10 * 60_000;

const CLICK_KEY = "auxo:pending-click";
const PURCHASE_KEY = "auxo:pending-purchase";

export interface PendingClick {
  signal: ClickSignal;
  // The page the click happened on.
  pageType: TriggerPageType;
  at: string;
}

// Saved on a "Place your order" click, so the confirmation page can report
// what was bought and which decision it followed.
export interface PendingPurchase {
  decisionId: string;
  draft: CartDraft;
  at: string;
}

export interface PendingStore {
  saveClick(click: PendingClick): void;
  // Returns the click if it's fresh, and always clears it.
  takeClick(now: Date): PendingClick | null;
  savePurchase(purchase: PendingPurchase): void;
  takePurchase(now: Date): PendingPurchase | null;
}

// storage is null when sessionStorage is unavailable; then nothing is kept.
export function createPendingStore(storage: Storage | null): PendingStore {
  return {
    saveClick: (click) => write(storage, CLICK_KEY, click),
    takeClick: (now) => {
      const click = take(storage, CLICK_KEY);
      return isPendingClick(click) && isFresh(click.at, now, CLICK_MAX_AGE_MS) ? click : null;
    },
    savePurchase: (purchase) => write(storage, PURCHASE_KEY, purchase),
    takePurchase: (now) => {
      const purchase = take(storage, PURCHASE_KEY);
      return isPendingPurchase(purchase) && isFresh(purchase.at, now, PURCHASE_MAX_AGE_MS) ? purchase : null;
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

function isFresh(at: string, now: Date, maxAgeMs: number): boolean {
  const age = now.getTime() - Date.parse(at);
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
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
    typeof value.decisionId === "string" &&
    isObject(value.draft) &&
    Array.isArray(value.draft.items)
  );
}
