import type { ClickSignal } from "../messages";

export type ClickIntent = ClickSignal["intent"];

export interface KnownControl {
  intent: ClickIntent;
  // Matched with closest(), so include the wrapper spans clicks land on.
  selectors: string[];
}

// Store buttons verified on real pages. Every selector here must appear in a
// fixture under src/cart/__fixtures__ (and be covered in known.test.ts).
// Add a store by adding its host; add a button by adding a row.
export const KNOWN_CONTROLS: Record<string, KnownControl[]> = {
  "www.amazon.com": [
    // amazon-product.html: input#buy-now-button inside span#submit.buy-now.
    {
      intent: "buy_now",
      selectors: ["#buy-now-button", 'input[name="submit.buy-now"]', '[id="submit.buy-now"]'],
    },
    // amazon-product.html: input#add-to-cart-button inside span#submit.add-to-cart.
    {
      intent: "add_to_cart",
      selectors: ["#add-to-cart-button", 'input[name="submit.add-to-cart"]', '[id="submit.add-to-cart"]'],
    },
    // amazon-cart*.html: the input has no id, only name and data-feature-id.
    {
      intent: "checkout",
      selectors: [
        'input[name="proceedToRetailCheckout"]',
        '[data-feature-id="proceed-to-checkout-action"]',
        "#sc-buy-box-ptc-button",
      ],
    },
    // amazon-checkout-*.html: span#submitOrderButtonId wraps the place order control.
    { intent: "place_order", selectors: ["#submitOrderButtonId"] },
    // Every page: the nav cart link. amazon-added-to-cart.html (/cart/smart-wagon):
    // span#sw-gtc wraps the "Go to Cart" link, which has no id.
    { intent: "view_cart", selectors: ["#nav-cart", "#sw-gtc"] },
  ],
};

// Per-intent selector lists from store config (StoreOverrides.buttons). A
// given intent's list replaces the bundled list for that intent.
export type ButtonOverrides = Partial<Record<ClickIntent, string[]>>;

const CLICK_INTENTS: readonly ClickIntent[] = ["add_to_cart", "buy_now", "view_cart", "checkout", "place_order"];

// The known controls for a host: bundled defaults with any overrides applied.
// Intents not overridden keep their defaults; overridden intents the host has
// no default for are added after the defaults.
export function controlsFor(host: string, buttons?: ButtonOverrides): KnownControl[] {
  const defaults = KNOWN_CONTROLS[host] ?? [];
  if (!buttons) return defaults;

  const override = (intent: ClickIntent): string[] | undefined => {
    const list = buttons[intent];
    return Array.isArray(list) ? list : undefined;
  };
  const merged = defaults.map((control) => {
    const selectors = override(control.intent);
    return selectors ? { intent: control.intent, selectors } : control;
  });
  for (const intent of CLICK_INTENTS) {
    const selectors = override(intent);
    if (selectors && !defaults.some((control) => control.intent === intent)) merged.push({ intent, selectors });
  }
  return merged;
}

// The known control `start` sits in, if any, for this host. A selector that
// closest() rejects (config is data from the server) is skipped.
export function matchKnown(
  start: Element,
  url: URL,
  buttons?: ButtonOverrides,
): { intent: ClickIntent; element: Element } | null {
  for (const control of controlsFor(url.hostname, buttons)) {
    for (const selector of control.selectors) {
      let element: Element | null;
      try {
        element = start.closest(selector);
      } catch {
        continue;
      }
      if (element) return { intent: control.intent, element };
    }
  }
  return null;
}
