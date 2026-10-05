import type { DecisionEvent } from "@auxo/shared";

import type { CartFlow, CartFlowOutcome } from "../flow";
import type { CartDraft, ClickSignal, PageInspection, PageType } from "../messages";
import type { PendingClick, PendingStore } from "./pending";
import { removedItems } from "./removal";
import type { MiniCartDiff } from "./sidesheet";

const CART_EDITS = new Set<ClickSignal["intent"]>(["increase_qty", "decrease_qty", "remove_item", "save_for_later"]);

export type TrackerNote =
  | { kind: "click"; signal: ClickSignal; at: Date }
  | { kind: "outcome"; outcome: CartFlowOutcome }
  | { kind: "event"; event: DecisionEvent }
  | { kind: "purchase_pending"; decisionId: string | null };

export interface TrackerDeps {
  flow: CartFlow;
  pending: PendingStore;
  inspect(): PageInspection | Promise<PageInspection>;
  // A full cart on this page (cart or checkout) changed between two reads.
  // Handled like a sidebar change: every removal and add is asked about.
  onCartDiff?(before: CartDraft, after: CartDraft, diff: MiniCartDiff): Promise<void>;
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

// Pages whose reading is the whole cart (not a single product).
const FULL_CART_PAGES = new Set<PageType>(["cart", "checkout"]);

// Clicks decide WHEN to ask; the page readers decide WHAT to send. Rules:
// - Add to cart on a product page: read the product now, before the page moves on.
// - Buy now / go to cart / checkout: remember the click until the next page
//   reads it. If that page isn't readable yet (still loading), the click
//   waits for the first successful read. No timers.
// - Place order: always recorded as a pending purchase and always asked
//   about, whether or not the checkout page got a decision before.
// - Cart edits (+, -, delete, save for later) on the cart or checkout page:
//   the change between two reads goes to onCartDiff, which labels it with
//   the click. Every re-check of the page also goes to the backend.
export function createTracker(deps: TrackerDeps): Tracker {
  const now = deps.now ?? (() => new Date());
  const note = (n: TrackerNote) => deps.note?.(n);
  // The last full cart read on this page (any successful read, not only ones
  // that got a decision), to measure changes from.
  let lastRead: CartDraft | null = null;
  // A click from the previous page that this page couldn't read yet.
  let carried: PendingClick | null = null;

  const remember = (inspection: PageInspection) => {
    if (FULL_CART_PAGES.has(inspection.pageType) && inspection.draft) lastRead = inspection.draft;
  };

  const run = async (click: PendingClick | null) => {
    const outcome = await deps.flow.check(click);
    // Keep the click until the page is actually read.
    carried = click && outcome.status === "unreadable" ? click : null;
    note({ kind: "outcome", outcome });
    return outcome;
  };

  return {
    async onLoad() {
      remember(await deps.inspect());
      return run(deps.pending.takeClick());
    },

    async onPageChange() {
      const inspection = await deps.inspect();
      const before = lastRead;
      remember(inspection);
      const after = FULL_CART_PAGES.has(inspection.pageType) ? inspection.draft : null;
      if (before && after) {
        const diff = { removed: removedItems(before, after), added: removedItems(after, before) };
        if (diff.removed.length > 0 || diff.added.length > 0) await deps.onCartDiff?.(before, after, diff);
      }
      return run(carried);
    },

    async onBuyIntent(signal) {
      const at = now();
      note({ kind: "click", signal, at });
      // Everything before the first await runs while the click is still being
      // handled, i.e. before the page can navigate away. A DOM reader answers
      // synchronously; a network reader (Shopify) can't, so its page type is
      // only known for add to cart, which waits anyway.
      const syncInspection = deps.inspect();
      const pageType: PageType = syncInspection instanceof Promise ? "other" : syncInspection.pageType;
      const click = { signal, pageType, at: at.toISOString() };

      if (signal.intent === "place_order") {
        // Saved right away (the page is about to move on), with the checkout
        // decision if there was one, then asked about as its own decision.
        const last = deps.flow.lastDecision();
        const checkoutDraft =
          (syncInspection instanceof Promise ? null : syncInspection.draft) ?? (last?.pageType === "checkout" ? last.draft : null);
        const earlier = last?.pageType === "checkout" ? last.decisionId : null;
        if (checkoutDraft) {
          deps.pending.savePurchase({ decisionId: earlier, draft: checkoutDraft, at: click.at });
          note({ kind: "purchase_pending", decisionId: earlier });
        }
        const outcome = await run(click);
        if (outcome.status === "shown" && checkoutDraft) {
          // If the page is still here, attach the purchase to this decision.
          deps.pending.savePurchase({ decisionId: outcome.verdict.decision_id, draft: checkoutDraft, at: click.at });
          note({ kind: "purchase_pending", decisionId: outcome.verdict.decision_id });
        }
        return outcome;
      }

      // Cart edits change this page in place; the change itself is credited
      // to the click by onCartDiff / the sidebar handler.
      if (CART_EDITS.has(signal.intent)) return null;

      if (signal.intent !== "add_to_cart") {
        deps.pending.saveClick(click);
        return null;
      }

      const inspected = await syncInspection;
      if (inspected.pageType === "product") return run({ ...click, pageType: inspected.pageType });
      deps.pending.saveClick({ ...click, pageType: inspected.pageType });
      return null;
    },
  };
}
