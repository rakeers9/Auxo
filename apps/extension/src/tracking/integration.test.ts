import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CartSchema, DecideRequestSchema, type Cart, type DecisionEvent, type Trigger, type Verdict } from "@auxo/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { hashCart, inspectAmazonPage } from "../cart";
import { classifyClick, classifySubmit } from "../clicks";
import { createCartFlow } from "../flow";
import type { DecideResult } from "../messages";
import { listenForBuyIntents } from "./listener";
import { createMiniCartHandler } from "./minicart-handler";
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
  // Cart page edits go through the same handler as the sidebar.
  const cartHandler = createMiniCartHandler({
    decisionFor: async () => null,
    sendEvent: (e) => events.push(e),
    decide: async (cart, trigger) => {
      requests.push({ cart: { ...cart, cart_hash: "edit" }, trigger });
      return verdict.decision_id;
    },
    pageType: () => inspectAmazonPage(document, url()).pageType,
  });
  const tracker = createTracker({
    flow,
    pending: createPendingStore(sessionStorage),
    inspect: () => inspectAmazonPage(document, url()),
    onCartDiff: (before, after, diff) => cartHandler.onChange(before, after, diff, { source: "cart_page" }),
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
    expect(page.events[0]).toMatchObject({
      decision_id: verdict.decision_id,
      action: "removed",
      metadata: { source: "cart_page", intent: "remove_item", precursor_decision_id: null },
    });
    // 1: the cart on load, 2: the removal itself, 3: the changed cart re-checked.
    expect(page.requests).toHaveLength(3);
    expect(page.requests[1]!.trigger).toMatchObject({ intent: "remove_item", page_type: "cart" });
    expect(page.requests[2]!.trigger).toMatchObject({ intent: "page_view", page_type: "cart" });
    page.stop();
  });
});

