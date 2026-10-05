import type { DecisionEvent, Trigger, TriggerPageType } from "@auxo/shared";

import type { CartDraft, ClickSignal, PageType } from "../messages";
import { buildDecisionEvent } from "./events";
import type { RemovedItem } from "./removal";
import type { MiniCartDiff } from "./sidesheet";

export interface MiniCartHandlerDeps {
  // The most recent decision that covered any of these items (worker memory).
  decisionFor(items: RemovedItem[]): Promise<string | null>;
  sendEvent(event: DecisionEvent): void;
  // Ask the backend about items added from the sidebar, and show the answer.
  decideAdded(draft: CartDraft, trigger: Trigger): Promise<void>;
  pageType(): PageType;
  now?: () => Date;
}

export interface MiniCartHandler {
  // An add-to-cart click on this page was already decided: don't count the
  // same item showing up in the sidebar as a second add.
  noteClickedAdd(draft: CartDraft): void;
  // An add-to-cart click whose items weren't read at the click (e.g. Shopify,
  // where the add shows up in /cart.js): the next added items are credited
  // to it in the trigger.
  noteAddClick(signal: ClickSignal): void;
  onChange(before: CartDraft, after: CartDraft, diff: MiniCartDiff): Promise<void>;
}

// What to do when the cart sidebar changes:
// - removed: a "removed" event against the decision about that item.
// - added (e.g. the + stepper): a fresh decision, like an add to cart.
export function createMiniCartHandler(deps: MiniCartHandlerDeps): MiniCartHandler {
  const now = deps.now ?? (() => new Date());
  let clicked: RemovedItem[] = [];
  let addClick: ClickSignal | null = null;

  return {
    noteAddClick(signal) {
      addClick = signal;
    },

    noteClickedAdd(draft) {
      // That click was decided directly, so it shouldn't label a later add.
      addClick = null;
      clicked.push(...draft.items.map((item) => ({ ...item })));
    },

    async onChange(before, after, diff) {
      if (diff.removed.length > 0) {
        const decisionId = await deps.decisionFor(diff.removed);
        // No decision ever covered these items: nothing to attribute the removal to.
        if (decisionId) {
          deps.sendEvent(
            buildDecisionEvent(
              decisionId,
              "removed",
              {
                removed: diff.removed.map((item) => ({ ...item })),
                before_total_minor: before.total_minor,
                after_total_minor: after.total_minor,
                currency: after.currency,
                source: "mini_cart",
                page_type: deps.pageType(),
              },
              now(),
            ),
          );
        }
      }

      const { remaining, unused } = subtract(diff.added, clicked);
      clicked = unused;
      if (remaining.length === 0) return;

      const draft: CartDraft = {
        merchant: after.merchant,
        items: remaining.map((item) => ({ ...item })),
        total_minor: remaining.reduce((sum, item) => sum + item.price_minor * item.qty, 0),
        currency: after.currency,
        url: after.url,
      };
      const click = addClick;
      addClick = null;
      await deps.decideAdded(draft, {
        intent: "add_to_cart",
        source: click?.source ?? "page",
        page_type: triggerPageType(deps.pageType()),
        occurred_at: now().toISOString(),
        ...(click?.label ? { label: click.label } : {}),
      });
    },
  };
}

// Items in `added` not already accounted for by `clicked` (by name, unit
// price, and quantity). Returns what's left of both.
function subtract(added: RemovedItem[], clicked: RemovedItem[]): { remaining: RemovedItem[]; unused: RemovedItem[] } {
  const pool = clicked.map((item) => ({ ...item }));
  const remaining: RemovedItem[] = [];
  for (const item of added) {
    let qty = item.qty;
    for (const c of pool) {
      if (qty === 0) break;
      if (c.name !== item.name || c.price_minor !== item.price_minor || c.qty === 0) continue;
      const used = Math.min(qty, c.qty);
      qty -= used;
      c.qty -= used;
    }
    if (qty > 0) remaining.push({ ...item, qty });
  }
  return { remaining, unused: pool.filter((c) => c.qty > 0) };
}

function triggerPageType(pageType: PageType): TriggerPageType {
  return pageType === "product" || pageType === "cart" || pageType === "checkout" ? pageType : "other";
}
