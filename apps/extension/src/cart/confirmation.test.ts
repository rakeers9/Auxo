import type { DecisionEvent } from "@auxo/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPendingStore } from "../tracking/pending";
import { confirmPurchase } from "../tracking/purchase";
import { isAmazonOrderConfirmation, waitForAmazonOrderConfirmation } from "./confirmation";
import cartHtml from "./__fixtures__/amazon-cart.html?raw";
import addedHtml from "./__fixtures__/amazon-added-to-cart.html?raw";
import checkoutHtml from "./__fixtures__/amazon-checkout-from-cart.html?raw";
import confirmationHtml from "./__fixtures__/amazon-order-confirmation.html?raw";
import productHtml from "./__fixtures__/amazon-product.html?raw";

// The real URL shape, with its ids replaced by X.
const CONFIRMATION_URL = new URL(
  "https://www.amazon.com/gp/buy/thankyou/handlers/display.html?purchaseId=X&ref_=chk_typ_browserRefresh&isRefresh=1&executionId=X",
);

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("isAmazonOrderConfirmation", () => {
  it("is true on the real 'Order placed, thanks!' page", () => {
    expect(isAmazonOrderConfirmation(parse(confirmationHtml), CONFIRMATION_URL)).toBe(true);
  });

  it("is true on any thank-you path, with or without the query", () => {
    const doc = parse(confirmationHtml);
    expect(isAmazonOrderConfirmation(doc, new URL("https://www.amazon.com/gp/buy/thankyou/handlers/display.html"))).toBe(true);
    expect(isAmazonOrderConfirmation(doc, new URL("https://www.amazon.com/gp/buy/thankyou/other"))).toBe(true);
  });

  it("is false on the thank-you URL without the green 'Order placed' alert (a failed or pending order)", () => {
    const doc = parse(confirmationHtml);
    doc.querySelector(".a-alert-inline-success")!.classList.replace("a-alert-inline-success", "a-alert-inline-warning");
    expect(isAmazonOrderConfirmation(doc, CONFIRMATION_URL)).toBe(false);
  });

  it.each([
    ["cart", cartHtml, "https://www.amazon.com/gp/cart/view.html"],
    ["added to cart", addedHtml, "https://www.amazon.com/cart/smart-wagon?newItems=X"],
    ["checkout", checkoutHtml, "https://www.amazon.com/checkout/p/p-X/spc"],
    ["product", productHtml, "https://www.amazon.com/dp/B0TEST0005"],
  ])("is false on the %s page", (_, html, href) => {
    expect(isAmazonOrderConfirmation(parse(html), new URL(href))).toBe(false);
  });

  it("is false when the confirmation markup shows up on another path", () => {
    expect(isAmazonOrderConfirmation(parse(confirmationHtml), new URL("https://www.amazon.com/gp/cart/view.html"))).toBe(false);
  });

  it("is false off www.amazon.com or over http", () => {
    const doc = parse(confirmationHtml);
    expect(isAmazonOrderConfirmation(doc, new URL("https://www.amazon.co.uk/gp/buy/thankyou/handlers/display.html"))).toBe(false);
    expect(isAmazonOrderConfirmation(doc, new URL("http://www.amazon.com/gp/buy/thankyou/handlers/display.html"))).toBe(false);
  });

  it("follows a backend selector override", () => {
    const doc = parse(confirmationHtml);
    expect(isAmazonOrderConfirmation(doc, CONFIRMATION_URL, { "confirmation.placed": "#no-such-alert" })).toBe(false);
    expect(isAmazonOrderConfirmation(doc, CONFIRMATION_URL, { "confirmation.placed": "#widget-purchaseConfirmationStatus" })).toBe(true);
  });
});