describe("cart sidebar on a real product page", () => {
  const url = new URL("https://www.amazon.com/Water-Bottle/dp/B0TEST0009");

  async function setupSidebar() {
    vi.useFakeTimers();
    const { readAmazonMiniCart } = await import("../cart");
    const { watchMiniCart, MINI_CART_DEBOUNCE_MS } = await import("./sidesheet");
    const { createMiniCartHandler } = await import("./minicart-handler");
    const { createDecisionMemory } = await import("../api/decision-memory");
    const data: Record<string, unknown> = {};
    const memory = createDecisionMemory({
      get: async (key) => (key in data ? { [key]: data[key] } : {}),
      set: async (items) => void Object.assign(data, items),
    });

    document.documentElement.innerHTML = readFileSync(resolve(FIXTURES, "amazon-product-minicart.html"), "utf8");
    const events: DecisionEvent[] = [];
    const decided: Array<{ cart: unknown; trigger: Trigger }> = [];
    const handler = createMiniCartHandler({
      decisionFor: (items) => memory.decisionFor(items),
      sendEvent: (e) => events.push(e),
      decide: async (cart, trigger) => {
        decided.push({ cart, trigger });
        return `22222222-2222-4222-8222-22222222222${decided.length}`;
      },
      pageType: () => inspectAmazonPage(document, url).pageType,
    });
    const stop = watchMiniCart(document, () => readAmazonMiniCart(document, url).draft, {
      onChange: (before, after, diff) => void handler.onChange(before, after, diff),
    });
    const flush = async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(MINI_CART_DEBOUNCE_MS);
      await vi.runAllTimersAsync();
    };
    const line = (asin: string) => document.querySelector(`#nav-flyout-ewc .ewc-item[data-asin="${asin}"]`)!;
    const setSubtotal = (text: string) => {
      document.querySelector("#nav-flyout-ewc .ewc-subtotal-amount h2")!.textContent = text;
    };
    return { memory, events, decided, stop, flush, line, setSubtotal, handler };
  }

  it("links a sidebar removal to the earlier decision about that item", async () => {
    const s = await setupSidebar();
    // The keyboard was decided on earlier (e.g. at its add to cart, on another page).
    await s.memory.remember("11111111-1111-4111-8111-111111111111", {
      merchant: "amazon.com",
      currency: "USD",
      url: "https://www.amazon.com/gp/cart/view.html",
      items: [{ name: "Wireless keyboard, full size", price_minor: 3999, qty: 1 }],
    });

    const removed = s.line("B0TEST0008");
    removed.querySelector(".ewc-item-remove-msg")!.classList.remove("aok-hidden");
    removed.querySelector(".ewc-item-content")?.remove();
    removed.querySelector(".ewc-qty-and-action-items")?.remove();
    s.setSubtotal("$29.97");
    await s.flush();

    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toMatchObject({
      // Sent against the removal's own decision; the earlier one is the precursor.
      decision_id: "22222222-2222-4222-8222-222222222221",
      action: "removed",
      metadata: { removed: [{ name: "Wireless keyboard, full size", price_minor: 3999, qty: 1 }], source: "mini_cart", precursor_decision_id: "11111111-1111-4111-8111-111111111111", page_type: "product" },
    });
    // Every removal is also asked about, as a remove_item edit.
    expect(s.decided).toHaveLength(1);
    expect(s.decided[0]!.trigger).toMatchObject({ intent: "remove_item", source: "page", page_type: "product" });
    expect(s.decided[0]!.cart).toMatchObject({ items: [{ name: "Wireless keyboard, full size", price_minor: 3999, qty: 1 }] });
    s.stop();
    vi.useRealTimers();
  });

  it("a real + click in the sidebar labels the next change as increase_qty", async () => {
    const s = await setupSidebar();
    const handler = s.handler;
    const stopClicks = listenForBuyIntents(
      document,
      { classifyClick, classifySubmit },
      (signal) => handler.noteEditClick(signal),
      () => url,
    );
    const mugs = document.querySelector('#nav-flyout-ewc .ewc-item[data-price="9.99"]') ?? s.line("B0TEST0006");
    const plus = mugs.querySelector('[data-action="a-stepper-increment"]');
    expect(plus, "the real sidebar has a + stepper").not.toBeNull();
    plus!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    // What Amazon does next: the quantity and subtotal update.
    mugs.setAttribute("data-quantity", "4");
    s.setSubtotal("$79.95");
    await s.flush();

    expect(s.decided).toHaveLength(1);
    expect(s.decided[0]!.trigger).toMatchObject({ intent: "increase_qty", source: "known", page_type: "product" });
    stopClicks();
    s.stop();
    vi.useRealTimers();
  });

  it("asks for a fresh add-to-cart decision when the sidebar quantity goes up", async () => {
    const s = await setupSidebar();
    const mugs = document.querySelector('#nav-flyout-ewc .ewc-item[data-price="9.99"]') ?? s.line("B0TEST0006");
    mugs.setAttribute("data-quantity", "4");
    s.setSubtotal("$79.95");
    await s.flush();

    expect(s.decided).toHaveLength(1);
    expect(s.decided[0]!.trigger).toMatchObject({ intent: "add_to_cart", source: "page", page_type: "product" });
    expect(s.decided[0]!.cart).toMatchObject({ items: [{ name: "Ceramic coffee mug, 12 oz, matte black", price_minor: 999, qty: 1 }], total_minor: 999 });
    s.stop();
    vi.useRealTimers();
  });
});

