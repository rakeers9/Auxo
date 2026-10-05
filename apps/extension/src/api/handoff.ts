import type { Trigger, Verdict } from "@auxo/shared";

import type { DecideResult } from "../messages";

// Amazon's Add to Cart moves to a new page (/cart/smart-wagon) before the
// backend answers, so the page that asked is gone. The worker outlives page
// changes: it keeps the latest add-to-cart decision per tab until a page in
// that tab shows it. The asking page acks if it got the answer itself.
// No timers: an entry lives until it's acked, claimed, or replaced.
interface Entry {
  result: Promise<DecideResult>;
  delivered: boolean;
}

export interface Handoff {
  // Called by the worker for each decide request from a tab.
  track(tabId: number, trigger: Trigger | undefined, result: Promise<DecideResult>): void;
  // The asking page received the answer, so the next page shouldn't show it again.
  ack(tabId: number, decisionId: string): Promise<void>;
  // A new page in the tab asks for an answer it should show. Waits for an
  // in-flight request. Returns each answer at most once.
  claim(tabId: number): Promise<Verdict | null>;
  // The tab closed.
  forget(tabId: number): void;
}

export function createHandoff(): Handoff {
  const entries = new Map<number, Entry>();

  return {
    track(tabId, trigger, result) {
      // Only an add to cart is expected to change pages before it's answered.
      if (trigger?.intent !== "add_to_cart") return;
      entries.set(tabId, { result: result.catch((): DecideResult => ({ ok: false, reason: "network" })), delivered: false });
    },

    async ack(tabId, decisionId) {
      const entry = entries.get(tabId);
      if (!entry) return;
      const result = await entry.result;
      if (result.ok && result.verdict.decision_id === decisionId) entry.delivered = true;
    },

    async claim(tabId) {
      const entry = entries.get(tabId);
      if (!entry) return null;
      const result = await entry.result;
      // Re-check: a newer request may have replaced it, or it was acked meanwhile.
      if (entries.get(tabId) !== entry || entry.delivered || !result.ok) return null;
      entry.delivered = true;
      entries.delete(tabId);
      return result.verdict;
    },

    forget(tabId) {
      entries.delete(tabId);
    },
  };
}
