import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readAmazonMiniCart } from "../cart";
// Sanitized copy of a real product page saved right after removing an item
// from the cart sidebar (product names and IDs replaced).
import miniCartHtml from "../cart/__fixtures__/amazon-product-minicart.html?raw";
import type { CartDraft } from "../messages";
import { MINI_CART_DEBOUNCE_MS, watchMiniCart } from "./sidesheet";

function cart(items: CartDraft["items"]): CartDraft {
  return {
    merchant: "amazon.com",
    items,
    total_minor: items.reduce((sum, item) => sum + item.price_minor * item.qty, 0),
    currency: "USD",
    url: "https://www.amazon.com/dp/B000000000",
  };
}

const mug = { name: "Mug", price_minor: 999, qty: 3 };
const lamp = { name: "Lamp", price_minor: 3399, qty: 1 };

// What the fake reader returns on its next call.
let reading: CartDraft | null;
const read = () => reading;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="nav-flyout-ewc"><span id="subtotal"></span></div><div id="carousel"></div>';
  reading = cart([mug, lamp]);
});

afterEach(() => {
  vi.useRealTimers();
});

// MutationObserver callbacks run as microtasks, so let them flush first.
async function flush(ms = MINI_CART_DEBOUNCE_MS): Promise<void> {
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(ms);
}

function touchFlyout(text = "changed"): void {
  document.getElementById("subtotal")!.textContent = text;
}