describe("blocking a purchase on the real checkout page", () => {
  async function checkoutWithGate(alwaysOn = false) {
    const { createClickGate } = await import("./gate");
    document.documentElement.innerHTML = readFileSync(resolve(FIXTURES, "amazon-checkout-from-cart.html"), "utf8");
    const url = new URL("https://www.amazon.com/checkout/p/p-X/spc");
    const gate = createClickGate({ alwaysOn, devVerdict: { ...verdict, decision_id: "00000000-0000-4000-8000-000000000000" } });
    const signals: string[] = [];
    const blocked: string[] = [];
    const stop = listenForBuyIntents(
      document,
      { classifyClick, classifySubmit },
      (s) => signals.push(s.intent),
      () => url,
      () => Date.now(),
      { shouldBlock: (s) => gate.check(s).block, onBlocked: (s) => blocked.push(s.intent) },
    );
    // Stand-in for Amazon's own handler on the place order control.
    const placeOrder = vi.fn();
    document.querySelector("#submitOrderButtonId")!.addEventListener("click", placeOrder);
    const click = () => {
      const inner = document.querySelector("#submitOrderButtonId")!.querySelector("span, input, a") ?? document.querySelector("#submitOrderButtonId")!;
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      inner.dispatchEvent(event);
      return event;
    };
    return { gate, signals, blocked, placeOrder, click, stop };
  }

  it("a 'block' answer stops Place your order; after Continue the user's own next click goes through", async () => {
    const t = await checkoutWithGate();
    t.gate.setVerdict({ ...verdict, lane: "L3", action: "block" });

    const first = t.click();
    expect(first.defaultPrevented).toBe(true);
    expect(t.placeOrder).not.toHaveBeenCalled();
    expect(t.blocked).toEqual(["place_order"]);
    expect(t.signals).toEqual([]); // not recorded as a purchase attempt

    t.gate.override(verdict.decision_id); // the user chose Continue on the pause
    const second = t.click();
    expect(second.defaultPrevented).toBe(false);
    expect(t.placeOrder).toHaveBeenCalledTimes(1);
    expect(t.signals).toEqual(["place_order"]);
    t.stop();
  });

  it("pause and allow answers never stop the click", async () => {
    const t = await checkoutWithGate();
    t.gate.setVerdict({ ...verdict, lane: "L2", action: "pause" });

    expect(t.click().defaultPrevented).toBe(false);
    expect(t.placeOrder).toHaveBeenCalledTimes(1);
    t.stop();
  });

  it("dev builds stop it even without an answer", async () => {
    const t = await checkoutWithGate(true);

    expect(t.click().defaultPrevented).toBe(true);
    expect(t.placeOrder).not.toHaveBeenCalled();
    t.stop();
  });
});

describe("changes made outside this tab", () => {
  it("a page load that shows a smaller cart than any tab last saw reports the removal", async () => {
    const { createCartState } = await import("../api/cart-state");
    const data: Record<string, unknown> = {};
    const state = createCartState({
      get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
      set: async (items) => void Object.assign(data, structuredClone(items)),
    });
    const keyboard = { name: "Wireless keyboard, full size", price_minor: 3999, qty: 1 };
    const mugs = { name: "Ceramic coffee mug, 12 oz, matte black", price_minor: 999, qty: 3 };
    const cartOf = (items: Array<typeof mugs>) => ({
      merchant: "amazon.com",
      items,
      total_minor: items.reduce((s, i) => s + i.price_minor * i.qty, 0),
      currency: "USD",
      url: "https://www.amazon.com/gp/cart/view.html",
    });

    // Another tab saw (and reported) the cart with both items.
    await state.record("amazon.com", cartOf([keyboard, mugs]));

    // This tab loads fresh; the keyboard was removed in the Amazon app meanwhile.
    const change = await state.compareAtLoad("amazon.com", cartOf([mugs]));
    expect(change?.diff.removed).toEqual([keyboard]);

    const decided: Array<{ trigger: Trigger }> = [];
    const handler = createMiniCartHandler({
      decisionFor: async () => null,
      sendEvent: () => {},
      decide: async (_cart, trigger) => {
        decided.push({ trigger });
        return "33333333-3333-4333-8333-333333333333";
      },
      pageType: () => "other",
    });
    await handler.onChange(change!.before, change!.after, { removed: change!.diff.removed, added: change!.diff.added }, {
      source: "elsewhere",
      label: "changed outside this tab",
    });

    expect(decided[0]!.trigger).toMatchObject({ intent: "remove_item", source: "page", label: "changed outside this tab" });
    // And the next load of the same cart reports nothing again.
    expect(await state.compareAtLoad("amazon.com", cartOf([mugs]))).toBeNull();
  });
});

