import type { DecisionEvent, TriggerPageType, Verdict } from "@auxo/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CartFlow, CartFlowOutcome, LastDecision } from "../flow";
import type { CartDraft, ClickSignal, PageInspection } from "../messages";
import { createPendingStore } from "./pending";
import { createTracker, type TrackerNote } from "./tracker";

const NOW = new Date("2026-10-04T20:00:00.000Z");
const mug = { name: "Mug", price_minor: 999, qty: 3 };
const lamp = { name: "Lamp", price_minor: 3399, qty: 1 };
const draftOf = (items: CartDraft["items"]): CartDraft => ({
  merchant: "amazon.com",
  items,
  total_minor: items.reduce((s, i) => s + i.price_minor * i.qty, 0),
  currency: "USD",
  url: "https://www.amazon.com/gp/cart/view.html",
});
const verdict = (id: string): Verdict => ({
  decision_id: id,
  lane: "L1",
  action: "allow",
  template_id: "l1-banner",
  cooldown_seconds: 0,
});

const signal = (intent: ClickSignal["intent"]): ClickSignal => ({ intent, source: "known", label: "Btn" });

function setup(initial: PageInspection) {
  let inspection = initial;
  let last: LastDecision | null = null;
  const check = vi.fn<CartFlow["check"]>(async () => {
    const draft = inspection.draft!;
    // The fake only decides on pages the real flow decides on.
    const pageType = inspection.pageType as TriggerPageType;
    const outcome = {
      status: "shown" as const,
      pageType,
      draft,
      cartHash: "h",
      trigger: { intent: "page_view" as const, source: "page" as const, page_type: pageType, occurred_at: NOW.toISOString() },
      verdict: verdict("2b9ebefe-78c8-561e-9a68-da51842c65a8"),
    } satisfies CartFlowOutcome;
    last = { decisionId: outcome.verdict.decision_id, draft, cartHash: "h", pageType };
    return outcome;
  });
  const flow: CartFlow = { check, lastDecision: () => last };
  const pending = createPendingStore(sessionStorage);
  const sent: DecisionEvent[] = [];
  const notes: TrackerNote[] = [];
  const tracker = createTracker({
    flow,
    pending,
    inspect: () => inspection,
    sendEvent: (e) => sent.push(e),
    now: () => NOW,
    note: (n) => notes.push(n),
  });
  return {
    tracker,
    check,
    pending,
    sent,
    notes,
    setPage: (p: PageInspection) => {
      inspection = p;
    },
  };
}

beforeEach(() => sessionStorage.clear());

const cartPage = (items: CartDraft["items"]): PageInspection => ({ pageType: "cart", draft: draftOf(items), problems: [] });