describe("waitForAmazonOrderConfirmation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.documentElement.innerHTML = "";
  });

  // The live page, with Amazon's alert not drawn yet.
  function loadWithoutAlert() {
    document.documentElement.innerHTML = confirmationHtml;
    const alert = document.querySelector(".a-alert-inline-success")!;
    alert.classList.remove("a-alert-inline-success");
    return alert;
  }

  it("answers at once when the alert is already there", async () => {
    document.documentElement.innerHTML = confirmationHtml;
    await expect(waitForAmazonOrderConfirmation(document, CONFIRMATION_URL)).resolves.toBe(true);
  });

  it("answers false at once off the thank-you page, without waiting", async () => {
    vi.useFakeTimers();
    document.documentElement.innerHTML = cartHtml;
    let answer: boolean | undefined;
    void waitForAmazonOrderConfirmation(document, new URL("https://www.amazon.com/gp/cart/view.html")).then((a) => (answer = a));
    await vi.advanceTimersByTimeAsync(0);
    expect(answer).toBe(false);
  });

  it("waits for an alert Amazon draws late", async () => {
    vi.useFakeTimers();
    const alert = loadWithoutAlert();
    let answer: boolean | undefined;
    void waitForAmazonOrderConfirmation(document, CONFIRMATION_URL).then((a) => (answer = a));

    await vi.advanceTimersByTimeAsync(1_500);
    expect(answer).toBeUndefined();
    alert.classList.add("a-alert-inline-success");
    await vi.advanceTimersByTimeAsync(0);
    expect(answer).toBe(true);
  });

  it("sees an alert inserted as a new element", async () => {
    vi.useFakeTimers();
    loadWithoutAlert().remove();
    let answer: boolean | undefined;
    void waitForAmazonOrderConfirmation(document, CONFIRMATION_URL).then((a) => (answer = a));

    const late = document.createElement("div");
    late.className = "a-box a-alert-inline a-alert-inline-success";
    document.querySelector("#widget-purchaseConfirmationStatus")!.append(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(answer).toBe(true);
  });

  it("gives up after the timeout when the order wasn't placed", async () => {
    vi.useFakeTimers();
    loadWithoutAlert();
    let answer: boolean | undefined;
    void waitForAmazonOrderConfirmation(document, CONFIRMATION_URL, undefined, { timeoutMs: 5_000 }).then((a) => (answer = a));

    await vi.advanceTimersByTimeAsync(4_999);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toBe(false);
  });

  describe("always stops watching", () => {
    function watch() {
      const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
      return disconnect;
    }

    it("on the timeout", async () => {
      vi.useFakeTimers();
      loadWithoutAlert();
      const disconnect = watch();
      const answer = waitForAmazonOrderConfirmation(document, CONFIRMATION_URL);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(answer).resolves.toBe(false);
      expect(disconnect).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("on a match", async () => {
      vi.useFakeTimers();
      const alert = loadWithoutAlert();
      const disconnect = watch();
      const answer = waitForAmazonOrderConfirmation(document, CONFIRMATION_URL);
      alert.classList.add("a-alert-inline-success");
      await expect(answer).resolves.toBe(true);
      expect(disconnect).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("when the content script goes away mid-wait, and answers false", async () => {
      vi.useFakeTimers();
      const alert = loadWithoutAlert();
      const disconnect = watch();
      const stop = new AbortController();
      const answer = waitForAmazonOrderConfirmation(document, CONFIRMATION_URL, undefined, { signal: stop.signal });

      stop.abort();
      await expect(answer).resolves.toBe(false);
      expect(disconnect).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);

      // Nothing fires afterwards, even if the alert then shows up.
      alert.classList.add("a-alert-inline-success");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(disconnect).toHaveBeenCalledOnce();
    });

    it("doesn't start when already aborted", async () => {
      vi.useFakeTimers();
      loadWithoutAlert();
      const stop = new AbortController();
      stop.abort();
      await expect(waitForAmazonOrderConfirmation(document, CONFIRMATION_URL, undefined, { signal: stop.signal })).resolves.toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("answers once when the alert shows up as the timer fires", async () => {
    vi.useFakeTimers();
    const alert = loadWithoutAlert();
    const answers: boolean[] = [];
    void waitForAmazonOrderConfirmation(document, CONFIRMATION_URL, undefined, { timeoutMs: 1_000 }).then((a) => answers.push(a));

    await vi.advanceTimersByTimeAsync(999);
    alert.classList.add("a-alert-inline-success"); // observer queued...
    await vi.advanceTimersByTimeAsync(1); // ...and the timer fires in the same turn
    await vi.advanceTimersByTimeAsync(0);
    expect(answers).toEqual([true]);
  });

  it("sends bought once even when two waits both see the order placed", async () => {
    vi.useFakeTimers();
    const alert = loadWithoutAlert();
    const pending = createPendingStore(sessionStorage);
    pending.savePurchase({
      decisionId: "11111111-1111-4111-8111-111111111111",
      draft: { merchant: "amazon.com", items: [{ name: "Ceramic coffee mug", price_minor: 999, qty: 1 }], total_minor: 999, currency: "USD", url: "https://www.amazon.com/checkout" },
      at: "2026-11-06T12:00:00.000Z",
    });
    const sent: DecisionEvent[] = [];
    const confirm = async () => {
      if (await waitForAmazonOrderConfirmation(document, CONFIRMATION_URL)) confirmPurchase(createPendingStore(sessionStorage), (e) => sent.push(e));
    };

    const both = Promise.all([confirm(), confirm()]);
    alert.classList.add("a-alert-inline-success");
    await both;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: "bought", metadata: { confirmed: true } });
    sessionStorage.clear();
  });
});
