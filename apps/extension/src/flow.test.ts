import type { Cart, Trigger, Verdict } from "@auxo/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCartFlow, type CartFlowDeps } from "./flow";
import type { CartDraft, DecideResult, PageInspection } from "./messages";
import type { PendingClick } from "./tracking/pending";

const draft: CartDraft = {
  merchant: "amazon.com",
  items: [{ name: "Desk lamp", price_minor: 2499, qty: 1 }],
  total_minor: 2499,
  currency: "USD",
  url: "https://www.amazon.com/gp/cart/view.html",
};
const HASH = "c".repeat(64);
const NOW = new Date("2026-10-04T20:00:00.000Z");
const verdict: Verdict = {
  decision_id: "2b9ebefe-78c8-561e-9a68-da51842c65a8",
  lane: "L2",
  action: "pause",
  template_id: "l2-pause",
  cooldown_seconds: 60,
};

const page = (pageType: PageInspection["pageType"], d: CartDraft | null = draft): PageInspection => ({
  pageType,
  draft: d,
  problems: d ? [] : ["could not read"],
});

const click = (intent: PendingClick["signal"]["intent"], source: "known" | "guess" = "known"): PendingClick => ({
  signal: { intent, source, label: "Button" },
  pageType: "product",
  at: "2026-10-04T19:59:59.000Z",
});

