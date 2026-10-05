import { CartSchema } from "@auxo/shared";
import { describe, expect, it } from "vitest";

import { extractAmazonCart, isAmazonCartPage } from "./amazon";
import { hashCart } from "./hash";
// Sanitized copies of real amazon.com pages (product names and IDs replaced).
import cartHtml from "./__fixtures__/amazon-cart.html?raw";
import emptyCartHtml from "./__fixtures__/amazon-cart-empty.html?raw";
import productHtml from "./__fixtures__/amazon-product.html?raw";
import savedItemCartHtml from "./__fixtures__/amazon-cart-saved-item.html?raw";

const CART_URL = new URL("https://www.amazon.com/gp/cart/view.html");
const PRODUCT_URL = new URL("https://www.amazon.com/dp/B0TEST0005");

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

const mug = { name: "Ceramic coffee mug, 12 oz, matte black", price_minor: 999, qty: 3 };
const cable = { name: "USB-C charging cable, 6 ft, braided", price_minor: 999, qty: 1 };
const speaker = { name: "Portable Bluetooth speaker, waterproof", price_minor: 5289, qty: 1 };
const lamp = { name: "LED desk lamp with adjustable arm", price_minor: 3399, qty: 1 };

describe("isAmazonCartPage", () => {
  it("is true on the cart page", () => {
    expect(isAmazonCartPage(CART_URL, parse(cartHtml))).toBe(true);
  });

  it("is true on an empty cart page", () => {
    expect(isAmazonCartPage(CART_URL, parse(emptyCartHtml))).toBe(true);
  });

  it("is false on a product page, even though its nav flyout lists the cart items", () => {
    const doc = parse(productHtml);
    expect(doc.querySelectorAll('#nav-flyout-ewc [data-itemtype="active"]').length).toBe(4);
    expect(isAmazonCartPage(PRODUCT_URL, doc)).toBe(false);
  });

  it("is false off www.amazon.com or over http", () => {
    const doc = parse(cartHtml);
    expect(isAmazonCartPage(new URL("https://www.amazon.co.uk/gp/cart/view.html"), doc)).toBe(false);
    expect(isAmazonCartPage(new URL("https://amazon.com.evil.example/gp/cart/view.html"), doc)).toBe(false);
    expect(isAmazonCartPage(new URL("http://www.amazon.com/gp/cart/view.html"), doc)).toBe(false);
  });
});

