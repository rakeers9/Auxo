import type { Cart, Trigger, TriggerPageType, Verdict } from "@auxo/shared";

import type { CartDraft, DecideFailureReason, DecideResult, PageInspection } from "./messages";
import type { PendingClick } from "./tracking/pending";

// The worker's own API timeout is 2.5s; this guards against the worker never
// answering at all (e.g. it was restarted mid-request).
export const CONTENT_TIMEOUT_MS = 3_000;

export interface CartFlowDeps {
  inspect(): PageInspection;
  hash(draft: CartDraft): Promise<string>;
  requestVerdict(cart: Cart, trigger: Trigger): Promise<DecideResult>;
  show(verdict: Verdict): void;
  now?: () => Date;
  timeoutMs?: number;
}

export type CartFlowOutcome =
  | { status: "skipped"; pageType: TriggerPageType; reason: "not_shopping_page" | "product_without_click" }
  | { status: "unreadable"; pageType: TriggerPageType; problems: string[] }
  | { status: "unchanged"; pageType: TriggerPageType; draft: CartDraft; cartHash: string }
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
// prompted it. Product pages only count after an add-to-cart click (Buy Now is
// decided on the checkout page it leads to). Without a new click, the same
// cart on the same page isn't asked about twice. Any failure lets the user
// through.
export function createCartFlow(deps: CartFlowDeps): CartFlow {
  const now = deps.now ?? (() => new Date());
  let lastHash: string | null = null;
  let last: LastDecision | null = null;

  return {
    lastDecision: () => last,
    async check(click) {
      const inspection = deps.inspect();
      const pageType = inspection.pageType;

      if (pageType === "other") return { status: "skipped", pageType, reason: "not_shopping_page" };
      if (pageType === "product" && click?.signal.intent !== "add_to_cart") {
        return { status: "skipped", pageType, reason: "product_without_click" };
      }

      const draft = inspection.draft;
      if (!draft) return { status: "unreadable", pageType, problems: inspection.problems };

      const cartHash = await deps.hash(draft);
      if (!click && cartHash === lastHash) return { status: "unchanged", pageType, draft, cartHash };
      lastHash = cartHash;

      const trigger: Trigger = click
        ? {
            intent: click.signal.intent,
            source: click.signal.source,
            page_type: pageType,
            occurred_at: click.at,
            ...(click.signal.label ? { label: click.signal.label } : {}),
          }
        : { intent: "page_view", source: "page", page_type: pageType, occurred_at: now().toISOString() };

      const result = await withTimeout(
        deps.requestVerdict({ ...draft, cart_hash: cartHash }, trigger),
        deps.timeoutMs ?? CONTENT_TIMEOUT_MS,
      );
      if (!result.ok) return { status: "failed_open", pageType, draft, cartHash, trigger, reason: result.reason };

      last = { decisionId: result.verdict.decision_id, draft, cartHash, pageType };
      deps.show(result.verdict);
      return { status: "shown", pageType, draft, cartHash, trigger, verdict: result.verdict };
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
