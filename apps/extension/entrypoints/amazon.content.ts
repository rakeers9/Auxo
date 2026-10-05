import { defineContentScript } from "wxt/utils/define-content-script";

import { inspectAmazonPage, readAmazonMiniCart } from "../src/cart";
import { classifyClick, classifySubmit } from "../src/clicks";
import { startStore, type StoreAdapter } from "../src/content/runtime";
import { watchMiniCart } from "../src/tracking/sidesheet";
import { watchForChanges } from "../src/watch";

const RECHECK_DEBOUNCE_MS = 500;

// Amazon is read from the page itself, so every reading is synchronous.
const amazon: StoreAdapter = {
  inspect: (overrides) => inspectAmazonPage(document, new URL(location.href), overrides?.selectors),
  panelInspection: (overrides) => inspectAmazonPage(document, new URL(location.href), overrides?.selectors),
  classifyClick: (target, url, overrides) => classifyClick(target, url, overrides?.buttons),
  classifySubmit: (form, submitter, url, overrides) => classifySubmit(form, submitter, url, overrides?.buttons),
  watch: ({ onPageChange, miniCart, overrides, loadedAs, ignore }) => {
    const stopPage = watchForChanges(document.body, onPageChange, { debounceMs: RECHECK_DEBOUNCE_MS, ignore });
    // The cart and checkout pages track removals themselves (the tracker), so
    // the sidebar is only watched elsewhere, to avoid counting a removal twice.
    const stopSidebar =
      loadedAs === "cart" || loadedAs === "checkout"
        ? () => {}
        : watchMiniCart(document, () => readAmazonMiniCart(document, new URL(location.href), overrides?.selectors).draft, {
            onChange: (before, after, diff) => void miniCart.onChange(before, after, diff),
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
