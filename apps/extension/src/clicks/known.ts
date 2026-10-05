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

// Platforms whose standard storefront markup is the same on every host.
export type Platform = "shopify";

// Platform buttons, applied on any host when the caller says the page is on
// that platform. Same rule as KNOWN_CONTROLS: every selector must appear in a
// real fixture (src/cart/__fixtures__/shopify/*-buttons.html), and order
// matters: the first control whose selector matches wins.
export const PLATFORM_CONTROLS: Record<Platform, KnownControl[]> = {
  shopify: [
    // Dynamic checkout ("Buy it now" / Shop Pay) on product pages: Shopify
    // injects the real button inside this wrapper. Dawn, Horizon.
    { intent: "buy_now", selectors: [".shopify-payment-button", "shopify-accelerated-checkout"] },
    // The product form's submit. type="submit" leaves out Horizon's quick-add
    // "Choose" button (type="button" name="add"), which only opens options.
    // Dawn, Horizon, Death Wish Coffee.
    { intent: "add_to_cart", selectors: ['form[action*="/cart/add"] [type="submit"][name="add"]'] },
    // The cart page and cart notification checkout button, and the cart's
    // express checkout wallets. Dawn, Horizon, Death Wish Coffee.
    { intent: "checkout", selectors: ['button[name="checkout"]', "shopify-accelerated-checkout-cart"] },
    // Links to Shopify's /cart route (header icon, "View cart"). Drawer themes
    // (Horizon's product page) use a button instead, left to guesses.
    { intent: "view_cart", selectors: ['a[href="/cart"]'] },
  ],
};

// Per-intent selector lists from store config (StoreOverrides.buttons). A
// given intent's list replaces the bundled list for that intent.
export type ButtonOverrides = Partial<Record<ClickIntent, string[]>>;

const CLICK_INTENTS: readonly ClickIntent[] = ["add_to_cart", "buy_now", "view_cart", "checkout", "place_order"];

// The known controls for a host: its bundled defaults, then the platform's
// controls, with any overrides applied. An overridden intent's list replaces
// every bundled list for that intent (taking the first one's place); intents
// not overridden keep their defaults; overridden intents with no default are
// added at the end.
export function controlsFor(host: string, buttons?: ButtonOverrides, platform?: Platform): KnownControl[] {
  const hostControls = KNOWN_CONTROLS[host] ?? [];
  const platformControls = platform ? (PLATFORM_CONTROLS[platform] ?? []) : [];
  const defaults = platformControls.length ? [...hostControls, ...platformControls] : hostControls;
  if (!buttons) return defaults;

  const override = (intent: ClickIntent): string[] | undefined => {
    const list = buttons[intent];
    return Array.isArray(list) ? list : undefined;
  };
  const merged: KnownControl[] = [];
  const replaced = new Set<ClickIntent>();
  for (const control of defaults) {
    const selectors = override(control.intent);
    if (!selectors) merged.push(control);
    else if (!replaced.has(control.intent)) {
      replaced.add(control.intent);
      merged.push({ intent: control.intent, selectors });
    }
  }
  for (const intent of CLICK_INTENTS) {
    const selectors = override(intent);
    if (selectors && !replaced.has(intent)) merged.push({ intent, selectors });
  }
  return merged;
}

// The known control `start` sits in, if any, for this host (and platform). A
// selector that closest() rejects (config is data from the server) is skipped.
export function matchKnown(
  start: Element,
  url: URL,
  buttons?: ButtonOverrides,
  platform?: Platform,
): { intent: ClickIntent; element: Element } | null {
  for (const control of controlsFor(url.hostname, buttons, platform)) {
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
