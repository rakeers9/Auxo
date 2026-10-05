import { describe, expect, it } from "vitest";

import addedToCartHtml from "../cart/__fixtures__/amazon-added-to-cart.html?raw";
import cartSavedItemHtml from "../cart/__fixtures__/amazon-cart-saved-item.html?raw";
import cartHtml from "../cart/__fixtures__/amazon-cart.html?raw";
import checkoutBuyNowHtml from "../cart/__fixtures__/amazon-checkout-buy-now.html?raw";
import checkoutFromCartHtml from "../cart/__fixtures__/amazon-checkout-from-cart.html?raw";
import productHtml from "../cart/__fixtures__/amazon-product.html?raw";
import { classifyClick, classifySubmit } from "./classify";
import { KNOWN_CONTROLS } from "./known";

// Real amazon.com pages saved by auxo-1c (src/cart/__fixtures__). Read only.
const FIXTURES = {
  product: productHtml,
  cart: cartHtml,
  cartSavedItem: cartSavedItemHtml,
  addedToCart: addedToCartHtml,
  checkoutBuyNow: checkoutBuyNowHtml,
  checkoutFromCart: checkoutFromCartHtml,
};

const PRODUCT_URL = new URL("https://www.amazon.com/side-table/dp/B0TEST0005");
const CART_URL = new URL("https://www.amazon.com/gp/cart/view.html");
const ADDED_URL = new URL("https://www.amazon.com/cart/smart-wagon?newItems=abc,1&ref_=sw_refresh");
const CHECKOUT_URL = new URL("https://www.amazon.com/checkout/p/p-123/spc");
const OTHER_HOST = new URL("https://www.amazon.co.uk/side-table/dp/B0TEST0005");

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function find(doc: Document, selector: string): Element {
  const el = doc.querySelector(selector);
  if (!el) throw new Error(`fixture has no ${selector}`);
  return el;
}

