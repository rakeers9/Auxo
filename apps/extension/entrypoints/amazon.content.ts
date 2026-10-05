import { defineContentScript } from "wxt/utils/define-content-script";

import { AMAZON_SELECTORS, inspectAmazonPage, readAmazonMiniCart, resolveAmazonSelectors } from "../src/cart";
import { classifyChange, classifyClick, classifySubmit } from "../src/clicks";
import { startStore, type StoreAdapter } from "../src/content/runtime";
import { MINI_CART, watchMiniCart } from "../src/tracking/sidesheet";
import { watchForChanges } from "../src/watch";

const RECHECK_DEBOUNCE_MS = 500;

// The parts of an Amazon cart or checkout page whose changes mean the cart
// may have changed. null (watch everything) when none are on the page yet,
// e.g. while checkout is still rendering its items.
function cartRegions(overrides: Record<string, string> | undefined): Element[] | null {
  const { selectors } = resolveAmazonSelectors(document, overrides);
  const pick = (key: keyof typeof AMAZON_SELECTORS) => {
    try {
      return [...document.querySelectorAll(selectors[key] ?? AMAZON_SELECTORS[key])];
    } catch {
      return [];
    }
  };
  const regions = [...pick("cart.form"), ...pick("cart.subtotal"), ...pick("checkout.lineItems"), ...pick("checkout.summary")];
  return regions.length > 0 ? regions : null;
}

// Amazon is read from the page itself, so every reading is synchronous.
const amazon: StoreAdapter = {
  inspect: (overrides) => inspectAmazonPage(document, new URL(location.href), overrides?.selectors),
  panelInspection: (overrides) => inspectAmazonPage(document, new URL(location.href), overrides?.selectors),
  panelSidebar: (overrides) => {
    if (!document.querySelector(MINI_CART)) return null;
    const reading = readAmazonMiniCart(document, new URL(location.href), overrides?.selectors);
    return { draft: reading.draft, problems: reading.problems };
  },
  classifyClick: (target, url, overrides) => classifyClick(target, url, overrides?.buttons),
  classifySubmit: (form, submitter, url, overrides) => classifySubmit(form, submitter, url, overrides?.buttons),
  classifyChange: (target, url, overrides) => classifyChange(target, url, overrides?.buttons),
  // The cart page reads the whole cart; elsewhere the cart sidebar does.
  fullCart: (overrides) => {
    const url = new URL(location.href);
    const page = inspectAmazonPage(document, url, overrides?.selectors);
    if (page.pageType === "cart") return page.draft;
    return document.querySelector(MINI_CART) ? readAmazonMiniCart(document, url, overrides?.selectors).draft : null;
  },
  watch: ({ onPageChange, reportChange, overrides, loadedAs, ignore }) => {
    const stopPage = watchForChanges(document.body, onPageChange, {
      debounceMs: RECHECK_DEBOUNCE_MS,
      ignore,
      only: () => cartRegions(overrides?.selectors),
    });
    // The cart and checkout pages track removals themselves (the tracker), so
    // the sidebar is only watched elsewhere, to avoid counting a removal twice.
    const stopSidebar =
      loadedAs === "cart" || loadedAs === "checkout"
        ? () => {}
        : watchMiniCart(document, () => readAmazonMiniCart(document, new URL(location.href), overrides?.selectors).draft, {
            onChange: (before, after, diff) => reportChange(before, after, diff),
          });
    return () => {
      stopPage();
      stopSidebar();
    };
  },
};

export default defineContentScript({
  matches: ["https://www.amazon.com/*"],
  main: (ctx) => startStore(ctx, amazon),
});