function deps(overrides: Partial<CartFlowDeps> = {}) {
  const requestVerdict = vi.fn<(cart: Cart, trigger: Trigger) => Promise<DecideResult>>().mockResolvedValue({ ok: true, verdict });
  const show = vi.fn<(verdict: Verdict, trigger: Trigger) => void>();
  return {
    requestVerdict,
    show,
    deps: {
      inspect: () => page("cart"),
      hash: async () => HASH,
      requestVerdict,
      show,
      now: () => NOW,
      ...overrides,
    } satisfies CartFlowDeps,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createCartFlow", () => {
  it("asks about a cart page with a page_view trigger and shows the verdict", async () => {
    const d = deps();
    const outcome = await createCartFlow(d.deps).check();

    const trigger = { intent: "page_view", source: "page", page_type: "cart", occurred_at: NOW.toISOString() };
    expect(outcome).toEqual({ status: "shown", pageType: "cart", draft, cartHash: HASH, trigger, verdict });
    expect(d.requestVerdict).toHaveBeenCalledWith({ ...draft, cart_hash: HASH }, trigger);
    expect(d.show).toHaveBeenCalledWith(verdict, trigger);
  });

  it("sends the click as the trigger when there is one", async () => {
    const d = deps({ inspect: () => page("checkout") });
    await createCartFlow(d.deps).check(click("buy_now"));

    expect(d.requestVerdict.mock.calls[0]?.[1]).toEqual({
      intent: "buy_now",
      source: "known",
      page_type: "checkout",
      occurred_at: "2026-10-04T19:59:59.000Z",
      label: "Button",
    });
  });

  it("skips pages that aren't for shopping", async () => {
    const d = deps({ inspect: () => page("other", null) });

    expect(await createCartFlow(d.deps).check(click("add_to_cart"))).toEqual({
      status: "skipped",
      pageType: "other",
      reason: "not_shopping_page",
    });
    expect(d.requestVerdict).not.toHaveBeenCalled();
  });

  describe("the added-to-cart page", () => {
    const added: CartDraft = { ...draft, url: "https://www.amazon.com/cart/smart-wagon" };
    const wholeCart: CartDraft = {
      ...draft,
      items: [{ name: "Desk lamp", price_minor: 2499, qty: 1 }, { name: "Mug", price_minor: 999, qty: 2 }],
      total_minor: 4497,
    };

    it("asks about the whole cart for the add-to-cart click that led there", async () => {
      const d = deps({ inspect: () => page("added_to_cart", added), wholeCart: () => wholeCart });

      const outcome = await createCartFlow(d.deps).check(click("add_to_cart"));

      expect(outcome).toMatchObject({ status: "shown", pageType: "cart", draft: wholeCart });
      expect(d.requestVerdict).toHaveBeenCalledTimes(1);
      expect(d.requestVerdict.mock.calls[0]?.[0]).toMatchObject({ items: wholeCart.items, total_minor: 4497 });
      // The backend sees a cart view, with the click that caused it.
      expect(d.requestVerdict.mock.calls[0]?.[1]).toMatchObject({ intent: "add_to_cart", source: "known", page_type: "cart" });
    });

    it("falls back to what was added when the whole cart can't be read", async () => {
      for (const wholeCartDep of [() => null, () => Promise.reject(new Error("boom")), () => ({ ...draft, items: [] })]) {
        const d = deps({ inspect: () => page("added_to_cart", added), wholeCart: wholeCartDep });
        expect(await createCartFlow(d.deps).check(click("add_to_cart"))).toMatchObject({ status: "shown", draft: added });
      }
    });

    it("doesn't ask without an add-to-cart click (reload, or coming Back)", async () => {
      const d = deps({ inspect: () => page("added_to_cart", added), wholeCart: () => wholeCart });
      const skipped = { status: "skipped", pageType: "added_to_cart", reason: "added_to_cart_page" };

      expect(await createCartFlow(d.deps).check()).toEqual(skipped);
      expect(await createCartFlow(d.deps).check(click("view_cart"))).toEqual(skipped);
      expect(d.requestVerdict).not.toHaveBeenCalled();
    });

    it("keeps the click for a retry when the page isn't readable yet", async () => {
      const d = deps({ inspect: () => page("added_to_cart", null) });

      expect(await createCartFlow(d.deps).check(click("add_to_cart"))).toMatchObject({ status: "unreadable", pageType: "added_to_cart" });
      expect(d.requestVerdict).not.toHaveBeenCalled();
    });
  });

  it("never asks about a product page, with or without a click (the cart is the source of truth)", async () => {
    const d = deps({ inspect: () => page("product") });
    const flow = createCartFlow(d.deps);

    for (const check of [flow.check(), flow.check(click("buy_now")), flow.check(click("add_to_cart"))]) {
      expect(await check).toMatchObject({ status: "skipped", pageType: "product", reason: "product_page" });
    }
    expect(d.requestVerdict).not.toHaveBeenCalled();
  });

  it("reports why an unreadable page wasn't asked about", async () => {
    const d = deps({ inspect: () => page("cart", null) });

    expect(await createCartFlow(d.deps).check()).toEqual({
      status: "unreadable",
      pageType: "cart",
      problems: ["could not read"],
    });
    expect(d.requestVerdict).not.toHaveBeenCalled();
  });

  it("doesn't ask about an empty cart", async () => {
    const d = deps({ inspect: () => page("cart", { ...draft, items: [], total_minor: 0 }) });

    expect(await createCartFlow(d.deps).check()).toEqual({ status: "unreadable", pageType: "cart", problems: ["the cart is empty"] });
    expect(d.requestVerdict).not.toHaveBeenCalled();
  });

  it("re-sends the same cart, tagged same_cart, and leaves the decision to the backend", async () => {
    const d = deps();
    const flow = createCartFlow(d.deps);

    await flow.check();
    const second = await flow.check();
    expect(d.requestVerdict).toHaveBeenCalledTimes(2);
    expect(d.requestVerdict.mock.calls[0]?.[1]).not.toHaveProperty("same_cart");
    expect(d.requestVerdict.mock.calls[1]?.[1]).toMatchObject({ intent: "page_view", same_cart: true });
    expect(second).toMatchObject({ status: "shown" });
  });

  it("a click is never tagged same_cart", async () => {
    const d = deps();
    const flow = createCartFlow(d.deps);

    await flow.check();
    await flow.check(click("checkout"));
    expect(d.requestVerdict.mock.calls[1]?.[1]).not.toHaveProperty("same_cart");
  });

  it("re-asks about the same cart after a new click", async () => {
    const d = deps();
    const flow = createCartFlow(d.deps);

    await flow.check();
    await flow.check(click("checkout"));
    expect(d.requestVerdict).toHaveBeenCalledTimes(2);
  });

  it("re-asks when the cart changes", async () => {
    let hash = HASH;
    const d = deps({ hash: async () => hash });
    const flow = createCartFlow(d.deps);

    await flow.check();
    hash = "d".repeat(64);
    await flow.check();
    expect(d.requestVerdict).toHaveBeenCalledTimes(2);
  });

  it("remembers the last decision", async () => {
    const d = deps();
    const flow = createCartFlow(d.deps);

    expect(flow.lastDecision()).toBeNull();
    await flow.check();
    expect(flow.lastDecision()).toEqual({ decisionId: verdict.decision_id, draft, cartHash: HASH, pageType: "cart" });
  });

  it("fails open when the API fails, and keeps no decision", async () => {
    const d = deps();
    d.requestVerdict.mockResolvedValue({ ok: false, reason: "http" });
    const flow = createCartFlow(d.deps);

    expect(await flow.check()).toMatchObject({ status: "failed_open", reason: "http" });
    expect(d.show).not.toHaveBeenCalled();
    expect(flow.lastDecision()).toBeNull();
  });

  it("fails open when the worker throws", async () => {
    const d = deps();
    d.requestVerdict.mockRejectedValue(new Error("worker gone"));

    expect(await createCartFlow(d.deps).check()).toMatchObject({ status: "failed_open", reason: "network" });
  });

  it("fails open when the worker never answers", async () => {
    vi.useFakeTimers();
    const d = deps({ timeoutMs: 3_000 });
    d.requestVerdict.mockImplementation(() => new Promise(() => {}));

    const pending = createCartFlow(d.deps).check();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(await pending).toMatchObject({ status: "failed_open", reason: "timeout" });
    expect(d.show).not.toHaveBeenCalled();
  });
});
