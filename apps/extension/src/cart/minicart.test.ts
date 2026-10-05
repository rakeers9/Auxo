import { CartSchema } from "@auxo/shared";
import { describe, expect, it } from "vitest";

import { hashCart } from "./hash";
import { readAmazonMiniCart } from "./minicart";
// Sanitized copies of real amazon.com pages (product names and IDs replaced).
// amazon-product-minicart.html was saved right after removing an item from the
// nav mini cart, so it holds one removed line.
import minicartHtml from "./__fixtures__/amazon-product-minicart.html?raw";
import addedHtml from "./__fixtures__/amazon-added-to-cart.html?raw";
import productHtml from "./__fixtures__/amazon-product.html?raw";
import cartHtml from "./__fixtures__/amazon-cart.html?raw";

const PRODUCT_URL = new URL("https://www.amazon.com/Water-Bottle/dp/B0TEST0006?th=1");

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function minicartWith(change: (doc: Document) => void): Document {
  const doc = parse(minicartHtml);
  change(doc);
  return doc;
}

const line = (d: Document, asin: string) => d.querySelector(`#nav-flyout-ewc .ewc-item[data-asin="${asin}"]`)!;
const subtotal = (d: Document) => d.querySelector("#nav-flyout-ewc .ewc-subtotal-amount")!;
const mug = { name: "Ceramic coffee mug, 12 oz, matte black", price_minor: 999, qty: 3 };
const keyboard = { name: "Wireless keyboard, full size", price_minor: 3999, qty: 1 };

describe("readAmazonMiniCart", () => {
  it("skips a line just removed from the mini cart (old price and qty, no data-removed)", () => {
    const doc = parse(minicartHtml);
    const removed = line(doc, "B0TEST0007");
    expect(removed.hasAttribute("data-removed")).toBe(false);
    expect(removed.getAttribute("data-price")).toBe("121.59");
    expect(removed.querySelector(".ewc-item-remove-msg")!.classList.contains("aok-hidden")).toBe(false);

    const reading = readAmazonMiniCart(doc, PRODUCT_URL);
    expect(reading.problems).toEqual([]);
    expect(reading.draft).toEqual({
      merchant: "amazon.com",
      items: [keyboard, mug],
      total_minor: 6996,
      currency: "USD",
      url: "https://www.amazon.com/gp/cart/view.html",
    });
    expect(reading.details).toEqual({
      "mini cart items": "3",
      "removed skipped": "1",
      "mini cart subtotal": '"$69.96"',
      "items sum": "$69.96",
    });
  });

  it("skips a line just moved to Save for later the same way", () => {
    const doc = minicartWith((d) => {
      line(d, "B0TEST0008").querySelector(".ewc-item-moved-to-sfl-msg")!.classList.remove("aok-hidden");
      subtotal(d).textContent = "$29.97";
    });
    expect(readAmazonMiniCart(doc, PRODUCT_URL).draft?.items).toEqual([mug]);
  });

  it("would count a removed line if the skip rule were missing, and then fail the sum check", () => {
    const doc = minicartWith((d) => line(d, "B0TEST0007").querySelector(".ewc-item-remove-msg")!.classList.add("aok-hidden"));
    const reading = readAmazonMiniCart(doc, PRODUCT_URL);
    expect(reading.draft).toBeNull();
    expect(reading.problems).toEqual(["items sum $191.55 but the mini cart subtotal says $69.96"]);
  });

  it("reads the mini cart on the product and added-to-cart pages too", () => {
    expect(readAmazonMiniCart(parse(productHtml), PRODUCT_URL).draft?.total_minor).toBe(12684);
    expect(readAmazonMiniCart(parse(addedHtml), new URL("https://www.amazon.com/cart/smart-wagon")).draft?.total_minor).toBe(21794);
  });

  it.each<[string, (d: Document) => void, string[]]>([
    ["an empty mini cart", (d) => { for (const el of d.querySelectorAll("#nav-flyout-ewc .ewc-item")) el.remove(); }, ["the mini cart is empty or not loaded"]],
    ["a missing subtotal", (d) => subtotal(d).remove(), ["no mini cart subtotal (#nav-flyout-ewc .ewc-subtotal-amount)"]],
    ["an unreadable price", (d) => line(d, "B0TEST0001").setAttribute("data-price", "n/a"), ['mini cart item 3 has no readable data-price: "n/a"']],
    ["a bad quantity", (d) => line(d, "B0TEST0001").setAttribute("data-quantity", "0"), ['mini cart item 3 has no positive whole data-quantity: "0"']],
    ["a missing name", (d) => line(d, "B0TEST0001").removeAttribute("data-producttitle"), ["mini cart item 3 has no name (data-producttitle)"]],
  ])("returns null and explains %s", (_label, change, problems) => {
    const reading = readAmazonMiniCart(minicartWith(change), PRODUCT_URL);
    expect(reading.draft).toBeNull();
    expect(reading.problems).toEqual(problems);
  });

  it("finds nothing on a page without the mini cart", () => {
    const doc = parse(cartHtml);
    doc.getElementById("nav-flyout-ewc")?.remove();
    expect(readAmazonMiniCart(doc, new URL("https://www.amazon.com/gp/cart/view.html")).problems).toEqual(["the mini cart is empty or not loaded"]);
  });

  it("every mini cart draft plus its hash is a valid Cart", async () => {
    for (const html of [minicartHtml, productHtml, addedHtml]) {
      const draft = readAmazonMiniCart(parse(html), PRODUCT_URL).draft;
      expect(draft).not.toBeNull();
      expect(CartSchema.safeParse({ ...draft!, cart_hash: await hashCart(draft!) }).success).toBe(true);
    }
  });
});
