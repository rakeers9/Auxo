import type { DecisionEvent, Trigger } from "@auxo/shared";
import { describe, expect, it, vi } from "vitest";

import type { CartDraft, PageType } from "../messages";
import { createMiniCartHandler, type SidebarReport } from "./minicart-handler";

const NOW = new Date("2026-10-04T20:00:00.000Z");
const mug = { name: "Mug", price_minor: 999, qty: 3 };
const lamp = { name: "Lamp", price_minor: 3399, qty: 1 };
const cart = (items: CartDraft["items"]): CartDraft => ({
  merchant: "amazon.com",
  items,
  total_minor: items.reduce((s, i) => s + i.price_minor * i.qty, 0),
  currency: "USD",
  url: "https://www.amazon.com/gp/cart/view.html",
});

function setup(pageType: PageType = "product", decisionId: string | null = "dec-1") {
  const sent: DecisionEvent[] = [];
  const reports: SidebarReport[] = [];
  const decide = vi.fn<(d: CartDraft, t: Trigger) => Promise<void>>().mockResolvedValue();
  const decisionFor = vi.fn().mockResolvedValue(decisionId);
  const handler = createMiniCartHandler({
    decisionFor,
    sendEvent: (e) => sent.push(e),
    decide,
    pageType: () => pageType,
    now: () => NOW,
    report: (r) => reports.push(r),
  });
  return { handler, sent, decide, decisionFor, reports };
}

describe("createMiniCartHandler: removals", () => {
  it("asks the backend about every removal, and links it to the earlier decision too", async () => {
    const t = setup();
    await t.handler.onChange(cart([mug, lamp]), cart([mug]), { removed: [lamp], added: [] });

    expect(t.decide).toHaveBeenCalledWith(
      { merchant: "amazon.com", items: [lamp], total_minor: 3399, currency: "USD", url: cart([]).url },
      { intent: "remove_item", source: "page", page_type: "product", occurred_at: NOW.toISOString() },
    );
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({
      decision_id: "dec-1",
      action: "removed",
      metadata: { removed: [lamp], before_total_minor: 6396, after_total_minor: 2997, source: "mini_cart" },
    });
  });

  it("still asks the backend when no earlier decision covered the item", async () => {
    const t = setup("other", null);
    await t.handler.onChange(cart([mug, lamp]), cart([mug]), { removed: [lamp], added: [] });

    expect(t.sent).toEqual([]);
    expect(t.decide).toHaveBeenCalledTimes(1);
    expect(t.reports[0]).toMatchObject({ linkedDecision: null, removeIntent: "remove_item" });
  });

  it("calls a lower quantity decrease_qty when no click says otherwise", async () => {
    const t = setup();
    await t.handler.onChange(cart([mug]), cart([{ ...mug, qty: 1 }]), { removed: [{ ...mug, qty: 2 }], added: [] });

    expect(t.decide.mock.calls[0]?.[1]).toMatchObject({ intent: "decrease_qty", source: "page" });
    expect(t.decide.mock.calls[0]?.[0].items).toEqual([{ ...mug, qty: 2 }]);
  });

  it("credits the removal to the click that caused it, once", async () => {
    const t = setup();
    t.handler.noteEditClick({ intent: "save_for_later", source: "known", label: "Save for later" });

    await t.handler.onChange(cart([mug, lamp]), cart([mug]), { removed: [lamp], added: [] });
    expect(t.decide.mock.calls[0]?.[1]).toMatchObject({ intent: "save_for_later", source: "known", label: "Save for later" });

    await t.handler.onChange(cart([mug]), cart([]), { removed: [mug], added: [] });
    expect(t.decide.mock.calls[1]?.[1]).toMatchObject({ intent: "remove_item", source: "page" });
  });
});

describe("createMiniCartHandler: additions", () => {
  it("asks for a fresh decision when items are added from the sidebar", async () => {
    const t = setup("product");
    await t.handler.onChange(cart([mug]), cart([{ ...mug, qty: 4 }]), { removed: [], added: [{ ...mug, qty: 1 }] });

    expect(t.decide).toHaveBeenCalledWith(
      { merchant: "amazon.com", items: [{ name: "Mug", price_minor: 999, qty: 1 }], total_minor: 999, currency: "USD", url: cart([]).url },
      { intent: "add_to_cart", source: "page", page_type: "product", occurred_at: NOW.toISOString() },
    );
  });

  it("credits a + click as increase_qty", async () => {
    const t = setup("other");
    t.handler.noteEditClick({ intent: "increase_qty", source: "known", label: "Increase quantity" });

    await t.handler.onChange(cart([mug]), cart([{ ...mug, qty: 4 }]), { removed: [], added: [{ ...mug, qty: 1 }] });
    expect(t.decide.mock.calls[0]?.[1]).toMatchObject({ intent: "increase_qty", source: "known", label: "Increase quantity", page_type: "other" });
  });

  it("credits the next added items to an add-to-cart click, once", async () => {
    const t = setup("product");
    t.handler.noteEditClick({ intent: "add_to_cart", source: "known", label: "Add to cart" });

    await t.handler.onChange(cart([mug]), cart([mug, lamp]), { removed: [], added: [lamp] });
    expect(t.decide.mock.calls[0]?.[1]).toMatchObject({ intent: "add_to_cart", source: "known", label: "Add to cart" });

    await t.handler.onChange(cart([mug, lamp]), cart([mug, { ...lamp, qty: 2 }]), { removed: [], added: [lamp] });
    expect(t.decide.mock.calls[1]?.[1]).toMatchObject({ source: "page" });
    expect(t.decide.mock.calls[1]?.[1]).not.toHaveProperty("label");
  });

  it("doesn't double count an add that was already decided at the click", async () => {
    const t = setup("product");
    t.handler.noteClickedAdd(cart([lamp]));

    await t.handler.onChange(cart([mug]), cart([mug, lamp]), { removed: [], added: [lamp] });
    expect(t.decide).not.toHaveBeenCalled();

    // The click is used up: a second lamp from the sidebar is a new add.
    await t.handler.onChange(cart([mug, lamp]), cart([mug, { ...lamp, qty: 2 }]), { removed: [], added: [lamp] });
    expect(t.decide).toHaveBeenCalledTimes(1);
  });

  it("only subtracts the clicked quantity", async () => {
    const t = setup("product");
    t.handler.noteClickedAdd(cart([{ ...mug, qty: 1 }]));

    await t.handler.onChange(cart([]), cart([mug]), { removed: [], added: [mug] });
    expect(t.decide.mock.calls[0]?.[0].items).toEqual([{ name: "Mug", price_minor: 999, qty: 2 }]);
  });

  it("maps pages without a trigger page type to 'other'", async () => {
    const t = setup("added_to_cart");
    await t.handler.onChange(cart([mug]), cart([mug, lamp]), { removed: [], added: [lamp] });

    expect(t.decide.mock.calls[0]?.[1].page_type).toBe("other");
  });
});

describe("createMiniCartHandler: both at once", () => {
  it("handles a removal and an addition in one change, and reports both", async () => {
    const t = setup("product");
    await t.handler.onChange(cart([mug]), cart([lamp]), { removed: [mug], added: [lamp] });

    expect(t.sent).toHaveLength(1);
    expect(t.decide).toHaveBeenCalledTimes(2);
    expect(t.reports).toEqual([
      { removed: [mug], added: [lamp], linkedDecision: "dec-1", askedAbout: [lamp], removeIntent: "remove_item", addIntent: "add_to_cart" },
    ]);
  });
});
