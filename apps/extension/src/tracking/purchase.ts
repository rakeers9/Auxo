import type { DecisionEvent } from "@auxo/shared";

import { buildDecisionEvent } from "./events";
import type { PendingStore } from "./pending";

export type PurchaseResult =
  // No "Place your order" click was remembered in this tab.
  | { status: "no_purchase" }
  // The purchase never got a decision (the backend was unreachable at
  // checkout and at the click), so there's nothing to attach "bought" to.
  | { status: "no_decision" }
  | { status: "sent"; decisionId: string };

// On the order confirmation page: the purchase remembered at the "Place your
// order" click went through, so "bought" is sent against its decision. The
// purchase is taken (cleared) either way, so a reload doesn't send it twice;
// the API also keeps only the first "bought" per decision. What's sent is the
// cart read at checkout, not the confirmation page.
export function confirmPurchase(
  pending: PendingStore,
  sendEvent: (event: DecisionEvent) => void,
  now: Date = new Date(),
): PurchaseResult {
  const purchase = pending.takePurchase();
  if (!purchase) return { status: "no_purchase" };
  if (!purchase.decisionId) return { status: "no_decision" };
  const { draft } = purchase;
  sendEvent(
    buildDecisionEvent(
      purchase.decisionId,
      "bought",
      {
        items: draft.items.map(({ name, price_minor, qty }) => ({ name, price_minor, qty })),
        total_minor: draft.total_minor,
        currency: draft.currency,
        merchant: draft.merchant,
        placed_at: purchase.at,
        confirmed: true,
      },
      now,
    ),
  );
  return { status: "sent", decisionId: purchase.decisionId };
}
