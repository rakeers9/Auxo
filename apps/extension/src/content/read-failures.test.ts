import { describe, expect, it, vi } from "vitest";

import type { ReadFailureMessage } from "../messages";
import { createReadFailureNotifier } from "./read-failures";

const PRICE = 'item 1 has no readable data-price: "8.982"';
const SUBTOTAL = "no subtotal (#sc-subtotal-amount-buybox) on the page";

describe("createReadFailureNotifier", () => {
  it("sends codes only, never the problem text", () => {
    const send = vi.fn<(m: ReadFailureMessage) => void>();
    createReadFailureNotifier(send)("amazon_cart", "cart", [PRICE, SUBTOTAL]);
    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: "auxo:read-failure",
      reader: "amazon_cart",
      page_type: "cart",
      codes: ["item.no_price", "total.missing"],
    });
    expect(JSON.stringify(send.mock.calls)).not.toContain("8.982");
  });

  it("sends each distinct failure once per page load", () => {
    const send = vi.fn();
    const notify = createReadFailureNotifier(send);
    notify("amazon_cart", "cart", [PRICE]);
    notify("amazon_cart", "cart", ['item 3 has no readable data-price: "other text"']);
    expect(send).toHaveBeenCalledTimes(1);
    notify("amazon_cart", "cart", [PRICE, SUBTOTAL]);
    notify("amazon_minicart", "cart", ['mini cart item 1 has no readable data-price: "8.982"']);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("sends nothing for a clean reading, an expected page state, or a page without a reader", () => {
    const send = vi.fn();
    const notify = createReadFailureNotifier(send);
    notify("amazon_cart", "cart", []);
    notify("amazon_cart", "cart", ["nothing is selected for checkout (2 items in the cart, none ticked)"]);
    notify("amazon_minicart", "other", ["the mini cart is empty or not loaded"]);
    notify(null, "other", ["not a product, added-to-cart, cart, or checkout page"]);
    expect(send).not.toHaveBeenCalled();
  });

  it("never throws when the worker can't be reached", () => {
    const notify = createReadFailureNotifier(() => {
      throw new Error("Extension context invalidated.");
    });
    expect(() => notify("amazon_cart", "cart", [PRICE])).not.toThrow();
  });
});
