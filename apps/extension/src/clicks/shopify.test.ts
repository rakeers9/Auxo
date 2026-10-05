import { describe, expect, it } from "vitest";

import dawnCartHtml from "../cart/__fixtures__/shopify/dawn-cart-buttons.html?raw";
import dawnProductHtml from "../cart/__fixtures__/shopify/dawn-product-buttons.html?raw";
import deathwishCartHtml from "../cart/__fixtures__/shopify/deathwish-cart-buttons.html?raw";
import deathwishProductHtml from "../cart/__fixtures__/shopify/deathwish-product-buttons.html?raw";
import horizonCartHtml from "../cart/__fixtures__/shopify/horizon-cart-buttons.html?raw";
import horizonDrawerHtml from "../cart/__fixtures__/shopify/horizon-drawer-buttons.html?raw";
import horizonProductHtml from "../cart/__fixtures__/shopify/horizon-product-buttons.html?raw";
import { classifyClick, classifySubmit } from "./classify";
import { controlsFor, PLATFORM_CONTROLS } from "./known";

// Sanitized snippets of real Shopify storefronts (Dawn and Horizon theme
// demos, and Death Wish Coffee on a Dawn-based theme), saved 2026-10-05.
const PRODUCT_PAGES = {
  dawn: dawnProductHtml,
  horizon: horizonProductHtml,
  deathwish: deathwishProductHtml,
};
const CART_PAGES = {
  dawn: dawnCartHtml,
  horizon: horizonCartHtml,
  deathwish: deathwishCartHtml,
};
const ALL_PAGES = [...Object.values(PRODUCT_PAGES), ...Object.values(CART_PAGES), horizonDrawerHtml];

const STORE = new URL("https://some-store.example/products/mug");
const CART = new URL("https://some-store.example/cart");

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function find(doc: Document, selector: string): Element {
  const el = doc.querySelector(selector);
  if (!el) throw new Error(`fixture has no ${selector}`);
  return el;
}

describe("Shopify platform controls, against real theme HTML", () => {
  it("every Shopify selector exists in at least one real fixture", () => {
    const docs = ALL_PAGES.map(parse);
    for (const control of PLATFORM_CONTROLS.shopify) {
      for (const selector of control.selectors) {
        expect(docs.some((doc) => doc.querySelector(selector)), selector).toBe(true);
      }
    }
  });

  it("covers the buy intents and the cart edits Shopify has controls for", () => {
    expect(PLATFORM_CONTROLS.shopify.map((c) => c.intent).sort()).toEqual(
      ["add_to_cart", "buy_now", "checkout", "view_cart", "increase_qty", "decrease_qty", "remove_item"].sort(),
    );
  });

  describe.each(Object.entries(PRODUCT_PAGES))("%s product page", (_store, html) => {
    const doc = parse(html);

    it("a click on the add-to-cart button's inner span is known add_to_cart", () => {
      const button = find(doc, 'form[action*="/cart/add"] button[name="add"][type="submit"]');
      const inner = button.querySelector("span") ?? button;
      expect(classifyClick(inner, STORE, undefined, "shopify")).toMatchObject({
        intent: "add_to_cart",
        source: "known",
        label: expect.stringContaining("Add to cart"),
      });
    });

    it("submitting the product form with that button is known add_to_cart", () => {
      const form = find(doc, 'form[action*="/cart/add"]') as HTMLFormElement;
      const submitter = find(doc, 'form[action*="/cart/add"] button[name="add"][type="submit"]');
      expect(classifySubmit(form, submitter, STORE, undefined, "shopify")).toMatchObject({
        intent: "add_to_cart",
        source: "known",
      });
    });
  });

  describe.each([
    ["dawn", dawnProductHtml],
    ["horizon", horizonProductHtml],
  ])("%s dynamic checkout", (_store, html) => {
    it("a click inside .shopify-payment-button is known buy_now", () => {
      const doc = parse(html);
      const inner = find(doc, ".shopify-payment-button .shopify-payment-button__button");
      expect(classifyClick(inner, STORE, undefined, "shopify")).toMatchObject({ intent: "buy_now", source: "known" });
    });

    it("a button Shopify injects into the wrapper later is buy_now too", () => {
      const doc = parse(html);
      const injected = doc.createElement("button");
      injected.type = "button";
      injected.className = "shopify-payment-button__button shopify-payment-button__button--unbranded";
      injected.textContent = "Buy it now";
      find(doc, "shopify-accelerated-checkout").append(injected);
      expect(classifyClick(injected, STORE, undefined, "shopify")).toEqual({
        intent: "buy_now",
        source: "known",
        label: "Buy it now",
      });
    });
  });

  describe.each(Object.entries(CART_PAGES))("%s cart page", (_store, html) => {
    const doc = parse(html);

    it("the cart checkout button is known checkout", () => {
      expect(classifyClick(find(doc, "#checkout"), CART, undefined, "shopify")).toEqual({
        intent: "checkout",
        source: "known",
        label: "Check out",
      });
    });

    it("the header cart link is known view_cart", () => {
      expect(classifyClick(find(doc, 'a[href="/cart"] span'), CART, undefined, "shopify")).toMatchObject({
        intent: "view_cart",
        source: "known",
      });
    });
  });

  it.each([
    ["horizon", horizonCartHtml],
    ["deathwish", deathwishCartHtml],
  ])("%s: the cart's express checkout wallets are known checkout", (_store, html) => {
    const doc = parse(html);
    const wallet = find(doc, "shopify-accelerated-checkout-cart .wallet-cart-button");
    expect(classifyClick(wallet, CART, undefined, "shopify")).toMatchObject({ intent: "checkout", source: "known" });
  });

  it.each([
    ["dawn", dawnProductHtml],
    ["deathwish", deathwishProductHtml],
  ])("%s: the add-to-cart notification's View cart and Check out are known", (_store, html) => {
    const doc = parse(html);
    expect(classifyClick(find(doc, "#cart-notification-button"), STORE, undefined, "shopify")).toEqual({
      intent: "view_cart",
      source: "known",
      label: "View cart",
    });
    expect(classifyClick(find(doc, '#cart-notification-form button[name="checkout"]'), STORE, undefined, "shopify")).toEqual(
      { intent: "checkout", source: "known", label: "Check out" },
    );
    // "Continue shopping" is just a button: not buy intent.
    expect(classifyClick(find(doc, ".cart-notification__links button.link"), STORE, undefined, "shopify")).toBeNull();
  });

  it("Horizon's quick-add 'Choose' button (type=button) is not add_to_cart; its 'Add' submit is", () => {
    const doc = parse(horizonCartHtml);
    const choose = find(doc, ".quick-add__button--choose");
    expect(choose.getAttribute("type")).toBe("button");
    expect(classifyClick(choose, CART, undefined, "shopify")?.source).not.toBe("known");
    expect(classifyClick(find(doc, ".quick-add__button--add"), CART, undefined, "shopify")).toMatchObject({
      intent: "add_to_cart",
      source: "known",
    });
  });

  it("Horizon's quantity +/- buttons inside the product form are not buy intent", () => {
    const doc = parse(horizonProductHtml);
    for (const selector of [".quantity-minus", ".quantity-plus", 'input[name="quantity"]']) {
      expect(classifyClick(find(doc, selector), STORE, undefined, "shopify"), selector).toBeNull();
    }
  });

  it("Horizon's drawer cart button isn't a known control, but its aria-label still guesses view_cart", () => {
    const doc = parse(horizonProductHtml);
    expect(classifyClick(find(doc, 'button[aria-label="Cart"]'), STORE, undefined, "shopify")).toEqual({
      intent: "view_cart",
      source: "guess",
      label: "Cart",
    });
  });
});

