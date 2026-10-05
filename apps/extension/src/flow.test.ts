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

  it("doesn't ask again on the added-to-cart page (the click was already decided)", async () => {
    const d = deps({ inspect: () => page("added_to_cart") });

    expect(await createCartFlow(d.deps).check(click("view_cart"))).toEqual({
      status: "skipped",
      pageType: "added_to_cart",
      reason: "added_to_cart_page",
    });
    expect(d.requestVerdict).not.toHaveBeenCalled();
  });

  it("only asks on a product page after an add-to-cart click", async () => {
    const d = deps({ inspect: () => page("product") });
    const flow = createCartFlow(d.deps);

    expect(await flow.check()).toMatchObject({ status: "skipped", reason: "product_without_click" });
    expect(await flow.check(click("buy_now"))).toMatchObject({ status: "skipped", reason: "product_without_click" });
    expect(await flow.check(click("add_to_cart"))).toMatchObject({ status: "shown", pageType: "product" });
    expect(d.requestVerdict).toHaveBeenCalledTimes(1);
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

  it("doesn't re-ask about the same cart without a new click", async () => {
    const d = deps();
    const flow = createCartFlow(d.deps);

    await flow.check();
    expect(await flow.check()).toEqual({ status: "unchanged", pageType: "cart", draft, cartHash: HASH });
    expect(d.requestVerdict).toHaveBeenCalledTimes(1);
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
