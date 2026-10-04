import type { Cart, Verdict } from "@auxo/shared";

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
