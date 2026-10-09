import { CartSchema } from "@auxo/shared";
import { describe, expect, it } from "vitest";

import { extractAmazonCheckout, isAmazonCheckoutPage } from "./checkout";
import { hashCart } from "./hash";
// Sanitized copies of real amazon.com pages: only the item block and order
// summary are kept; address, payment, delivery, and purchase ids are removed.
import buyNowHtml from "./__fixtures__/amazon-checkout-buy-now.html?raw";
import fromCartHtml from "./__fixtures__/amazon-checkout-from-cart.html?raw";
import cartHtml from "./__fixtures__/amazon-cart.html?raw";
import emptyCartHtml from "./__fixtures__/amazon-cart-empty.html?raw";
import productHtml from "./__fixtures__/amazon-product.html?raw";

// Real checkout URL shape, with a made-up purchase id.
const CHECKOUT_URL = new URL("https://www.amazon.com/checkout/p/p-000-0000000-0000000/spc?pipelineType=Chewbacca&isBuyNow=1&referrer=spc");
const CART_URL = new URL("https://www.amazon.com/gp/cart/view.html");
const PRODUCT_URL = new URL("https://www.amazon.com/dp/B0TEST0005");

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("isAmazonCheckoutPage", () => {
  it.each(["spc", "address", "pay", "spc/place-order"])("is true on the %s step", (step) => {
    const url = new URL(`https://www.amazon.com/checkout/p/p-000-0000000-0000000/${step}`);
    expect(isAmazonCheckoutPage(url, parse(fromCartHtml))).toBe(true);
  });

  it("is false on the cart, empty cart, and product pages", () => {
    expect(isAmazonCheckoutPage(CART_URL, parse(cartHtml))).toBe(false);
    expect(isAmazonCheckoutPage(CART_URL, parse(emptyCartHtml))).toBe(false);
    expect(isAmazonCheckoutPage(PRODUCT_URL, parse(productHtml))).toBe(false);
  });

  it("is false off www.amazon.com, over http, or on a bare /checkout path", () => {
    const doc = parse(fromCartHtml);
    expect(isAmazonCheckoutPage(new URL("https://www.amazon.co.uk/checkout/p/p-1/spc"), doc)).toBe(false);
    expect(isAmazonCheckoutPage(new URL("http://www.amazon.com/checkout/p/p-1/spc"), doc)).toBe(false);
    expect(isAmazonCheckoutPage(new URL("https://www.amazon.com/checkout/p/p-1"), doc)).toBe(false);
    expect(isAmazonCheckoutPage(new URL("https://www.amazon.com/checkout"), doc)).toBe(false);
  });
});

describe("extractAmazonCheckout", () => {
  it("reads a checkout reached from the cart (qty > 1, two items)", () => {
    expect(extractAmazonCheckout(parse(fromCartHtml), CHECKOUT_URL)).toEqual({
      merchant: "amazon.com",
      items: [
        { name: "Ceramic coffee mug, 12 oz, matte black", price_minor: 999, qty: 3 },
        { name: "Wireless keyboard, full size", price_minor: 3999, qty: 1 },
      ],
      // Items subtotal ($69.96), not the order total with tax ($74.86).
      total_minor: 6996,
      currency: "USD",
      url: "https://www.amazon.com/checkout", // purchase id dropped
    });
  });

  it("reads a Buy Now checkout, using the price paid rather than the struck-through list price", () => {
    expect(extractAmazonCheckout(parse(buyNowHtml), CHECKOUT_URL)).toEqual({
      merchant: "amazon.com",
      items: [{ name: "Side table with charging station", price_minor: 12159, qty: 1 }],
      total_minor: 12159,
      currency: "USD",
      url: "https://www.amazon.com/checkout", // purchase id dropped
    });
  });

  it("never puts the purchase id (or the query) in the cart URL", () => {
    const url = new URL("https://www.amazon.com/checkout/p/p-123-4567890-1234567/spc?isBuyNow=1");
    const draft = extractAmazonCheckout(parse(buyNowHtml), url);
    expect(draft?.url).toBe("https://www.amazon.com/checkout");
    expect(JSON.stringify(draft)).not.toContain("4567890");
  });

  it("returns null on a step that doesn't show the items", () => {
    const address = new URL("https://www.amazon.com/checkout/p/p-000-0000000-0000000/address");
    expect(extractAmazonCheckout(parse(productHtml), address)).toBeNull();
  });

  it("returns null off checkout, even with checkout HTML", () => {
    expect(extractAmazonCheckout(parse(fromCartHtml), CART_URL)).toBeNull();
  });

  describe("returns null instead of guessing", () => {
    function checkoutWith(change: (doc: Document) => void): Document {
      const doc = parse(fromCartHtml);
      change(doc);
      return doc;
    }
    const firstItem = (doc: Document) => doc.querySelector(".lineitem-container")!;

    it("when the items don't add up to Amazon's items subtotal", () => {
      const doc = checkoutWith((d) => {
        firstItem(d).querySelector('fieldset[name="checkout-quantity-stepper"]')!.setAttribute("data-steppervalue", "2");
      });
      expect(extractAmazonCheckout(doc, CHECKOUT_URL)).toBeNull();
    });

    it("when the items subtotal row is missing", () => {
      const doc = checkoutWith((d) => d.querySelector('input[value="ITEMS_TAX_EXCLUSIVE"]')!.closest("li")!.remove());
      expect(extractAmazonCheckout(doc, CHECKOUT_URL)).toBeNull();
    });

    it("when a price, quantity, or name can't be read", () => {
      const breakers: Array<(d: Document) => void> = [
        (d) => firstItem(d).querySelector(".apex-price-to-pay-value .a-offscreen")!.remove(),
        (d) => firstItem(d).querySelector('fieldset[name="checkout-quantity-stepper"]')!.remove(),
        (d) => { firstItem(d).querySelector(".lineitem-title-text")!.textContent = " "; },
      ];
      for (const breakIt of breakers) expect(extractAmazonCheckout(checkoutWith(breakIt), CHECKOUT_URL)).toBeNull();
    });
  });

  it("every extracted checkout plus its hash is a valid Cart", async () => {
    for (const html of [fromCartHtml, buyNowHtml]) {
      const draft = extractAmazonCheckout(parse(html), CHECKOUT_URL);
      expect(draft).not.toBeNull();
      const cart = { ...draft!, cart_hash: await hashCart(draft!) };
      expect(CartSchema.safeParse(cart).success).toBe(true);
    }
  });
});
