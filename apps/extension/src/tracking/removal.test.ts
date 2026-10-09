import { describe, expect, it } from "vitest";

import type { CartDraft } from "../messages";
import { removedItems } from "./removal";

function cart(items: CartDraft["items"]): CartDraft {
  return {
    merchant: "amazon.com",
    items,
    total_minor: items.reduce((sum, item) => sum + item.price_minor * item.qty, 0),
    currency: "USD",
    url: "https://www.amazon.com/gp/cart/view.html",
  };
}

const mug = { name: "Mug", price_minor: 999, qty: 3 };
const lamp = { name: "Lamp", price_minor: 3399, qty: 1 };

describe("removedItems", () => {
  it("finds an item that was removed", () => {
    expect(removedItems(cart([mug, lamp]), cart([mug]))).toEqual([{ name: "Lamp", price_minor: 3399, qty: 1 }]);
  });

  it("finds a lowered quantity", () => {
    expect(removedItems(cart([mug, lamp]), cart([{ ...mug, qty: 1 }, lamp]))).toEqual([
      { name: "Mug", price_minor: 999, qty: 2 },
    ]);
  });

  it("ignores additions, higher quantities, and reordering", () => {
    expect(removedItems(cart([mug]), cart([lamp, { ...mug, qty: 5 }]))).toEqual([]);
  });

  it("treats a price change as a different item", () => {
    expect(removedItems(cart([mug]), cart([{ ...mug, price_minor: 899 }]))).toEqual([mug]);
  });

  it("handles the same item listed twice", () => {
    const before = cart([{ ...mug, qty: 1 }, { ...mug, qty: 1 }]);
    expect(removedItems(before, cart([{ ...mug, qty: 1 }]))).toEqual([{ name: "Mug", price_minor: 999, qty: 1 }]);
  });
});
