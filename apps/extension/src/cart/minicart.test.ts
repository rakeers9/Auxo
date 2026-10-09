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
// Real saves of the mini cart with one item: before, right after +, right after −.
import sidebarBeforeHtml from "./__fixtures__/amazon-sidebar-before.html?raw";
import sidebarMinusHtml from "./__fixtures__/amazon-sidebar-after-minus.html?raw";
import sidebarPlusHtml from "./__fixtures__/amazon-sidebar-after-plus.html?raw";
// Real saves of a one-item mini cart before and right after deleting that item.
import deleteLastAfterHtml from "./__fixtures__/amazon-sidebar-after-delete-last.html?raw";
import deleteLastBeforeHtml from "./__fixtures__/amazon-sidebar-before-delete-last.html?raw";

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

  describe("real saves around + and − (quantities update in place)", () => {
    const soap = (qty: number) => [{ name: "Unscented hand soap, 12 oz", price_minor: 1199, qty }];

    it.each<[string, string, number, number]>([
      ["before", sidebarBeforeHtml, 1, 1199],
      ["after +", sidebarPlusHtml, 2, 2398],
      ["after −", sidebarMinusHtml, 1, 1199],
    ])("reads the cart %s", (_label, html, qty, total) => {
      const reading = readAmazonMiniCart(parse(html), PRODUCT_URL);
      expect(reading.problems).toEqual([]);
      expect(reading.draft?.items).toEqual(soap(qty));
      expect(reading.draft?.total_minor).toBe(total);
    });

    it("keeps the same line through the edits; only its quantity changes", () => {
      const ids = [sidebarBeforeHtml, sidebarPlusHtml, sidebarMinusHtml].map((html) =>
        [...parse(html).querySelectorAll("#nav-flyout-ewc .ewc-item")].map((el) => el.getAttribute("data-itemid")),
      );
      expect(ids[1]).toEqual(ids[0]);
      expect(ids[2]).toEqual(ids[0]);
    });

    it("hashes the + state differently, and the − state back to the original", async () => {
      const read = (html: string) => readAmazonMiniCart(parse(html), PRODUCT_URL).draft!;
      const before = read(sidebarBeforeHtml);
      const plus = read(sidebarPlusHtml);
      const minus = read(sidebarMinusHtml);
      expect(await hashCart(plus)).not.toBe(await hashCart(before));
      expect(await hashCart(minus)).toBe(await hashCart(before));
    });

    it("reads the + quantity from the line, agreeing with the nav count", () => {
      // (The real save's hidden #ewc-total-quantity still said 1; it isn't kept
      // in the fixture and the reader never uses it.)
      expect(parse(sidebarPlusHtml).getElementById("nav-cart-count")?.textContent?.trim()).toBe("2");
      expect(readAmazonMiniCart(parse(sidebarPlusHtml), PRODUCT_URL).draft?.items[0]?.qty).toBe(2);
    });
  });

  describe("real saves around deleting the last item", () => {
    it("reads the one-item cart before the delete", () => {
      expect(readAmazonMiniCart(parse(deleteLastBeforeHtml), PRODUCT_URL).draft?.items).toEqual([
        { name: "Fragrance-free body lotion, 4 oz", price_minor: 1699, qty: 1 },
      ]);
    });

    it("reads the emptied cart as an empty draft: line marked removed, $0.00 subtotal, nav count 0", () => {
      const doc = parse(deleteLastAfterHtml);
      const line = doc.querySelector("#nav-flyout-ewc .ewc-item")!;
      expect(line.querySelector(".ewc-item-remove-msg")!.classList.contains("aok-hidden")).toBe(false);
      expect(subtotal(doc).textContent?.trim()).toBe("$0.00");

      const reading = readAmazonMiniCart(doc, PRODUCT_URL);
      expect(reading.problems).toEqual([]);
      expect(reading.draft).toEqual({
        merchant: "amazon.com",
        items: [],
        total_minor: 0,
        currency: "USD",
        url: "https://www.amazon.com/gp/cart/view.html",
      });
      expect(reading.details).toEqual({
        "mini cart items": "1",
        "removed skipped": "1",
        "mini cart subtotal": '"$0.00"',
        "nav cart count": '"0"',
        empty: "yes",
      });
    });

    it.each<[string, (d: Document) => void]>([
      ["the subtotal isn't $0.00 yet", (d) => { subtotal(d).textContent = "$16.99"; }],
      ["the nav count isn't 0 yet", (d) => { d.getElementById("nav-cart-count")!.textContent = "1"; }],
      ["the nav count is missing", (d) => d.getElementById("nav-cart-count")!.remove()],
      ["the subtotal is missing", (d) => subtotal(d).remove()],
      ["there are no lines at all (flyout not loaded)", (d) => { for (const el of d.querySelectorAll("#nav-flyout-ewc .ewc-item")) el.remove(); }],
    ])("stays unreadable when %s", (_label, change) => {
      const doc = parse(deleteLastAfterHtml);
      change(doc);
      const reading = readAmazonMiniCart(doc, PRODUCT_URL);
      expect(reading.draft).toBeNull();
      expect(reading.problems).toEqual(["the mini cart is empty or not loaded"]);
    });
  });

  it("every mini cart draft plus its hash is a valid Cart", async () => {
    for (const html of [minicartHtml, productHtml, addedHtml]) {
      const draft = readAmazonMiniCart(parse(html), PRODUCT_URL).draft;
      expect(draft).not.toBeNull();
      expect(CartSchema.safeParse({ ...draft!, cart_hash: await hashCart(draft!) }).success).toBe(true);
    }
  });
});