describe("real sidebar saves: before and after each action", () => {
  const url = new URL("https://www.amazon.com/gp/cart/view.html");
  const body = (name: string) =>
    new DOMParser().parseFromString(readFileSync(resolve(FIXTURES, name), "utf8"), "text/html").body.innerHTML;

  async function watchReal(beforeFixture: string) {
    vi.useFakeTimers();
    const { readAmazonMiniCart } = await import("../cart");
    const { watchMiniCart, MINI_CART_DEBOUNCE_MS } = await import("./sidesheet");
    document.body.innerHTML = body(beforeFixture);
    const decided: Array<{ cart: { items: unknown[] }; trigger: Trigger }> = [];
    const events: DecisionEvent[] = [];
    const handler = createMiniCartHandler({
      decisionFor: async () => null,
      sendEvent: (e) => events.push(e),
      decide: async (cart, trigger) => {
        decided.push({ cart, trigger });
        return "44444444-4444-4444-8444-444444444444";
      },
      pageType: () => "other",
    });
    const stop = watchMiniCart(document, () => readAmazonMiniCart(document, url).draft, {
      onChange: (before, after, diff) => void handler.onChange(before, after, diff),
    });
    const settle = async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(MINI_CART_DEBOUNCE_MS);
      await vi.runAllTimersAsync();
    };
    return { handler, decided, events, settle, stop };
  }

  it("+ in the real sidebar (qty 1 → 2) is asked about as increase_qty", async () => {
    const w = await watchReal("amazon-sidebar-before.html");
    const plus = document.querySelector('#nav-flyout-ewc [data-action="a-stepper-increment"]');
    const signal = classifyClick(plus, new URL("https://www.amazon.com/dp/B0TEST0009"));
    expect(signal).toMatchObject({ intent: "increase_qty", source: "known" });
    w.handler.noteEditClick(signal!);

    document.body.innerHTML = body("amazon-sidebar-after-plus.html");
    await w.settle();

    expect(w.decided).toHaveLength(1);
    expect(w.decided[0]!.trigger).toMatchObject({ intent: "increase_qty", source: "known" });
    expect(w.decided[0]!.cart.items).toEqual([expect.objectContaining({ price_minor: 1199, qty: 1 })]);
    w.stop();
    vi.useRealTimers();
  });

  it("− in the real sidebar (qty 2 → 1) is asked about as decrease_qty and sends 'removed'", async () => {
    const w = await watchReal("amazon-sidebar-after-plus.html");
    const minus = document.querySelector('#nav-flyout-ewc [data-action="a-stepper-decrement"]');
    const signal = classifyClick(minus, new URL("https://www.amazon.com/dp/B0TEST0009"));
    expect(signal).toMatchObject({ intent: "decrease_qty", source: "known" });
    w.handler.noteEditClick(signal!);

    document.body.innerHTML = body("amazon-sidebar-after-minus.html");
    await w.settle();

    expect(w.decided[0]!.trigger).toMatchObject({ intent: "decrease_qty", source: "known" });
    expect(w.events[0]).toMatchObject({ action: "removed", metadata: { precursor_decision_id: null } });
    w.stop();
    vi.useRealTimers();
  });

  it("deleting the last item (trash) in the real sidebar is asked about as remove_item", async () => {
    const w = await watchReal("amazon-sidebar-before-delete-last.html");
    const trash = document.querySelector('#nav-flyout-ewc [data-action="a-stepper-decrement"]');
    const signal = classifyClick(trash, new URL("https://www.amazon.com/dp/B0TEST0010"));
    expect(signal).toMatchObject({ intent: "remove_item", source: "known" });
    w.handler.noteEditClick(signal!);

    document.body.innerHTML = body("amazon-sidebar-after-delete-last.html");
    await w.settle();

    expect(w.decided).toHaveLength(1);
    expect(w.decided[0]!.trigger).toMatchObject({ intent: "remove_item", source: "known" });
    expect(w.decided[0]!.cart.items).toEqual([expect.objectContaining({ price_minor: 1699, qty: 1 })]);
    expect(w.events[0]).toMatchObject({ action: "removed", metadata: { after_total_minor: 0 } });
    w.stop();
    vi.useRealTimers();
  });
});
