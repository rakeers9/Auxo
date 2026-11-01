import { DecisionEventSchema, type DecisionEvent } from "@auxo/shared";
import { beforeEach, describe, expect, it } from "vitest";

import type { CartDraft } from "../messages";
import { createPendingStore } from "./pending";
import { confirmPurchase } from "./purchase";

const DECISION = "6f1c2b9e-3a4d-4e5f-8a7b-9c0d1e2f3a4b";

const draft: CartDraft = {
  merchant: "amazon.com",
  items: [
    { name: "Desk lamp", price_minor: 2499, qty: 1 },
    { name: "Bulbs", price_minor: 899, qty: 2 },
  ],
  total_minor: 4297,
  currency: "USD",
  url: "https://www.amazon.com/checkout/p/p-123/spc",
};

beforeEach(() => sessionStorage.clear());

describe("confirmPurchase", () => {
  it("sends bought against the purchase's decision, with what was read at checkout", () => {
    const pending = createPendingStore(sessionStorage);
    pending.savePurchase({ decisionId: DECISION, draft, at: "2026-10-31T20:00:00.000Z" });
    const sent: DecisionEvent[] = [];

    const result = confirmPurchase(pending, (e) => sent.push(e), new Date("2026-10-31T20:00:05.000Z"));

    expect(result).toEqual({ status: "sent", decisionId: DECISION });
    expect(sent).toHaveLength(1);
    const event = sent[0]!;
    expect(DecisionEventSchema.safeParse(event).success).toBe(true);
    expect(event).toMatchObject({
      decision_id: DECISION,
      action: "bought",
      occurred_at: "2026-10-31T20:00:05.000Z",
      metadata: {
        items: draft.items,
        total_minor: 4297,
        currency: "USD",
        merchant: "amazon.com",
        placed_at: "2026-10-31T20:00:00.000Z",
        confirmed: true,
      },
    });
    // The checkout URL can carry a purchase id, so it isn't sent.
    expect(JSON.stringify(event)).not.toContain("p-123");
  });

  it("sends once: a reload of the confirmation page finds nothing", () => {
    const pending = createPendingStore(sessionStorage);
    pending.savePurchase({ decisionId: DECISION, draft, at: "2026-10-31T20:00:00.000Z" });
    const sent: DecisionEvent[] = [];

    confirmPurchase(pending, (e) => sent.push(e));
    const again = confirmPurchase(createPendingStore(sessionStorage), (e) => sent.push(e));

    expect(again).toEqual({ status: "no_purchase" });
    expect(sent).toHaveLength(1);
  });

  it("sends nothing without a remembered purchase", () => {
    const sent: DecisionEvent[] = [];

    expect(confirmPurchase(createPendingStore(sessionStorage), (e) => sent.push(e))).toEqual({ status: "no_purchase" });
    expect(sent).toEqual([]);
  });

  it("sends nothing when the purchase has no decision, and forgets it", () => {
    const pending = createPendingStore(sessionStorage);
    pending.savePurchase({ decisionId: null, draft, at: "2026-10-31T20:00:00.000Z" });
    const sent: DecisionEvent[] = [];

    expect(confirmPurchase(pending, (e) => sent.push(e))).toEqual({ status: "no_decision" });
    expect(sent).toEqual([]);
    expect(pending.takePurchase()).toBeNull();
  });
});
