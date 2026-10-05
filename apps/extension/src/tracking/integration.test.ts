import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CartSchema, DecideRequestSchema, type Cart, type DecisionEvent, type Trigger, type Verdict } from "@auxo/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { hashCart, inspectAmazonPage } from "../cart";
import { classifyClick, classifySubmit } from "../clicks";
import { createCartFlow } from "../flow";
import type { DecideResult } from "../messages";
import { listenForBuyIntents } from "./listener";
import { createPendingStore } from "./pending";
import { createTracker } from "./tracker";

// Real (sanitized) Amazon pages, real readers and classifier, fake backend.
const FIXTURES = resolve(__dirname, "../cart/__fixtures__");
const PRODUCT_URL = "https://www.amazon.com/Side-Table/dp/B0TEST0001?ref=x";
const CART_URL = "https://www.amazon.com/gp/cart/view.html";
const CHECKOUT_URL = "https://www.amazon.com/checkout/p/p-X/spc?isBuyNow=1";

const verdict: Verdict = {
  decision_id: "2b9ebefe-78c8-561e-9a68-da51842c65a8",
  lane: "L2",
  action: "pause",
  template_id: "l2-pause",
  cooldown_seconds: 60,
};

// One "page": loads a fixture and wires everything the way the content script does.
function openPage(fixture: string, href: string) {
  document.documentElement.innerHTML = readFileSync(resolve(FIXTURES, fixture), "utf8");
  const url = () => new URL(href);
  const requests: Array<{ cart: Cart; trigger: Trigger }> = [];
  const events: DecisionEvent[] = [];
  const flow = createCartFlow({
    inspect: () => inspectAmazonPage(document, url()),
    hash: hashCart,
    requestVerdict: vi.fn(async (cart: Cart, trigger: Trigger): Promise<DecideResult> => {
      requests.push({ cart, trigger });
      return { ok: true, verdict };
    }),
    show: () => {},
  });
  const tracker = createTracker({
    flow,
    pending: createPendingStore(sessionStorage),
    inspect: () => inspectAmazonPage(document, url()),
    sendEvent: (e) => events.push(e),
  });
  const intents: Array<Promise<unknown>> = [];
  const stop = listenForBuyIntents(document, { classifyClick, classifySubmit }, (s) => intents.push(tracker.onBuyIntent(s)), url);
  return {
    tracker,
    requests,
    events,
    click: async (selector: string) => {
      const target = document.querySelector(selector);
      expect(target, selector).not.toBeNull();
      (target!.querySelector("span, input") ?? target!).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.all(intents);
    },
    stop,
  };
}

beforeEach(() => sessionStorage.clear());

describe("click tracking on real Amazon pages", () => {
  it("add to cart: reads the product at the click and sends it with the trigger", async () => {
    const page = openPage("amazon-product.html", PRODUCT_URL);
    await page.tracker.onLoad();
    expect(page.requests).toHaveLength(0); // a product page alone isn't a buy moment

    await page.click("#add-to-cart-button");

    expect(page.requests).toHaveLength(1);
    const { cart, trigger } = page.requests[0]!;
    expect(CartSchema.safeParse(cart).success).toBe(true);
    expect(cart.items).toHaveLength(1);
    // The selected variant's ASIN from the buy box, with no slug or query string.
    const asin = document.querySelector<HTMLInputElement>("form#addToCart input#ASIN")!.value;
    expect(cart.url).toBe(`https://www.amazon.com/dp/${asin}`);
    expect(trigger).toMatchObject({ intent: "add_to_cart", source: "known", page_type: "product" });
    expect(DecideRequestSchema.safeParse({ cart, trigger }).success).toBe(true);
    page.stop();
  });

  it("buy now: remembered across the page change and sent with the checkout cart", async () => {
    const product = openPage("amazon-product.html", PRODUCT_URL);
    await product.click("#buy-now-button");
    expect(product.requests).toHaveLength(0);
    product.stop();

    const checkout = openPage("amazon-checkout-buy-now.html", CHECKOUT_URL);
    await checkout.tracker.onLoad();

    expect(checkout.requests).toHaveLength(1);
    expect(checkout.requests[0]!.trigger).toMatchObject({ intent: "buy_now", source: "known", page_type: "checkout" });
    expect(checkout.requests[0]!.cart.url).toBe("https://www.amazon.com/checkout");
    checkout.stop();
  });

  it("proceed to checkout from the cart carries into checkout", async () => {
    const cart = openPage("amazon-cart.html", CART_URL);
    await cart.tracker.onLoad();
    expect(cart.requests[0]!.trigger).toMatchObject({ intent: "page_view", source: "page", page_type: "cart" });

    await cart.click('[data-feature-id="proceed-to-checkout-action"]');
    cart.stop();

    const checkout = openPage("amazon-checkout-from-cart.html", "https://www.amazon.com/checkout/p/p-X/spc");
    await checkout.tracker.onLoad();
    expect(checkout.requests[0]!.trigger).toMatchObject({ intent: "checkout", source: "known", page_type: "checkout" });
    checkout.stop();
  });

  it("place order: remembers the checkout decision for the confirmation page", async () => {
    const checkout = openPage("amazon-checkout-from-cart.html", "https://www.amazon.com/checkout/p/p-X/spc");
    await checkout.tracker.onLoad();

    await checkout.click("#submitOrderButtonId");

    const purchase = createPendingStore(sessionStorage).takePurchase();
    expect(purchase?.decisionId).toBe(verdict.decision_id);
    expect(purchase?.draft.items.length).toBeGreaterThan(0);
    checkout.stop();
  });

  it("removing an item from the cart after a decision sends a removed event", async () => {
    const page = openPage("amazon-cart.html", CART_URL);
    await page.tracker.onLoad();
    const before = page.requests[0]!.cart;

    // Amazon marks a deleted line data-removed="true" until reload.
    const first = document.querySelector('#sc-active-cart [data-itemtype="active"][data-asin]')!;
    first.setAttribute("data-removed", "true");
    const removedPrice = Number(first.getAttribute("data-price")!.replace(/[^0-9]/g, ""));
    const subtotal = document.querySelector("#sc-subtotal-amount-buybox")!;
    const after = before.total_minor - removedPrice * Number(first.getAttribute("data-quantity"));
    subtotal.textContent = `$${Math.trunc(after / 100)}.${String(after % 100).padStart(2, "0")}`;

    await page.tracker.onPageChange();

    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ decision_id: verdict.decision_id, action: "removed" });
    expect(page.requests).toHaveLength(2); // the changed cart is asked about again
    page.stop();
  });
});
