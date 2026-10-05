import type { DecisionEvent, Trigger } from "@auxo/shared";
import { describe, expect, it, vi } from "vitest";

import type { CartDraft, PageType } from "../messages";
import { createMiniCartHandler } from "./minicart-handler";

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
  const decideAdded = vi.fn<(d: CartDraft, t: Trigger) => Promise<void>>().mockResolvedValue();
  const decisionFor = vi.fn().mockResolvedValue(decisionId);
  const handler = createMiniCartHandler({
    decisionFor,
    sendEvent: (e) => sent.push(e),
    decideAdded,
    pageType: () => pageType,
    now: () => NOW,
  });
  return { handler, sent, decideAdded, decisionFor };
}

describe("createMiniCartHandler", () => {
  it("links a sidebar removal to the decision about that item", async () => {
    const t = setup();
    await t.handler.onChange(cart([mug, lamp]), cart([mug]), { removed: [lamp], added: [] });

    expect(t.decisionFor).toHaveBeenCalledWith([lamp]);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({
      decision_id: "dec-1",
      action: "removed",
      occurred_at: NOW.toISOString(),
      metadata: {
        removed: [lamp],
        before_total_minor: 6396,
        after_total_minor: 2997,
        currency: "USD",
        source: "mini_cart",
        page_type: "product",
      },
    });
    expect(t.decideAdded).not.toHaveBeenCalled();
  });

  it("sends nothing for a removal no decision covered", async () => {
    const t = setup("product", null);
    await t.handler.onChange(cart([mug, lamp]), cart([mug]), { removed: [lamp], added: [] });

    expect(t.sent).toEqual([]);
  });

  it("reports each change, including removals it couldn't link", async () => {
    const reports: unknown[] = [];
    const handler = createMiniCartHandler({
      decisionFor: async () => null,
      sendEvent: () => {},
      decideAdded: async () => {},
      pageType: () => "product",
      report: (r) => reports.push(r),
    });
    await handler.onChange(cart([mug, lamp]), cart([mug]), { removed: [lamp], added: [] });

    expect(reports).toEqual([{ removed: [lamp], added: [], linkedDecision: null, askedAbout: [] }]);
  });

  it("asks for a fresh decision when items are added from the sidebar", async () => {
    const t = setup("product");
    await t.handler.onChange(cart([mug]), cart([{ ...mug, qty: 4 }]), { removed: [], added: [{ ...mug, qty: 1 }] });

    expect(t.decideAdded).toHaveBeenCalledWith(
      {
        merchant: "amazon.com",
        items: [{ name: "Mug", price_minor: 999, qty: 1 }],
        total_minor: 999,
        currency: "USD",
        url: "https://www.amazon.com/gp/cart/view.html",
      },
      { intent: "add_to_cart", source: "page", page_type: "product", occurred_at: NOW.toISOString() },
    );
  });

  it("doesn't double count an add that was already decided at the click", async () => {
    const t = setup("product");
    t.handler.noteClickedAdd(cart([lamp]));

    await t.handler.onChange(cart([mug]), cart([mug, lamp]), { removed: [], added: [lamp] });
    expect(t.decideAdded).not.toHaveBeenCalled();

    // The click is used up: a second lamp from the sidebar is a new add.
    await t.handler.onChange(cart([mug, lamp]), cart([mug, { ...lamp, qty: 2 }]), { removed: [], added: [lamp] });
    expect(t.decideAdded).toHaveBeenCalledTimes(1);
  });

  it("only subtracts the clicked quantity", async () => {
    const t = setup("product");
    t.handler.noteClickedAdd(cart([{ ...mug, qty: 1 }]));

    await t.handler.onChange(cart([]), cart([mug]), { removed: [], added: [mug] });
    expect(t.decideAdded.mock.calls[0]?.[0].items).toEqual([{ name: "Mug", price_minor: 999, qty: 2 }]);
  });

  it("credits the next added items to an add-to-cart click, once", async () => {
    const t = setup("product");
    t.handler.noteAddClick({ intent: "add_to_cart", source: "known", label: "Add to cart" });

    await t.handler.onChange(cart([mug]), cart([mug, lamp]), { removed: [], added: [lamp] });
    expect(t.decideAdded.mock.calls[0]?.[1]).toMatchObject({ intent: "add_to_cart", source: "known", label: "Add to cart" });

    await t.handler.onChange(cart([mug, lamp]), cart([mug, { ...lamp, qty: 2 }]), { removed: [], added: [lamp] });
    expect(t.decideAdded.mock.calls[1]?.[1]).toMatchObject({ source: "page" });
    expect(t.decideAdded.mock.calls[1]?.[1]).not.toHaveProperty("label");
  });

  it("maps pages without a trigger page type to 'other'", async () => {
    const t = setup("added_to_cart");
    await t.handler.onChange(cart([mug]), cart([mug, lamp]), { removed: [], added: [lamp] });

    expect(t.decideAdded.mock.calls[0]?.[1].page_type).toBe("other");
  });

  it("handles a removal and an addition in one change", async () => {
    const t = setup("product");
    await t.handler.onChange(cart([mug]), cart([lamp]), { removed: [mug], added: [lamp] });

    expect(t.sent).toHaveLength(1);
    expect(t.decideAdded).toHaveBeenCalledTimes(1);
  });
});
