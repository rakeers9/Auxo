import type { Cart, Verdict } from "@auxo/shared";

import type { CartDraft, DecideFailureReason, DecideResult } from "./messages";

// The worker's own API timeout is 2.5s; this guards against the worker never
// answering at all (e.g. it was restarted mid-request).
export const CONTENT_TIMEOUT_MS = 3_000;

export interface CartFlowDeps {
  isCartPage(): boolean;
  extract(): CartDraft | null;
  hash(draft: CartDraft): Promise<string>;
  requestVerdict(cart: Cart): Promise<DecideResult>;
  show(verdict: Verdict): void;
  timeoutMs?: number;
}

export type CartFlowOutcome =
  | { status: "not_cart" }
  | { status: "unreadable" }
  | { status: "unchanged"; cartHash: string }
  | { status: "failed_open"; reason: DecideFailureReason; cartHash: string }
  | { status: "shown"; verdict: Verdict; cartHash: string };

// Detect -> extract -> hash -> ask -> show. Any failure lets the user through.
// Create one per page; it skips carts it has already handled.
export function createCartFlow(deps: CartFlowDeps): () => Promise<CartFlowOutcome> {
  let lastHash: string | null = null;

  return async () => {
    if (!deps.isCartPage()) return { status: "not_cart" };

    const draft = deps.extract();
    if (!draft) return { status: "unreadable" };

    const cartHash = await deps.hash(draft);
    if (cartHash === lastHash) return { status: "unchanged", cartHash };
    lastHash = cartHash;

    const result = await withTimeout(
      deps.requestVerdict({ ...draft, cart_hash: cartHash }),
      deps.timeoutMs ?? CONTENT_TIMEOUT_MS,
    );

    if (!result.ok) return { status: "failed_open", reason: result.reason, cartHash };

    deps.show(result.verdict);
    return { status: "shown", verdict: result.verdict, cartHash };
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
