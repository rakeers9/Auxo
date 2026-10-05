import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CartDraft } from "../messages";
import { CART_API_DEBOUNCE_MS, watchCartApi } from "./cart-api-watch";

const tee = { name: "Tee", price_minor: 2500, qty: 1 };
const cap = { name: "Cap", price_minor: 1500, qty: 1 };
const cart = (items: CartDraft["items"]): CartDraft => ({
  merchant: "shop.example.com",
  items,
  total_minor: items.reduce((s, i) => s + i.price_minor * i.qty, 0),
  currency: "USD",
  url: "https://shop.example.com/cart",
});

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="drawer"></div><div id="ours"></div>';
});
afterEach(() => vi.useRealTimers());

async function settle(ms = CART_API_DEBOUNCE_MS) {
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(ms);
}

describe("watchCartApi", () => {
  it("reads a baseline, then reports an add after the page changes", async () => {
    let reading: CartDraft | null = cart([tee]);
    const onChange = vi.fn();
    const w = watchCartApi(document, async () => reading, { onChange });
    await settle(0);
    expect(w.current()).toEqual(cart([tee]));

    reading = cart([tee, cap]);
    document.getElementById("drawer")!.textContent = "2 items";
    await settle();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![2]).toEqual({ removed: [], added: [cap] });
    w.stop();
  });

  it("reports a removal on refresh() without waiting for a page change", async () => {
    let reading: CartDraft | null = cart([tee, cap]);
    const onChange = vi.fn();
    const w = watchCartApi(document, async () => reading, { onChange });
    await settle(0);

    reading = cart([tee]);
    await w.refresh();
    expect(onChange.mock.calls[0]![2]).toEqual({ removed: [cap], added: [] });
    w.stop();
  });

  it("a failed read never fires and keeps the last good cart", async () => {
    let reading: CartDraft | null = cart([tee]);
    const onChange = vi.fn();
    const w = watchCartApi(document, async () => reading, { onChange });
    await settle(0);

    reading = null;
    await w.refresh();
    expect(w.current()).toEqual(cart([tee]));

    reading = cart([tee, cap]);
    await w.refresh();
    expect(onChange).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it("never runs two reads at once; a change during a read causes one more", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const load = vi.fn(async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 100));
      inflight -= 1;
      return cart([tee]);
    });
    const w = watchCartApi(document, load, { onChange: vi.fn() });
    const a = w.refresh();
    const b = w.refresh();
    const c = w.refresh();
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([a, b, c]);

    expect(maxInflight).toBe(1);
    expect(load).toHaveBeenCalledTimes(2); // the baseline run, then one more for the changes during it
    w.stop();
  });

  it("ignores changes inside our own UI", async () => {
    const load = vi.fn(async () => cart([tee]));
    const w = watchCartApi(document, load, { onChange: vi.fn() }, { ignore: () => [document.getElementById("ours")] });
    await settle(0);
    load.mockClear();

    document.getElementById("ours")!.textContent = "tick";
    await settle(1_000);
    expect(load).not.toHaveBeenCalled();
    w.stop();
  });

  it("a throwing load is treated as a failed read", async () => {
    const onChange = vi.fn();
    const w = watchCartApi(document, async () => {
      throw new Error("offline");
    }, { onChange });
    await expect(w.refresh()).resolves.toBeUndefined();
    expect(w.current()).toBeNull();
    w.stop();
  });
});
