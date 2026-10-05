import type { Cart, DecisionEvent, Trigger, TriggerIntent, Verdict } from "@auxo/shared";

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
