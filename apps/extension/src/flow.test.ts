import type { Cart, Verdict } from "@auxo/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCartFlow, type CartFlowDeps } from "./flow";
import type { CartDraft, DecideResult } from "./messages";

const draft: CartDraft = {
  merchant: "amazon.com",
  items: [{ name: "Desk lamp", price_minor: 2499, qty: 1 }],
  total_minor: 2499,
  currency: "USD",
  url: "https://www.amazon.com/gp/cart/view.html",
};
const HASH = "c".repeat(64);
const verdict: Verdict = {
  decision_id: "2b9ebefe-78c8-561e-9a68-da51842c65a8",
  lane: "L2",
  action: "pause",
  template_id: "l2-pause",
  cooldown_seconds: 60,
};

function deps(overrides: Partial<CartFlowDeps> = {}): CartFlowDeps {
  return {
    isCartPage: () => true,
    extract: () => draft,
    hash: async () => HASH,
    requestVerdict: vi.fn<(cart: Cart) => Promise<DecideResult>>().mockResolvedValue({ ok: true, verdict }),
    show: vi.fn<(verdict: Verdict) => void>(),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createCartFlow", () => {
  it("sends the hashed cart and shows the verdict", async () => {
    const d = deps();

    expect(await createCartFlow(d)()).toEqual({ status: "shown", verdict, cartHash: HASH });
    expect(d.requestVerdict).toHaveBeenCalledWith({ ...draft, cart_hash: HASH });
    expect(d.show).toHaveBeenCalledWith(verdict);
  });

  it("does nothing off the cart page", async () => {
    const d = deps({ isCartPage: () => false });

    expect(await createCartFlow(d)()).toEqual({ status: "not_cart" });
    expect(d.requestVerdict).not.toHaveBeenCalled();
  });

  it("does nothing when the cart cannot be read", async () => {
    const d = deps({ extract: () => null });

    expect(await createCartFlow(d)()).toEqual({ status: "unreadable" });
    expect(d.requestVerdict).not.toHaveBeenCalled();
  });

  it("asks only once for the same cart", async () => {
    const d = deps();
    const run = createCartFlow(d);

    await run();
    expect(await run()).toEqual({ status: "unchanged", cartHash: HASH });
    expect(d.requestVerdict).toHaveBeenCalledTimes(1);
    expect(d.show).toHaveBeenCalledTimes(1);
  });

  it("asks again when the cart changes", async () => {
    let hash = HASH;
    const d = deps({ hash: async () => hash });
    const run = createCartFlow(d);

    await run();
    hash = "d".repeat(64);
    await run();
    expect(d.requestVerdict).toHaveBeenCalledTimes(2);
  });

  it("fails open when the API fails", async () => {
    const d = deps({
      requestVerdict: vi.fn<(cart: Cart) => Promise<DecideResult>>().mockResolvedValue({ ok: false, reason: "http" }),
    });

    expect(await createCartFlow(d)()).toEqual({ status: "failed_open", reason: "http", cartHash: HASH });
    expect(d.show).not.toHaveBeenCalled();
  });

  it("fails open when the worker throws", async () => {
    const d = deps({
      requestVerdict: vi.fn<(cart: Cart) => Promise<DecideResult>>().mockRejectedValue(new Error("worker gone")),
    });

    expect(await createCartFlow(d)()).toEqual({ status: "failed_open", reason: "network", cartHash: HASH });
  });

  it("fails open when the worker never answers", async () => {
    vi.useFakeTimers();
    const d = deps({
      requestVerdict: vi.fn<(cart: Cart) => Promise<DecideResult>>(() => new Promise(() => {})),
      timeoutMs: 3_000,
    });

    const pending = createCartFlow(d)();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(await pending).toEqual({ status: "failed_open", reason: "timeout", cartHash: HASH });
    expect(d.show).not.toHaveBeenCalled();
  });
});
