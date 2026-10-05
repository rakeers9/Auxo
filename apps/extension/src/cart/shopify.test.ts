import { CartSchema } from "@auxo/shared";
import { describe, expect, it } from "vitest";

import { hashCart } from "./hash";
import { isLikelyShopify, readShopifyCart, shopifyPageType } from "./shopify";
// Real responses fetched today, sanitized (token, ids, images, urls removed).
// allbirds-cart.json is an anonymous cart: one variant, quantity 2.
import cartText from "./__fixtures__/shopify/allbirds-cart.json?raw";
import emptyCartText from "./__fixtures__/shopify/allbirds-cart-empty.json?raw";
import headlessBody from "./__fixtures__/shopify/gymshark-cart-headless.html?raw";
import hintsHtml from "./__fixtures__/shopify/allbirds-product-hints.html?raw";
import amazonProductHtml from "./__fixtures__/amazon-product.html?raw";

const STORE_URL = new URL("https://www.allbirds.com/products/mens-canvas-runner-nz?variant=1");
const RUNNER = "Men's Canvas Runner NZ - Deep Navy Stripes (Blizzard Sole) - 8.5";

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

// A deep copy of the real cart JSON to change in one test.
function cartWith(change: (cart: Record<string, any>) => void): Record<string, any> {
  const cart = JSON.parse(cartText) as Record<string, any>;
  change(cart);
  return cart;
}

describe("isLikelyShopify", () => {
  it("is true on a classic Shopify storefront", () => {
    expect(isLikelyShopify(parse(hintsHtml))).toBe(true);
  });

  it.each<[string, (d: Document) => void]>([
    ["the wallet meta", (d) => { d.getElementById("shopify-features")?.remove(); d.querySelector("script:not([id])")?.remove(); }],
    ["the features script", (d) => { d.getElementById("shopify-digital-wallet")?.remove(); d.querySelector("script:not([id])")?.remove(); }],
    ["the inline Shopify.shop global", (d) => { d.getElementById("shopify-digital-wallet")?.remove(); d.getElementById("shopify-features")?.remove(); }],
  ])("needs only one signal: %s", (_label, keepOne) => {
    const doc = parse(hintsHtml);
    keepOne(doc);
    expect(isLikelyShopify(doc)).toBe(true);
  });

  it("is false on a headless Shopify store's page and on Amazon", () => {
    expect(isLikelyShopify(parse(headlessBody))).toBe(false);
    expect(isLikelyShopify(parse(amazonProductHtml))).toBe(false);
  });
});

describe("shopifyPageType", () => {
  it.each([
    ["https://www.allbirds.com/products/mens-canvas-runner-nz", "product"],
    ["https://www.allbirds.com/products/mens-canvas-runner-nz?variant=41884547022928", "product"],
    ["https://www.allbirds.com/collections/mens/products/mens-canvas-runner-nz", "product"],
    ["https://www.allbirds.com/cart", "cart"],
    ["https://www.allbirds.com/cart/", "cart"],
    ["https://www.allbirds.com/cart.js", "other"],
    ["https://www.allbirds.com/collections/mens", "other"],
    ["https://www.allbirds.com/", "other"],
  ])("%s is %s", (url, type) => {
    expect(shopifyPageType(new URL(url))).toBe(type);
  });
});

