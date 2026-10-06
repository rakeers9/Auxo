import type { Verdict } from "@auxo/shared";

// Tier 2 (AUX-26): on sites without a dedicated reader, a page that scores as
// a checkout gets a generic local pause. Sreekar's decision: no backend
// verdict and no /v1/decide call (there's no reliable cart to send yet);
// it's logged locally. A real verdict comes later with Tier 3.

export interface CheckoutScore {
  pageType: "checkout" | "other";
  score: number;
  signals: string[];
}

// The local answer the pause is drawn from. Never sent anywhere.
export const GENERIC_PAUSE_SECONDS = 15;
export const GENERIC_PAUSE_VERDICT: Verdict = {
  decision_id: "00000000-0000-4000-8000-0000000000c2",
  lane: "L2",
  action: "pause",
  template_id: "l2-pause",
  cooldown_seconds: GENERIC_PAUSE_SECONDS,
};

export interface GenericCheckoutReport {
  url: string;
  // null when the cheap gate said "not worth scoring".
  result: CheckoutScore | null;
  paused: boolean;
}

export interface GenericCheckoutDeps {
  // Cheap pre-check (URL / a few DOM probes) before any scoring.
  gate(doc: Document, url: URL): boolean;
  score(doc: Document, url: URL): CheckoutScore;
  showPause(): void;
  hidePause(): void;
  report(report: GenericCheckoutReport): void;
}

export interface GenericCheckout {
  // Run on load, on in-page navigation (wxt:locationchange), and after the
  // page settles from a change.
  check(doc: Document, url: URL): void;
  // The user answered the pause: don't show it again for this checkout.
  dismissed(): void;
}

// One pause per checkout path (origin + path), so re-renders and query
// changes within the same checkout don't re-open it. Leaving the checkout
// (single-page apps) closes it.
export function createGenericCheckout(deps: GenericCheckoutDeps): GenericCheckout {
  let showing: string | null = null;
  const answered = new Set<string>();

  const keyOf = (url: URL) => `${url.origin}${url.pathname}`;

  return {
    check(doc, url) {
      const key = keyOf(url);
      if (showing && showing !== key) {
        deps.hidePause();
        showing = null;
      }

      let result: CheckoutScore | null = null;
      try {
        result = deps.gate(doc, url) ? deps.score(doc, url) : null;
      } catch {
        result = null; // a detector bug must never pause anyone
      }

      const isCheckout = result?.pageType === "checkout";
      if (!isCheckout && showing === key) {
        deps.hidePause();
        showing = null;
      }
      if (isCheckout && showing !== key && !answered.has(key)) {
        deps.showPause();
        showing = key;
      }
      deps.report({ url: url.href, result, paused: showing === key });
    },

    dismissed() {
      if (showing) answered.add(showing);
      showing = null;
    },
  };
}
