import { describe, expect, it, vi } from "vitest";

import type { RememberedCart } from "../api/decision-memory";
import { saveDecisionToWishlist } from "./save";

const cart: RememberedCart = {
  merchant: "amazon.com",
  currency: "USD",
  url: "https://www.amazon.com/dp/B0TEST0001",
  items: [
    { name: "Lamp", price_minor: 3399, qty: 1 },
    { name: "Mug", price_minor: 999, qty: 3 },
  ],
};

describe("saveDecisionToWishlist", () => {
  it("adds every item of the decision's cart, linked to the decision", async () => {
    const add = vi.fn().mockResolvedValue([]);
    const saved = await saveDecisionToWishlist("dec-1", { cartFor: async () => cart }, { add });

    expect(saved).toBe(2);
    expect(add).toHaveBeenCalledWith([
      { name: "Lamp", price_minor: 3399, qty: 1, currency: "USD", merchant: "amazon.com", url: cart.url, decision_id: "dec-1" },
      { name: "Mug", price_minor: 999, qty: 3, currency: "USD", merchant: "amazon.com", url: cart.url, decision_id: "dec-1" },
    ]);
  });

  it("does nothing for a decision that's no longer remembered", async () => {
    const add = vi.fn();
    expect(await saveDecisionToWishlist("gone", { cartFor: async () => null }, { add })).toBe(0);
    expect(add).not.toHaveBeenCalled();
  });
});
