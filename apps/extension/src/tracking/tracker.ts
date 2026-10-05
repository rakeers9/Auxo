import type { DecisionEvent } from "@auxo/shared";

import type { CartFlow, CartFlowOutcome } from "../flow";
import type { CartDraft, ClickSignal, PageInspection } from "../messages";
import { buildDecisionEvent } from "./events";
import type { PendingClick, PendingStore } from "./pending";
import { removedItems } from "./removal";

export type TrackerNote =
  | { kind: "click"; signal: ClickSignal; at: Date }
  | { kind: "outcome"; outcome: CartFlowOutcome }
  | { kind: "event"; event: DecisionEvent }
  | { kind: "purchase_pending"; decisionId: string };

export interface TrackerDeps {
  flow: CartFlow;
  pending: PendingStore;
  inspect(): PageInspection;
  sendEvent(event: DecisionEvent): void;
  now?: () => Date;
  // Reports what happened, for the debug panel.
  note?: (note: TrackerNote) => void;
}

export interface Tracker {
  // A page finished loading: use the click that led here, if any.
  onLoad(): Promise<CartFlowOutcome>;
  // The page changed in place (quantity edits, removals, re-renders).
  onPageChange(): Promise<CartFlowOutcome>;
  // A buy-intent click or submit on this page.
  onBuyIntent(signal: ClickSignal): Promise<CartFlowOutcome | null>;
}

// Clicks decide WHEN to ask; the page readers decide WHAT to send. Rules:
// - Add to cart on a product page: read the product now, before the page moves on.
// - Buy now / go to cart / checkout: remember the click until the next page
//   reads it. If that page isn't readable yet (still loading), the click
//   waits for the first successful read. No timers.
// - Place order: remember the checkout decision so the confirmation page can
//   report the purchase.
// - Items leaving the cart after a decision are reported as "removed".
export function createTracker(deps: TrackerDeps): Tracker {
  const now = deps.now ?? (() => new Date());
  const note = (n: TrackerNote) => deps.note?.(n);
  // The cart as of the last decision on this page, to spot removals.
  let baseline: { decisionId: string; draft: CartDraft } | null = null;
  // A click from the previous page that this page couldn't read yet.
  let carried: PendingClick | null = null;

  const run = async (click: PendingClick | null) => {
    const outcome = await deps.flow.check(click);
    // Keep the click until the page is actually read.
    carried = click && outcome.status === "unreadable" ? click : null;
    if (outcome.status === "shown") baseline = { decisionId: outcome.verdict.decision_id, draft: outcome.draft };
    note({ kind: "outcome", outcome });
    return outcome;
  };

  const send = (event: DecisionEvent) => {
    deps.sendEvent(event);
    note({ kind: "event", event });
  };

  return {
    onLoad: () => run(deps.pending.takeClick()),

    async onPageChange() {
      const inspection = deps.inspect();
      if (baseline && inspection.draft && inspection.pageType !== "other") {
        const removed = removedItems(baseline.draft, inspection.draft);
        if (removed.length > 0) {
          send(
            buildDecisionEvent(
              baseline.decisionId,
              "removed",
              {
                removed: removed.map((item) => ({ ...item })),
                before_total_minor: baseline.draft.total_minor,
                after_total_minor: inspection.draft.total_minor,
                currency: inspection.draft.currency,
                page_type: inspection.pageType,
              },
              now(),
            ),
          );
          baseline = { ...baseline, draft: inspection.draft };
        }
      }
      return run(carried);
    },

    async onBuyIntent(signal) {
      const at = now();
      note({ kind: "click", signal, at });
      const pageType = deps.inspect().pageType;
      const click = { signal, pageType, at: at.toISOString() };

      if (signal.intent === "place_order") {
        const last = deps.flow.lastDecision();
        if (last && last.pageType === "checkout") {
          deps.pending.savePurchase({ decisionId: last.decisionId, draft: last.draft, at: click.at });
          note({ kind: "purchase_pending", decisionId: last.decisionId });
        }
        return null;
      }

      if (signal.intent === "add_to_cart" && pageType === "product") return run(click);

      deps.pending.saveClick(click);
      return null;
    },
  };
}
