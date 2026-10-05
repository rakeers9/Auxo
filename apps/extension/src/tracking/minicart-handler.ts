import type { DecisionEvent, Trigger, TriggerIntent, TriggerPageType } from "@auxo/shared";

import type { CartDraft, ClickSignal, PageType } from "../messages";
import { buildDecisionEvent } from "./events";
import type { RemovedItem } from "./removal";
import type { MiniCartDiff } from "./sidesheet";

export interface MiniCartHandlerDeps {
  // The most recent decision that covered any of these items (worker memory).
  decisionFor(items: RemovedItem[]): Promise<string | null>;
  sendEvent(event: DecisionEvent): void;
  // Ask the backend about a cart edit. `draft` holds the items the edit was
  // about (what was added, or what was taken out); the caller decides whether
  // to show the answer (never for edits that lower spending). Resolves to the
  // new decision's id, or null if the backend couldn't be reached.
  decide(draft: CartDraft, trigger: Trigger): Promise<string | null>;
  pageType(): PageType;
  now?: () => Date;
  // What happened with each change, for the debug panel.
  report?(report: SidebarReport): void;
  // Where changes come from, recorded on "removed" events (default mini_cart).
  source?: string;
}

export interface SidebarReport {
  removed: RemovedItem[];
  added: RemovedItem[];
  // For removals: the earlier decision about those items (the precursor), or
  // null if none covered them.
  linkedDecision: string | null;
  // For removals: the decision the "removed" event was sent against (the
  // removal's own decision, else the precursor), or null if neither existed.
  removedEventDecision: string | null;
  // Added items asked about (after subtracting a clicked add that was
  // already decided at the click).
  askedAbout: RemovedItem[];
  // The click each part was credited to, if any.
  removeIntent: TriggerIntent | null;
  addIntent: TriggerIntent | null;
}

export interface MiniCartHandler {
  // An add-to-cart click on this page was already decided: don't count the
  // same item showing up in the sidebar as a second add.
  noteClickedAdd(draft: CartDraft): void;
  // A click whose effect shows up as a cart change (add to cart where the
  // items weren't read at the click, +, −, delete, save for later): the next
  // matching change is credited to it in the trigger.
  noteEditClick(signal: ClickSignal): void;
  // `source` says where the change was seen (default: deps.source, else mini_cart).
  onChange(before: CartDraft, after: CartDraft, diff: MiniCartDiff, source?: string): Promise<void>;
}

const ADDING = new Set<TriggerIntent>(["add_to_cart", "increase_qty"]);
const REDUCING = new Set<TriggerIntent>(["decrease_qty", "remove_item", "save_for_later"]);

// Every cart sidebar change goes to the backend (Sreekar: don't miss any):
// - items taken out (−, delete, save for later): a decision request about the
//   removed items, plus a "removed" event against the earlier decision that
//   covered them, if there was one.
// - items added (+, add to cart): a decision request about the added items,
//   minus anything already decided at an add-to-cart click.
// The click that caused the change labels the trigger (source "known"/"guess");
// without one, the change itself is the trigger (source "page").
export function createMiniCartHandler(deps: MiniCartHandlerDeps): MiniCartHandler {
  const now = deps.now ?? (() => new Date());
  let clicked: RemovedItem[] = [];
  let addClick: ClickSignal | null = null;
  let removeClick: ClickSignal | null = null;

  const triggerFor = (click: ClickSignal | null, fallback: TriggerIntent): Trigger => ({
    intent: click?.intent ?? fallback,
    source: click?.source ?? "page",
    page_type: triggerPageType(deps.pageType()),
    occurred_at: now().toISOString(),
    ...(click?.label ? { label: click.label } : {}),
  });

  const draftOf = (items: RemovedItem[], cart: CartDraft): CartDraft => ({
    merchant: cart.merchant,
    items: items.map((item) => ({ ...item })),
    total_minor: items.reduce((sum, item) => sum + item.price_minor * item.qty, 0),
    currency: cart.currency,
    url: cart.url,
  });

  return {
    noteEditClick(signal) {
      if (ADDING.has(signal.intent)) addClick = signal;
      if (REDUCING.has(signal.intent)) removeClick = signal;
    },

    noteClickedAdd(draft) {
      // That click was decided directly, so it shouldn't label a later add.
      addClick = null;
      clicked.push(...draft.items.map((item) => ({ ...item })));
    },

    async onChange(before, after, diff, source) {
      let linkedDecision: string | null = null;
      let removedEventDecision: string | null = null;
      let removeIntent: TriggerIntent | null = null;
      if (diff.removed.length > 0) {
        // The earlier decision about these items, if any (the precursor).
        linkedDecision = await deps.decisionFor(diff.removed);
        // Gone entirely vs. a lower quantity, when no click says which.
        const goneEntirely = diff.removed.every((r) => !after.items.some((i) => i.name === r.name && i.price_minor === r.price_minor));
        const trigger = triggerFor(removeClick, goneEntirely ? "remove_item" : "decrease_qty");
        removeClick = null;
        removeIntent = trigger.intent;
        // Every removal is asked about, so it's tracked even when nothing
        // earlier covered it; the "removed" event hangs off that decision.
        const ownDecision = await deps.decide(draftOf(diff.removed, before), trigger);
        removedEventDecision = ownDecision ?? linkedDecision;
        if (removedEventDecision) {
          deps.sendEvent(
            buildDecisionEvent(
              removedEventDecision,
              "removed",
              {
                removed: diff.removed.map((item) => ({ ...item })),
                before_total_minor: before.total_minor,
                after_total_minor: after.total_minor,
                currency: after.currency,
                source: source ?? deps.source ?? "mini_cart",
                page_type: deps.pageType(),
                intent: trigger.intent,
                // The earlier decision about these items, or null if there wasn't one.
                precursor_decision_id: linkedDecision,
              },
              now(),
            ),
          );
        }
      }

      const { remaining, unused } = subtract(diff.added, clicked);
      clicked = unused;
      let addIntent: TriggerIntent | null = null;
      if (remaining.length > 0) {
        const trigger = triggerFor(addClick, "add_to_cart");
        addClick = null;
        addIntent = trigger.intent;
        await deps.decide(draftOf(remaining, after), trigger);
      }

      deps.report?.({
        removed: diff.removed,
        added: diff.added,
        linkedDecision,
        removedEventDecision,
        askedAbout: remaining,
        removeIntent,
        addIntent,
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
