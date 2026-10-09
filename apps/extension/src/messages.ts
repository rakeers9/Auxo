import type { Cart, CartItem, DecisionEvent, StoreOverrides, Trigger, TriggerIntent, Verdict } from "@auxo/shared";

// Content script -> background worker: ask the API for a verdict on this cart.
export interface DecideMessage {
  type: "auxo:decide";
  cart: Cart;
  trigger?: Trigger;
}

// Background worker -> content script. Any failure is reported, never thrown,
// so the caller can fail open.
export type DecideFailureReason = "timeout" | "network" | "http" | "invalid_response" | "invalid_cart";

export type DecideResult =
  | { ok: true; verdict: Verdict }
  | { ok: false; reason: DecideFailureReason };

// A cart before hashing: every Cart field except cart_hash.
export type CartDraft = Omit<Cart, "cart_hash">;

// What the user chose on the overlay. Matches the API's UserAction values.
export type ExitAction = "left" | "saved" | "overrode";

// Content script -> background worker: log an overlay exit to /v1/events.
// The worker re-validates `event` against DecisionEventSchema.
export interface EventMessage {
  type: "auxo:event";
  event: DecisionEvent;
}

// Background worker -> content script. Like DecideResult, failures are
// reported, never thrown.
export type EventFailureReason = "timeout" | "network" | "http" | "invalid_response" | "invalid_event";

export type EventResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; reason: EventFailureReason };

// The kinds of page the readers recognize. added_to_cart is Amazon's
// "Added to cart" page (/cart/smart-wagon) that follows an add to cart.
export type PageType = "product" | "cart" | "checkout" | "added_to_cart" | "other";

// What the extension read from a page, for the dev debug panel. `problems`
// explains in plain English why `draft` is null.
export interface PageInspection {
  pageType: PageType;
  draft: CartDraft | null;
  problems: string[];
  details?: Record<string, string>;
}

// A buy-intent click or form submit, as classified by src/clicks.
// known: a store button verified on real pages; guess: generic signals.
export interface ClickSignal {
  intent: Exclude<TriggerIntent, "page_view">;
  source: "known" | "guess";
  label?: string;
}

// Content script -> worker: this page received the answer to its own request,
// so the worker shouldn't hand it to the next page (see src/api/handoff.ts).
export interface AckMessage {
  type: "auxo:ack";
  decisionId: string;
}

// Content script -> worker, on page load: is there an add-to-cart answer the
// previous page in this tab didn't get to show?
export interface ClaimMessage {
  type: "auxo:claim";
}

export interface ClaimResult {
  verdict: Verdict | null;
}

// Content script -> worker: which recent decision covered these items? Used
// to link a removal (e.g. from the cart sidebar) to the decision about it.
export interface DecisionForMessage {
  type: "auxo:decision-for";
  items: Array<{ name: string; price_minor: number }>;
}

export interface DecisionForResult {
  decisionId: string | null;
}

// Content script -> worker, on page load: the backend's overrides for this
// store (selectors, buttons, on/off), or null to use the bundled defaults.
export interface ConfigMessage {
  type: "auxo:config";
  host: string;
}

export interface ConfigResult {
  overrides: StoreOverrides | null;
}

// Content script -> worker: the user chose "Save for later" on this decision.
// The worker puts the decision's items on the wishlist (src/wishlist).
export interface WishlistSaveMessage {
  type: "auxo:wishlist-save";
  decisionId: string;
}

// Content script -> worker: this tab saw this cart and already reported any
// change in it, so the worker just remembers it (src/api/cart-state.ts).
// `items` may be empty: a cart can be emptied.
export interface CartRecordMessage {
  type: "auxo:cart-record";
  merchant: string;
  cart: CartDraft;
}

// Content script -> worker: the cart read on a fresh page load. The worker
// compares it with the last cart it knows for this merchant, which catches
// changes made in another tab or outside Auxo (e.g. the store's app).
export interface CartLoadMessage {
  type: "auxo:cart-load";
  merchant: string;
  cart: CartDraft;
}

export interface CartChange {
  before: CartDraft;
  after: CartDraft;
  diff: {
    // Items gone or with a lower quantity, at the price they had before.
    removed: CartItem[];
    // Items new or with a higher quantity, at their current price.
    added: CartItem[];
    // Items still in the cart at a new unit price. Information only: not a
    // removal or an add.
    repriced: Array<{ name: string; before_minor: number; after_minor: number }>;
  };
}

export interface CartLoadResult {
  change: CartChange | null;
}
