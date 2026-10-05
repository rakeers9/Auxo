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

    // Cart edits. The quantity stepper is the same in the cart sidebar
    // (#nav-flyout-ewc in amazon-product*.html, amazon-added-to-cart.html) and
    // on the cart page (amazon-cart*.html). At quantity 1 the − button shows a
    // trash icon and deletes the item, so remove_item is listed before
    // decrease_qty and keys on that icon.
    {
      intent: "remove_item",
      selectors: [
        '[data-action="a-stepper"] [data-action="a-stepper-decrement"]:has(.a-icon-small-trash)',
        // Cart page "Delete" (active items only). Not data-feature-id
        // "item-delete-button": the saved-for-later list's Delete shares it.
        'input[name="submit.delete-active"]',
        'span[data-action="delete-active"]',
      ],
    },
    { intent: "decrease_qty", selectors: ['[data-action="a-stepper"] [data-action="a-stepper-decrement"]'] },
    { intent: "increase_qty", selectors: ['[data-action="a-stepper"] [data-action="a-stepper-increment"]'] },
    // Cart page "Save for later". The sidebar has no such control.
    {
      intent: "save_for_later",
      selectors: [
        'input[name="submit.save-for-later"]',
        '[data-feature-id="save-for-later-action"]',
        'span[data-action="save-for-later"]',
      ],
    },
  ],
};

// Controls that look like a cart edit or buy intent by their text but aren't,
// so they classify as nothing instead of falling through to a guess. Same
// fixture rule. Amazon (amazon-cart-saved-item.html): "Delete" on a saved-for-
// later item removes it from the saved list, not from the cart.
export const KNOWN_IGNORED: Record<string, string[]> = {
  "www.amazon.com": ['input[name="submit.delete-saved"]', '[data-action="delete-saved"]'],
};

// Whether `start` sits in an ignored control for this host.
export function isIgnored(start: Element, url: URL): boolean {
  return (KNOWN_IGNORED[url.hostname] ?? []).some((selector) => {
    try {
      return start.closest(selector) !== null;
    } catch {
      return false;
    }
  });
}

// Quantity fields whose `change` is a cart edit (see classifyChange). Same
// fixture rule as KNOWN_CONTROLS. Amazon: the typed quantity box beside the
// stepper, in the sidebar and on the cart page. Not select#quantity on the
// product page: that sets how many to add, it doesn't edit the cart.
export const KNOWN_QUANTITY_FIELDS: Record<string, string[]> = {
  "www.amazon.com": ['input[name="quantityBox"]'],
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

    // Cart edits on a cart line, in the cart page and the cart drawer (Dawn,
    // Horizon, Death Wish Coffee; Horizon's drawer in horizon-drawer-buttons).
    // The +/− buttons sit beside the line's updates[] quantity input; keying
    // on that keeps out the product form's own +/− (how many to add), which
    // has no updates[] input.
    { intent: "increase_qty", selectors: [':has(> input[name="updates[]"]) > button[name="plus"]'] },
    { intent: "decrease_qty", selectors: [':has(> input[name="updates[]"]) > button[name="minus"]'] },
    // Remove: Shopify's /cart/change route with quantity=0 (Dawn, Death Wish),
    // and Horizon's remove button.
    {
      intent: "remove_item",
      selectors: ['a[href*="/cart/change"][href*="quantity=0"]', "button.cart-items__remove"],
    },
  ],
};

// Platform quantity fields whose `change` is a cart edit: the cart line's
// updates[] input, Shopify's standard cart form field. All three themes.
export const PLATFORM_QUANTITY_FIELDS: Record<Platform, string[]> = {
  shopify: ['input[name="updates[]"]'],
};

// The quantity field selectors for a host, plus the platform's.
export function quantityFieldsFor(host: string, platform?: Platform): string[] {
  const hostFields = KNOWN_QUANTITY_FIELDS[host] ?? [];
  const platformFields = platform ? (PLATFORM_QUANTITY_FIELDS[platform] ?? []) : [];
  return [...hostFields, ...platformFields];
}

// Per-intent selector lists from store config (StoreOverrides.buttons). A
// given intent's list replaces the bundled list for that intent.
export type ButtonOverrides = Partial<Record<ClickIntent, string[]>>;

const CLICK_INTENTS: readonly ClickIntent[] = [
  "add_to_cart",
  "buy_now",
  "view_cart",
  "checkout",
  "place_order",
  "increase_qty",
  "decrease_qty",
  "remove_item",
  "save_for_later",
];

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
