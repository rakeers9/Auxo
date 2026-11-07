import type { Cart, Trigger, TriggerPageType, Verdict } from "@auxo/shared";

import type { CartDraft, DecideFailureReason, DecideResult, PageInspection, PageType } from "./messages";
import type { PendingClick } from "./tracking/pending";

// The worker's own API timeout is 2.5s; this guards against the worker never
// answering at all (e.g. it was restarted mid-request).
export const CONTENT_TIMEOUT_MS = 3_000;

// Backstop for re-checks the page started (no click): at most this many sent
// per window, per page.
export const MAX_RECHECKS_PER_WINDOW = 10;
export const RECHECK_WINDOW_MS = 60_000;

export interface CartFlowDeps {
  // Sync for DOM readers (Amazon); async for stores read over the network
  // (Shopify's /cart.js).
  inspect(): PageInspection | Promise<PageInspection>;
  // The whole cart as the page shows it (the cart sidebar on an added-to-cart
  // page), if the store can tell. The added-to-cart reading only holds what
  // was just added; a decision about an add is about the cart it joined.
  wholeCart?(): CartDraft | null | Promise<CartDraft | null>;
  hash(draft: CartDraft): Promise<string>;
  requestVerdict(cart: Cart, trigger: Trigger): Promise<DecideResult>;
  show(verdict: Verdict, trigger: Trigger): void;
  now?: () => Date;
  timeoutMs?: number;
}

export type CartFlowOutcome =
  | { status: "skipped"; pageType: PageType; reason: "not_shopping_page" | "product_page" | "added_to_cart_page" | "same_cart" | "rate_limited" }
  | { status: "unreadable"; pageType: PageType; problems: string[] }
  | {
      status: "failed_open";
      pageType: TriggerPageType;
      draft: CartDraft;
      cartHash: string;
      trigger: Trigger;
      reason: DecideFailureReason;
    }
  | { status: "shown"; pageType: TriggerPageType; draft: CartDraft; cartHash: string; trigger: Trigger; verdict: Verdict };

export interface LastDecision {
  decisionId: string;
  draft: CartDraft;
  cartHash: string;
  pageType: TriggerPageType;
}

export interface CartFlow {
  // Read the page and, if it's a buy moment, ask for a decision. `click` is a
  // buy-intent click from this page or the one before it.
  check(click?: PendingClick | null): Promise<CartFlowOutcome>;
  lastDecision(): LastDecision | null;
}

// Every cart, checkout, or add-to-cart moment goes to the backend with what
// prompted it. The cart is the source of truth: a product page is never asked
// about (its layouts are endless), so an add to cart is decided on the cart
// view it leads to (the added-to-cart page, where the whole cart is read), or
// by the cart sidebar when the page stays. Buy Now is decided on the checkout
// page it leads to. Page loads and clicks are always sent; a re-check the page
// started is sent only when the cart changed. Any failure lets the user through.
export function createCartFlow(deps: CartFlowDeps): CartFlow {
  const now = deps.now ?? (() => new Date());
  let lastHash: string | null = null;
  let last: LastDecision | null = null;
  // When recent no-click checks were sent, for the backstop.
  let recentRechecks: number[] = [];

  return {
    lastDecision: () => last,
    async check(click) {
      const inspection = await deps.inspect();
      const pageType = inspection.pageType;

      if (pageType === "other") return { status: "skipped", pageType, reason: "not_shopping_page" };
      if (pageType === "product") return { status: "skipped", pageType, reason: "product_page" };
      // The added-to-cart page is asked about only for the add-to-cart click
      // that led here; reloading it or coming Back to it asks nothing.
      if (pageType === "added_to_cart" && click?.signal.intent !== "add_to_cart") {
        return { status: "skipped", pageType, reason: "added_to_cart_page" };
      }

      let draft = inspection.draft;
      if (!draft) return { status: "unreadable", pageType, problems: inspection.problems };
      // A verifiably empty cart (e.g. after deleting the last item) has
      // nothing to decide about; removals are reported by the tracker.
      if (draft.items.length === 0) return { status: "unreadable", pageType, problems: ["the cart is empty"] };
      // The added-to-cart reading is only what was added (and is verified
      // against the cart subtotal). Ask about the whole cart it joined.
      if (pageType === "added_to_cart") {
        const whole = await Promise.resolve()
          .then(() => deps.wholeCart?.())
          .catch(() => null);
        if (whole && whole.items.length > 0) draft = whole;
      }
      // The added-to-cart page shows the cart, so the backend sees a cart page.
      const triggerPage: TriggerPageType = pageType === "added_to_cart" ? "cart" : pageType;

      const cartHash = await deps.hash(draft);
      // No click means the page changed by itself. Amazon re-draws the cart
      // area about once a second, and the same cart again tells the backend
      // nothing, so only a changed cart is sent (an item Amazon removed, an
      // edit the click classifier missed). A cart flipping between two states
      // is capped by the backstop.
      if (!click) {
        if (cartHash === lastHash) return { status: "skipped", pageType, reason: "same_cart" };
        const at = now().getTime();
        recentRechecks = recentRechecks.filter((t) => t > at - RECHECK_WINDOW_MS);
        if (recentRechecks.length >= MAX_RECHECKS_PER_WINDOW) return { status: "skipped", pageType, reason: "rate_limited" };
        recentRechecks.push(at);
      }
      lastHash = cartHash;

      const trigger: Trigger = click
        ? {
            intent: click.signal.intent,
            source: click.signal.source,
            page_type: triggerPage,
            occurred_at: click.at,
            ...(click.signal.label ? { label: click.signal.label } : {}),
          }
        : {
            intent: "page_view",
            source: "page",
            page_type: triggerPage,
            occurred_at: now().toISOString(),
          };

      const result = await withTimeout(
        deps.requestVerdict({ ...draft, cart_hash: cartHash }, trigger),
        deps.timeoutMs ?? CONTENT_TIMEOUT_MS,
      );
      if (!result.ok) return { status: "failed_open", pageType: triggerPage, draft, cartHash, trigger, reason: result.reason };

      last = { decisionId: result.verdict.decision_id, draft, cartHash, pageType: triggerPage };
      deps.show(result.verdict, trigger);
      return { status: "shown", pageType: triggerPage, draft, cartHash, trigger, verdict: result.verdict };
    },
  };
}

function withTimeout(promise: Promise<DecideResult>, ms: number): Promise<DecideResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DecideResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), ms);
  });
  const safe = promise.catch((): DecideResult => ({ ok: false, reason: "network" }));
  return Promise.race([safe, timeout]).finally(() => clearTimeout(timer));
}
