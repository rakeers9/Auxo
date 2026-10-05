import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
