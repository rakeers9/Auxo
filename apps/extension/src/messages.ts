import type { Cart, DecisionEvent, Verdict } from "@auxo/shared";

// Content script -> background worker: ask the API for a verdict on this cart.
export interface DecideMessage {
  type: "auxo:decide";
  cart: Cart;
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

// What the extension read from a page, for the dev debug panel. `problems`
// explains in plain English why `draft` is null.
export interface PageInspection {
  pageType: "cart" | "checkout" | "other";
  draft: CartDraft | null;
  problems: string[];
  details?: Record<string, string>;
}