describe("known Amazon controls, against real fixtures", () => {
  it("every known selector exists in at least one real fixture", () => {
    const docs = Object.values(FIXTURES).map(parse);
    for (const control of KNOWN_CONTROLS["www.amazon.com"] ?? []) {
      for (const selector of control.selectors) {
        expect(docs.some((doc) => doc.querySelector(selector)), selector).toBe(true);
      }
    }
  });

  describe("product page", () => {
    const doc = parse(productHtml);

    it("add to cart: a click on the inner span is known add_to_cart", () => {
      const inner = find(doc, '[id="submit.add-to-cart-announce"]');
      expect(inner.closest('[id="submit.add-to-cart"]')).not.toBeNull();
      expect(classifyClick(inner, PRODUCT_URL)).toMatchObject({ intent: "add_to_cart", source: "known" });
    });

    it("add to cart: a click on the input is known add_to_cart, labeled from its value", () => {
      expect(classifyClick(find(doc, "#add-to-cart-button"), PRODUCT_URL)).toEqual({
        intent: "add_to_cart",
        source: "known",
        label: "Add to cart",
      });
    });

    it("buy now: a click on the inner span or the input is known buy_now", () => {
      const inner = find(doc, '[id="submit.buy-now-announce"]');
      expect(classifyClick(inner, PRODUCT_URL)).toMatchObject({ intent: "buy_now", source: "known" });
      expect(classifyClick(find(doc, "#buy-now-button"), PRODUCT_URL)).toMatchObject({
        intent: "buy_now",
        source: "known",
      });
    });

    it("buy now: submitting form#addToCart with the buy now button is known buy_now", () => {
      const form = find(doc, "form#addToCart") as HTMLFormElement;
      expect(classifySubmit(form, find(doc, "#buy-now-button"), PRODUCT_URL)).toMatchObject({
        intent: "buy_now",
        source: "known",
      });
    });

    it("nav cart: a click on the count inside a#nav-cart is known view_cart", () => {
      expect(classifyClick(find(doc, "#nav-cart-count"), PRODUCT_URL)).toMatchObject({
        intent: "view_cart",
        source: "known",
      });
    });

    it("the quantity select and the page title are not buy-intent clicks", () => {
      expect(classifyClick(find(doc, "select#quantity"), PRODUCT_URL)).toBeNull();
      expect(classifyClick(find(doc, "span#productTitle"), PRODUCT_URL)).toBeNull();
    });

    it("controls in the nav cart flyout are not product actions", () => {
      const flyout = find(doc, "#nav-flyout-ewc");
      const controls = [...flyout.querySelectorAll("button, a, input, [role=button]")];
      expect(controls.length).toBeGreaterThan(0);
      for (const control of controls) {
        expect(classifyClick(control, PRODUCT_URL), control.outerHTML.slice(0, 120)).toBeNull();
      }
    });
  });

  describe("cart page", () => {
    it.each([
      ["amazon-cart.html", cartHtml],
      ["amazon-cart-saved-item.html", cartSavedItemHtml],
    ])("%s: proceed to checkout (input or inner span) is known checkout", (_name, html) => {
      const doc = parse(html);
      expect(classifyClick(find(doc, 'input[name="proceedToRetailCheckout"]'), CART_URL)).toEqual({
        intent: "checkout",
        source: "known",
        label: "Proceed to checkout",
      });
      expect(classifyClick(find(doc, "#sc-buy-box-ptc-button-announce"), CART_URL)).toMatchObject({
        intent: "checkout",
        source: "known",
      });
    });
  });

  describe("added-to-cart page (/cart/smart-wagon)", () => {
    const doc = parse(addedToCartHtml);

    it("Go to Cart (the link or its inner span) is known view_cart", () => {
      const link = find(doc, "#sw-gtc a");
      expect(link.getAttribute("href")).toBe("https://www.amazon.com/cart?ref_=sw_gtc");
      expect(classifyClick(link, ADDED_URL)).toEqual({ intent: "view_cart", source: "known", label: "Go to Cart" });
      expect(classifyClick(find(doc, "#sw-gtc .a-button-inner"), ADDED_URL)).toMatchObject({
        intent: "view_cart",
        source: "known",
      });
    });

    it("Proceed to checkout (input or inner span) is known checkout", () => {
      expect(classifyClick(find(doc, 'input[name="proceedToRetailCheckout"]'), ADDED_URL)).toEqual({
        intent: "checkout",
        source: "known",
        label: "Proceed to checkout",
      });
      expect(classifyClick(find(doc, "#sc-buy-box-ptc-button-announce"), ADDED_URL)).toMatchObject({
        intent: "checkout",
        source: "known",
      });
    });

    it("submitting the checkout form with that button is known checkout", () => {
      const submitter = find(doc, 'input[name="proceedToRetailCheckout"]');
      const form = submitter.closest("form");
      expect(form).not.toBeNull();
      expect(classifySubmit(form as HTMLFormElement, submitter, ADDED_URL)).toMatchObject({
        intent: "checkout",
        source: "known",
      });
    });

    it("the nav cart link is still known view_cart", () => {
      expect(classifyClick(find(doc, "#nav-cart"), ADDED_URL)).toMatchObject({ intent: "view_cart", source: "known" });
    });

    it("controls in the nav cart flyout are not buy-intent clicks", () => {
      const controls = [...find(doc, "#nav-flyout-ewc").querySelectorAll("button, a, input, [role=button]")];
      expect(controls.length).toBeGreaterThan(0);
      for (const control of controls) {
        expect(classifyClick(control, ADDED_URL), control.outerHTML.slice(0, 120)).toBeNull();
      }
    });

    it("off Amazon, Go to Cart is only a guess", () => {
      expect(classifyClick(find(doc, "#sw-gtc a"), OTHER_HOST)).toEqual({
        intent: "view_cart",
        source: "guess",
        label: "Go to Cart",
      });
    });
  });

  describe("checkout page", () => {
    it.each([
      ["amazon-checkout-buy-now.html", checkoutBuyNowHtml],
      ["amazon-checkout-from-cart.html", checkoutFromCartHtml],
    ])("%s: a click inside span#submitOrderButtonId is known place_order", (_name, html) => {
      const doc = parse(html);
      const inner = find(doc, "#submitOrderButtonId .place-order-button-text");
      expect(classifyClick(inner, CHECKOUT_URL)).toMatchObject({ intent: "place_order", source: "known" });
    });

    it("the hidden blocker button that shares the place-order text class is not place_order", () => {
      const doc = parse(checkoutFromCartHtml);
      const blocker = find(doc, "#review-order-continue-blocker-tooltip-trigger .place-order-button-text");
      expect(classifyClick(blocker, CHECKOUT_URL)).toBeNull();
    });
  });

  describe("a different host never yields known", () => {
    it.each([
      ["product", productHtml, "#add-to-cart-button"],
      ["product", productHtml, '[id="submit.buy-now-announce"]'],
      ["product", productHtml, "#nav-cart-count"],
      ["cart", cartHtml, 'input[name="proceedToRetailCheckout"]'],
      ["checkout", checkoutFromCartHtml, "#submitOrderButtonId .place-order-button-text"],
    ])("%s %s", (_page, html, selector) => {
      const result = classifyClick(find(parse(html), selector), OTHER_HOST);
      expect(result?.source).not.toBe("known");
    });

    it("off Amazon the add to cart input still reads as a guess from its value", () => {
      const doc = parse(productHtml);
      expect(classifyClick(find(doc, "#add-to-cart-button"), OTHER_HOST)).toEqual({
        intent: "add_to_cart",
        source: "guess",
        label: "Add to cart",
      });
    });

    it("off Amazon the buy now submit falls back to its formaction", () => {
      const doc = parse(productHtml);
      const form = find(doc, "form#addToCart") as HTMLFormElement;
      expect(classifySubmit(form, find(doc, "#buy-now-button"), OTHER_HOST)).toEqual({
        intent: "checkout",
        source: "guess",
      });
    });
  });
});