describe("watchMiniCart", () => {
  it("reports an item removed from the flyout", async () => {
    const onChange = vi.fn();
    const stop = watchMiniCart(document, read, { onChange });

    reading = cart([mug]);
    touchFlyout();
    await flush();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(cart([mug, lamp]), cart([mug]), { removed: [lamp], added: [] });
    stop();
  });

  it("reports a quantity raised with the + stepper as added", async () => {
    const onChange = vi.fn();
    const stop = watchMiniCart(document, read, { onChange });

    reading = cart([{ ...mug, qty: 4 }, lamp]);
    touchFlyout();
    await flush();

    expect(onChange).toHaveBeenCalledWith(cart([mug, lamp]), cart([{ ...mug, qty: 4 }, lamp]), {
      removed: [],
      added: [{ ...mug, qty: 1 }],
    });
    stop();
  });

  it("reports a quantity lowered as removed", async () => {
    const onChange = vi.fn();
    const stop = watchMiniCart(document, read, { onChange });

    reading = cart([{ ...mug, qty: 1 }, lamp]);
    touchFlyout();
    await flush();

    expect(onChange.mock.calls[0]?.[2]).toEqual({ removed: [{ ...mug, qty: 2 }], added: [] });
    stop();
  });

  it("re-reads once after a burst of changes settles", async () => {
    const onChange = vi.fn();
    const stop = watchMiniCart(document, read, { onChange });

    reading = cart([mug]);
    touchFlyout("1");
    await flush(200);
    touchFlyout("2");
    await flush(200);
    expect(onChange).not.toHaveBeenCalled();

    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stays quiet when the cart reads the same", async () => {
    const onChange = vi.fn();
    const stop = watchMiniCart(document, read, { onChange });

    touchFlyout();
    await flush();

    expect(onChange).not.toHaveBeenCalled();
    stop();
  });

  it("keeps the last good reading through an unreadable one", async () => {
    const onChange = vi.fn();
    const stop = watchMiniCart(document, read, { onChange });

    // Mid-removal: the item is marked removed but the subtotal hasn't caught up.
    reading = null;
    touchFlyout("spinner");
    await flush();
    expect(onChange).not.toHaveBeenCalled();

    reading = cart([mug]);
    touchFlyout("done");
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(cart([mug, lamp]), cart([mug]), { removed: [lamp], added: [] });
    stop();
  });

  it("takes the first good reading as the baseline without reporting it", async () => {
    reading = null;
    const onChange = vi.fn();
    const stop = watchMiniCart(document, read, { onChange });

    reading = cart([mug, lamp]);
    touchFlyout("loaded");
    await flush();
    expect(onChange).not.toHaveBeenCalled();

    reading = cart([lamp]);
    touchFlyout("removed");
    await flush();
    expect(onChange).toHaveBeenCalledWith(cart([mug, lamp]), cart([lamp]), { removed: [mug], added: [] });
    stop();
  });

  it("ignores changes outside the flyout", async () => {
    const onChange = vi.fn();
    const stop = watchMiniCart(document, read, { onChange });

    reading = cart([mug]);
    document.getElementById("carousel")!.textContent = "next slide";
    await flush();

    expect(onChange).not.toHaveBeenCalled();
    stop();
  });

  it("notices attribute changes in the flyout, like a message losing aok-hidden", async () => {
    document.getElementById("subtotal")!.className = "aok-hidden";
    const onChange = vi.fn();
    const stop = watchMiniCart(document, read, { onChange });

    reading = cart([mug]);
    document.getElementById("subtotal")!.className = "";
    await flush();

    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it("re-reads when the flyout is added after load", async () => {
    document.body.innerHTML = '<div id="carousel"></div>';
    reading = null;
    const onChange = vi.fn();
    const stop = watchMiniCart(document, read, { onChange });

    reading = cart([mug, lamp]);
    const flyout = document.createElement("div");
    flyout.id = "nav-flyout-ewc";
    document.body.append(flyout);
    await flush();

    reading = cart([mug]);
    flyout.textContent = "removed";
    await flush();

    expect(onChange).toHaveBeenCalledWith(cart([mug, lamp]), cart([mug]), { removed: [lamp], added: [] });
    stop();
  });

  it("survives a reader or handler that throws", async () => {
    const onChange = vi.fn(() => {
      throw new Error("handler bug");
    });
    let broken = true;
    const stop = watchMiniCart(
      document,
      () => {
        if (broken) throw new Error("reader bug");
        return reading;
      },
      { onChange },
    );

    // The throwing initial read counts as unreadable; this one is the baseline.
    broken = false;
    touchFlyout("1");
    await flush();

    reading = cart([mug]);
    touchFlyout("2");
    await expect(flush()).resolves.toBeUndefined();
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stops watching after stop()", async () => {
    const onChange = vi.fn();
    const stop = watchMiniCart(document, read, { onChange });

    reading = cart([mug]);
    touchFlyout();
    stop();
    await flush(1_000);

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("watchMiniCart on a real product page", () => {
  const url = new URL("https://www.amazon.com/Water-Bottle/dp/B0TEST0009");
  const readReal = () => readAmazonMiniCart(document, url).draft;
  const keyboard = { name: "Wireless keyboard, full size", price_minor: 3999, qty: 1 };
  const mugs = { name: "Ceramic coffee mug, 12 oz, matte black", price_minor: 999, qty: 3 };

  beforeEach(() => {
    document.body.innerHTML = new DOMParser().parseFromString(miniCartHtml, "text/html").body.innerHTML;
  });

  const line = (asin: string) => document.querySelector(`#nav-flyout-ewc .ewc-item[data-asin="${asin}"]`)!;
  const setSubtotal = (text: string) => {
    document.querySelector("#nav-flyout-ewc .ewc-subtotal-amount h2")!.textContent = text;
  };

  it("reads the saved sidebar as the baseline (the line already removed there is skipped)", () => {
    expect(readReal()?.items).toEqual([keyboard, mugs]);
    expect(readReal()?.total_minor).toBe(6996);
  });

  it("reports one removal when an item is deleted from the sidebar", async () => {
    const onChange = vi.fn();
    const stop = watchMiniCart(document, readReal, { onChange });

    // What the saved page shows for a removed line: its remove message is
    // visible and its content and stepper are gone. The order of the line
    // and subtotal updates isn't known, so the line goes first here and the
    // in-between state (lines don't add up) must not fire.
    const removed = line("B0TEST0008");
    removed.querySelector(".ewc-item-remove-msg")!.classList.remove("aok-hidden");
    removed.querySelector(".ewc-item-content")?.remove();
    removed.querySelector(".ewc-qty-and-action-items")?.remove();
    await flush();
    expect(readReal()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    setSubtotal("$29.97");
    await flush();

    expect(onChange).toHaveBeenCalledTimes(1);
    const [before, after, diff] = onChange.mock.calls[0]!;
    expect(before.items).toEqual([keyboard, mugs]);
    expect(after.items).toEqual([mugs]);
    expect(diff).toEqual({ removed: [keyboard], added: [] });
    stop();
  });

  it("reports one removal when the subtotal updates before the line", async () => {
    const onChange = vi.fn();
    const stop = watchMiniCart(document, readReal, { onChange });

    setSubtotal("$29.97");
    await flush();
    expect(onChange).not.toHaveBeenCalled();

    line("B0TEST0008").querySelector(".ewc-item-remove-msg")!.classList.remove("aok-hidden");
    await flush();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![2]).toEqual({ removed: [keyboard], added: [] });
    stop();
  });

  // No real save of a sidebar Save for later yet: this unhides the hidden
  // message the saved page carries for it, which is what the reader checks.
  it("reports a moved-to-Save-for-later line as removed", async () => {
    const onChange = vi.fn();
    const stop = watchMiniCart(document, readReal, { onChange });

    line("B0TEST0001").querySelector(".ewc-item-moved-to-sfl-msg")!.classList.remove("aok-hidden");
    setSubtotal("$39.99");
    await flush();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![2]).toEqual({ removed: [mugs], added: [] });
    stop();
  });

  // No real save of a quantity change yet, so how Amazon re-renders the line
  // is unknown: this sets the attributes the reader reads.
  it("reports a higher quantity as added", async () => {
    const onChange = vi.fn();
    const stop = watchMiniCart(document, readReal, { onChange });

    line("B0TEST0001").setAttribute("data-quantity", "4");
    setSubtotal("$79.95");
    await flush();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![2]).toEqual({ removed: [], added: [{ ...mugs, qty: 1 }] });
    stop();
  });
});
