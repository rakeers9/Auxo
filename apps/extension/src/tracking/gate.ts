import type { Verdict } from "@auxo/shared";

import type { ClickSignal } from "../messages";

// Buy clicks Auxo may stop. Going to the cart isn't a purchase step.
const GATED = new Set<ClickSignal["intent"]>(["add_to_cart", "buy_now", "checkout", "place_order"]);

export type GateResult = { block: false } | { block: true; verdict: Verdict; synthetic: boolean };

export interface ClickGate {
  // Runs synchronously while the click is still in flight (capture phase).
  check(signal: ClickSignal): GateResult;
  // This page's current answer (null when there is none).
  setVerdict(verdict: Verdict | null): void;
  // The user chose to continue past this answer: their next clicks go through
  // until the page gets a different answer.
  override(decisionId: string): void;
}

export interface ClickGateOptions {
  // Dev builds: block every gated known click, even without a block answer.
  alwaysOn: boolean;
  // Used when alwaysOn and the page has no answer yet. Never sent anywhere.
  devVerdict: Verdict;
}

// Never replays a click: a blocked click is simply stopped, and after the
// user continues past the pause, their own next click goes through. Only
// known store buttons are gated (never guesses), and only when the page's
// answer is "block" (or always, in dev builds).
export function createClickGate(options: ClickGateOptions): ClickGate {
  let current: Verdict | null = null;
  const overridden = new Set<string>();

  return {
    setVerdict(verdict) {
      current = verdict;
    },
    override(decisionId) {
      overridden.add(decisionId);
    },
    check(signal) {
      if (signal.source !== "known" || !GATED.has(signal.intent)) return { block: false };

      const verdict = current ?? (options.alwaysOn ? options.devVerdict : null);
      if (!verdict || overridden.has(verdict.decision_id)) return { block: false };
      if (options.alwaysOn || verdict.action === "block") {
        return { block: true, verdict, synthetic: verdict === options.devVerdict };
      }
      return { block: false };
    },
  };
}