describe("extractAmazonCart", () => {
  it("reads every active item, with unit prices and quantities", () => {
    expect(extractAmazonCart(parse(cartHtml), CART_URL)).toEqual({
      merchant: "amazon.com",
      items: [mug, cable, speaker, lamp],
      total_minor: 12684,
      currency: "USD",
      url: "https://www.amazon.com/gp/cart/view.html",
    });
  });

  it("keeps qty > 1 as one line with a unit price", () => {
    const cart = extractAmazonCart(parse(cartHtml), CART_URL);
    expect(cart?.items[0]).toEqual({ name: mug.name, price_minor: 999, qty: 3 });
  });

  it("excludes an item just moved to Saved for Later", () => {
    const doc = parse(savedItemCartHtml);
    // The saved item still sits in the active list, marked removed, and in the saved list.
    expect(doc.querySelector('#sc-active-cart [data-asin="B0TEST0001"]')?.getAttribute("data-removed")).toBe("true");
    expect(doc.querySelector('#sc-saved-cart [data-asin="B0TEST0001"]')).not.toBeNull();

    expect(extractAmazonCart(doc, CART_URL)).toEqual({
      merchant: "amazon.com",
      items: [cable, speaker, lamp],
      total_minor: 9687,
      currency: "USD",
      url: "https://www.amazon.com/gp/cart/view.html",
    });
  });

  it("returns an empty draft for a verifiably empty cart", () => {
    // Real page right after the last item was saved for later: no live items
    // (one line marked removed), no subtotal, nav cart count "0".
    const doc = parse(emptyCartHtml);
    expect(doc.querySelector("#sc-subtotal-amount-buybox")).toBeNull();
    expect(doc.getElementById("nav-cart-count")?.textContent?.trim()).toBe("0");
    expect(extractAmazonCart(doc, CART_URL)).toEqual({
      merchant: "amazon.com",
      items: [],
      total_minor: 0,
      currency: "USD",
      url: "https://www.amazon.com/gp/cart/view.html",
    });
  });

  it.each<[string, (d: Document) => void]>([
    ["the nav count isn't 0", (d) => { d.getElementById("nav-cart-count")!.textContent = "6"; }],
    ["the nav count is missing", (d) => d.getElementById("nav-cart-count")!.remove()],
    ["a subtotal is still shown", (d) => { d.getElementById("sc-active-cart")!.insertAdjacentHTML("beforeend", '<span id="sc-subtotal-amount-buybox">$33.99</span>'); }],
  ])("returns null for an empty-looking cart when %s", (_label, change) => {
    const doc = parse(emptyCartHtml);
    change(doc);
    expect(extractAmazonCart(doc, CART_URL)).toBeNull();
  });

  it("returns null on a non-cart page", () => {
    expect(extractAmazonCart(parse(productHtml), PRODUCT_URL)).toBeNull();
  });

  it("drops the query string from the URL", () => {
    const url = new URL("https://www.amazon.com/gp/cart/view.html?ref_=nav_cart&session=abc");
    expect(extractAmazonCart(parse(cartHtml), url)?.url).toBe("https://www.amazon.com/gp/cart/view.html");
  });

  describe("returns null instead of guessing", () => {
    function cartWith(change: (doc: Document) => void): Document {
      const doc = parse(cartHtml);
      change(doc);
      return doc;
    }
    const firstItem = (doc: Document) => doc.querySelector('#sc-active-cart [data-asin="B0TEST0001"]')!;

    it("when the items don't add up to Amazon's subtotal", () => {
      const doc = cartWith((d) => firstItem(d).setAttribute("data-price", "10.99"));
      expect(extractAmazonCart(doc, CART_URL)).toBeNull();
    });

    it("when the subtotal is missing", () => {
      const doc = cartWith((d) => d.getElementById("sc-subtotal-amount-buybox")!.remove());
      expect(extractAmazonCart(doc, CART_URL)).toBeNull();
    });

    it("when a price can't be parsed", () => {
      const doc = cartWith((d) => firstItem(d).setAttribute("data-price", "see price in cart"));
      expect(extractAmazonCart(doc, CART_URL)).toBeNull();
    });

    it("when a quantity is missing or not a positive integer", () => {
      for (const value of [null, "0", "1.5", "three"]) {
        const doc = cartWith((d) =>
          value === null ? firstItem(d).removeAttribute("data-quantity") : firstItem(d).setAttribute("data-quantity", value),
        );
        expect(extractAmazonCart(doc, CART_URL)).toBeNull();
      }
    });

    it("when an item has no name", () => {
      const doc = cartWith((d) => {
        firstItem(d).removeAttribute("data-producttitle");
        firstItem(d).querySelector(".sc-product-title .a-truncate-full")!.textContent = "";
      });
      expect(extractAmazonCart(doc, CART_URL)).toBeNull();
    });
  });

  it("falls back to the visible title when the title attribute is missing", () => {
    const doc = parse(cartHtml);
    doc.querySelector('[data-asin="B0TEST0001"]')!.removeAttribute("data-producttitle");
    expect(extractAmazonCart(doc, CART_URL)?.items[0]?.name).toBe(mug.name);
  });

  it("every extracted cart plus its hash is a valid Cart", async () => {
    for (const html of [cartHtml, savedItemCartHtml]) {
      const draft = extractAmazonCart(parse(html), CART_URL);
      expect(draft).not.toBeNull();
      const cart = { ...draft!, cart_hash: await hashCart(draft!) };
      expect(CartSchema.safeParse(cart).success).toBe(true);
    }
  });
});
