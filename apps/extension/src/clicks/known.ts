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
    // Every page: the nav cart link.
    { intent: "view_cart", selectors: ["#nav-cart"] },
  ],
};

// The known control `start` sits in, if any, for this host.
export function matchKnown(start: Element, url: URL): { intent: ClickIntent; element: Element } | null {
  const controls = KNOWN_CONTROLS[url.hostname];
  if (!controls) return null;
  for (const control of controls) {
    for (const selector of control.selectors) {
      const element = start.closest(selector);
      if (element) return { intent: control.intent, element };
    }
  }
  return null;
}