describe("createTracker", () => {
  it("reads the product right away on an add-to-cart click on a product page", async () => {
    const t = setup({ pageType: "product", draft: draftOf([lamp]), problems: [] });

    await t.tracker.onBuyIntent(signal("add_to_cart"));

    expect(t.check).toHaveBeenCalledWith({ signal: signal("add_to_cart"), pageType: "product", at: NOW.toISOString() });
    expect(t.pending.takeClick()).toBeNull();
  });

  it("remembers buy now / cart / checkout clicks for the next page", async () => {
    for (const intent of ["buy_now", "view_cart", "checkout"] as const) {
      const t = setup({ pageType: "product", draft: draftOf([lamp]), problems: [] });
      await t.tracker.onBuyIntent(signal(intent));

      expect(t.check).not.toHaveBeenCalled();
      expect(t.pending.takeClick()?.signal.intent).toBe(intent);
    }
  });

  it("uses the remembered click on the next page load", async () => {
    const first = setup({ pageType: "product", draft: draftOf([lamp]), problems: [] });
    await first.tracker.onBuyIntent(signal("buy_now"));

    const next = setup({ pageType: "checkout", draft: draftOf([lamp]), problems: [] });
    await next.tracker.onLoad();

    expect(next.check).toHaveBeenCalledWith({ signal: signal("buy_now"), pageType: "product", at: NOW.toISOString() });
  });

  it("keeps the click until the page is read, then forgets it", async () => {
    const first = setup({ pageType: "product", draft: draftOf([lamp]), problems: [] });
    await first.tracker.onBuyIntent(signal("buy_now"));

    // Checkout loads before its items render: not readable yet.
    const next = setup({ pageType: "checkout", draft: null, problems: ["items not shown yet"] });
    next.check.mockImplementation(async () => ({ status: "unreadable", pageType: "checkout", problems: ["items not shown yet"] }));
    await next.tracker.onLoad();
    expect(next.check).toHaveBeenLastCalledWith({ signal: signal("buy_now"), pageType: "product", at: NOW.toISOString() });

    // Still not ready on the first re-render: the click keeps waiting.
    await next.tracker.onPageChange();
    expect(next.check).toHaveBeenLastCalledWith({ signal: signal("buy_now"), pageType: "product", at: NOW.toISOString() });

    // The items render: the read succeeds with the click, and it's used up.
    next.check.mockResolvedValueOnce({
      status: "shown",
      pageType: "checkout",
      draft: draftOf([lamp]),
      cartHash: "h",
      trigger: { intent: "buy_now", source: "known", page_type: "checkout", occurred_at: NOW.toISOString() },
      verdict: verdict("2b9ebefe-78c8-561e-9a68-da51842c65a8"),
    });
    await next.tracker.onPageChange();
    expect(next.check).toHaveBeenLastCalledWith({ signal: signal("buy_now"), pageType: "product", at: NOW.toISOString() });

    await next.tracker.onPageChange();
    expect(next.check).toHaveBeenLastCalledWith(null);
  });

  it("forgets the click once a page is read, even if it isn't a shopping page", async () => {
    const first = setup({ pageType: "product", draft: draftOf([lamp]), problems: [] });
    await first.tracker.onBuyIntent(signal("view_cart"));

    const next = setup({ pageType: "other", draft: null, problems: [] });
    next.check.mockResolvedValue({ status: "skipped", pageType: "other", reason: "not_shopping_page" });
    await next.tracker.onLoad();
    await next.tracker.onPageChange();

    expect(next.check).toHaveBeenLastCalledWith(null);
    expect(next.pending.takeClick()).toBeNull();
  });

  it("does not use up the remembered click on in-page changes", async () => {
    const t = setup({ pageType: "product", draft: draftOf([lamp]), problems: [] });
    await t.tracker.onBuyIntent(signal("buy_now"));
    await t.tracker.onPageChange();

    expect(t.check).toHaveBeenLastCalledWith(null);
    expect(t.pending.takeClick()?.signal.intent).toBe("buy_now");
  });

  it("reports items removed after a decision, once", async () => {
    const t = setup(cartPage([mug, lamp]));
    await t.tracker.onLoad();

    t.setPage(cartPage([{ ...mug, qty: 1 }]));
    await t.tracker.onPageChange();
    await t.tracker.onPageChange();

    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({
      decision_id: "2b9ebefe-78c8-561e-9a68-da51842c65a8",
      action: "removed",
      occurred_at: NOW.toISOString(),
      metadata: {
        removed: [
          { name: "Mug", price_minor: 999, qty: 2 },
          { name: "Lamp", price_minor: 3399, qty: 1 },
        ],
        before_total_minor: 6396,
        after_total_minor: 999,
        currency: "USD",
        page_type: "cart",
      },
    });
  });

  it("doesn't report removals before any decision, or for additions", async () => {
    const t = setup(cartPage([mug]));
    await t.tracker.onPageChange();
    t.setPage(cartPage([mug, lamp]));
    await t.tracker.onPageChange();

    expect(t.sent).toEqual([]);
  });

  it("remembers the checkout decision on a place-order click", async () => {
    const t = setup({ pageType: "checkout", draft: draftOf([lamp]), problems: [] });
    await t.tracker.onLoad();

    expect(await t.tracker.onBuyIntent(signal("place_order"))).toBeNull();
    expect(t.pending.takePurchase()).toEqual({
      decisionId: "2b9ebefe-78c8-561e-9a68-da51842c65a8",
      draft: draftOf([lamp]),
      at: NOW.toISOString(),
    });
    expect(t.notes.some((n) => n.kind === "purchase_pending")).toBe(true);
  });

  it("ignores a place-order click with no checkout decision", async () => {
    const t = setup({ pageType: "checkout", draft: draftOf([lamp]), problems: [] });

    await t.tracker.onBuyIntent(signal("place_order"));
    expect(t.pending.takePurchase()).toBeNull();
  });

  it("notes clicks, outcomes, and events for the debug panel", async () => {
    const t = setup(cartPage([mug, lamp]));
    await t.tracker.onBuyIntent(signal("checkout"));
    await t.tracker.onLoad();
    t.setPage(cartPage([mug]));
    await t.tracker.onPageChange();

    expect(t.notes.map((n) => n.kind)).toEqual(["click", "outcome", "event", "outcome"]);
  });
});