describe("Shopify controls need the platform", () => {
  it.each([
    ["add to cart", dawnProductHtml, 'form[action*="/cart/add"] button[name="add"]'],
    ["dynamic checkout", dawnProductHtml, ".shopify-payment-button__button"],
    ["cart checkout", dawnCartHtml, "#checkout"],
    ["cart link", dawnCartHtml, "#cart-icon-bubble"],
    ["express wallets", horizonCartHtml, "shopify-accelerated-checkout-cart .wallet-cart-button"],
  ])("%s is never known without platform 'shopify'", (_name, html, selector) => {
    const el = find(parse(html), selector);
    expect(classifyClick(el, STORE)?.source).not.toBe("known");
    expect(classifyClick(el, STORE, {})?.source).not.toBe("known");
  });

  it("controlsFor adds the Shopify set only when asked", () => {
    expect(controlsFor("some-store.example")).toEqual([]);
    expect(controlsFor("some-store.example", undefined, "shopify")).toEqual(PLATFORM_CONTROLS.shopify);
  });

  it("an unknown platform value adds nothing", () => {
    expect(controlsFor("some-store.example", undefined, "magento" as "shopify")).toEqual([]);
  });
});

describe("Shopify controls with host overrides", () => {
  it("an override replaces the Shopify list for that intent and keeps the others", () => {
    const doc = parse(dawnProductHtml);
    const buttons = { add_to_cart: [".my-theme-atc"] };
    expect(classifyClick(find(doc, 'button[name="add"]'), STORE, buttons, "shopify")?.source).not.toBe("known");
    expect(classifyClick(find(doc, ".shopify-payment-button__button"), STORE, buttons, "shopify")).toMatchObject({
      intent: "buy_now",
      source: "known",
    });
  });

  it("an override can add a theme's own button on top of the platform set", () => {
    const doc = parse(horizonProductHtml);
    const buttons = { view_cart: ['a[href="/cart"]', 'button[aria-label="Cart"]'] };
    expect(classifyClick(find(doc, 'button[aria-label="Cart"]'), STORE, buttons, "shopify")).toMatchObject({
      intent: "view_cart",
      source: "known",
    });
  });

  it("merging keeps one list per intent, in the platform's order", () => {
    const merged = controlsFor("some-store.example", { checkout: ["#co"], place_order: ["#po"] }, "shopify");
    expect(merged.map((c) => c.intent)).toEqual([
      "buy_now",
      "add_to_cart",
      "checkout",
      "view_cart",
      "increase_qty",
      "decrease_qty",
      "remove_item",
      "place_order",
    ]);
    expect(merged.find((c) => c.intent === "checkout")?.selectors).toEqual(["#co"]);
  });
});
