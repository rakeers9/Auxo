import { CartSchema, UserActionSchema } from "@auxo/shared";
import { describe, expect, it } from "vitest";

import type { CartDraft, ExitAction } from "./messages";

describe("extension message types", () => {
  it("a CartDraft plus a hash is a valid Cart", () => {
    const draft: CartDraft = {
      merchant: "amazon.com",
      items: [{ name: "Desk lamp", price_minor: 2499, qty: 1 }],
      total_minor: 2499,
      currency: "USD",
      url: "https://www.amazon.com/gp/cart/view.html",
    };
    expect(CartSchema.safeParse({ ...draft, cart_hash: "a".repeat(64) }).success).toBe(true);
  });

  it("every exit action is a valid API user action", () => {
    const actions: ExitAction[] = ["left", "saved", "overrode"];
    for (const action of actions) {
      expect(UserActionSchema.safeParse(action).success).toBe(true);
    }
  });
});