describe("readShopifyCart", () => {
  it("reads a real cart: plain-text name, per-unit price paid, quantity, items subtotal", () => {
    const reading = readShopifyCart(JSON.parse(cartText), STORE_URL);
    expect(reading.problems).toEqual([]);
    expect(reading.draft).toEqual({
      merchant: "www.allbirds.com",
      items: [{ name: RUNNER, price_minor: 10000, qty: 2 }],
      total_minor: 20000,
      currency: "USD",
      url: "https://www.allbirds.com/cart",
    });
    expect(reading.details).toEqual({
      currency: "USD",
      "items seen": "1",
      "items subtotal": "$200.00",
      "cart total": "$200.00",
      "items sum": "$200.00",
    });
  });

  it("builds the name from product_title, not the HTML-escaped title", () => {
    expect(JSON.parse(cartText).items[0].title).toContain("&#39;");
    expect(readShopifyCart(cartText, STORE_URL).draft?.items[0]?.name).toBe(RUNNER);
  });

  it("accepts the raw response body as a string", () => {
    expect(readShopifyCart(cartText, STORE_URL).draft).toEqual(readShopifyCart(JSON.parse(cartText), STORE_URL).draft);
  });

  it("leaves the variant off a product with only the default variant", () => {
    const cart = cartWith((c) => {
      c.items[0].product_has_only_default_variant = true;
      c.items[0].variant_title = null;
    });
    expect(readShopifyCart(cart, STORE_URL).draft?.items[0]?.name).toBe("Men's Canvas Runner NZ - Deep Navy Stripes (Blizzard Sole)");
  });

  it("uses the price after a line discount (final_price), not the original price", () => {
    // No public store showed a line discount, so this changes the real cart the
    // way Shopify reports one: price stays, final_* drop, the subtotal follows.
    const cart = cartWith((c) => {
      Object.assign(c.items[0], { final_price: 9000, final_line_price: 18000, line_level_total_discount: 2000 });
      c.items_subtotal_price = 18000;
    });
    const draft = readShopifyCart(cart, STORE_URL).draft;
    expect(draft?.items[0]).toEqual({ name: RUNNER, price_minor: 9000, qty: 2 });
    expect(draft?.total_minor).toBe(18000);
  });

  it("reads another 2-decimal currency", () => {
    const draft = readShopifyCart(cartWith((c) => { c.currency = "EUR"; }), new URL("https://shop.example.de/cart"));
    expect(draft.draft?.currency).toBe("EUR");
    expect(draft.draft?.merchant).toBe("shop.example.de");
  });

  describe("returns null instead of guessing", () => {
    it("for the real empty cart", () => {
      expect(readShopifyCart(JSON.parse(emptyCartText), STORE_URL)).toEqual({
        draft: null,
        problems: ["the cart is empty"],
        details: { currency: "USD", "items seen": "0", "items subtotal": "$0.00", "cart total": "$0.00" },
      });
    });

    it("for a headless store, whose /cart.js is an HTML page", () => {
      expect(readShopifyCart(headlessBody, STORE_URL)).toEqual({
        draft: null,
        problems: ["no Shopify cart API on this site"],
        details: { response: "not JSON" },
      });
    });

    it.each<[string, unknown]>([
      ["malformed JSON", '{"items": ['],
      ["JSON that isn't a cart", { products: [] }],
      ["a cart missing items_subtotal_price", cartWith((c) => { delete c.items_subtotal_price; })],
      ["null", null],
    ])("for %s", (_label, response) => {
      const reading = readShopifyCart(response, STORE_URL);
      expect(reading.draft).toBeNull();
      expect(reading.problems).toEqual(["no Shopify cart API on this site"]);
    });

    it("when the lines don't add up to items_subtotal_price", () => {
      expect(readShopifyCart(cartWith((c) => { c.items_subtotal_price = 19999; }), STORE_URL).problems).toEqual([
        "items sum $200.00 but the cart's items_subtotal_price says $199.99",
      ]);
    });

    it("when a line's final_price x qty isn't its final_line_price (uneven discount split)", () => {
      expect(readShopifyCart(cartWith((c) => { c.items[0].final_line_price = 19999; }), STORE_URL).problems).toEqual([
        "item 1: final_price 10000 x 2 doesn't equal final_line_price 19999",
      ]);
    });

    it("for a currency without 2 decimals", () => {
      expect(readShopifyCart(cartWith((c) => { c.currency = "JPY"; }), STORE_URL).problems).toEqual([
        "currency JPY isn't supported yet (only 2-decimal currencies are verified)",
      ]);
    });
  });

  it("the extracted cart plus its hash is a valid Cart", async () => {
    const draft = readShopifyCart(cartText, STORE_URL).draft;
    expect(draft).not.toBeNull();
    expect(CartSchema.safeParse({ ...draft!, cart_hash: await hashCart(draft!) }).success).toBe(true);
  });
});
