import { defineContentScript } from "wxt/utils/define-content-script";

import { isLikelyShopify } from "../src/cart";
import { startStore } from "../src/content/runtime";
import { createShopifyAdapter } from "../src/content/shopify";

// Runs on every site, so it ships in DEV BUILDS ONLY (see DEV_ONLY_ENTRYPOINTS
// in wxt.config.ts) until the "read data on all websites" permission is
// decided. It does nothing unless the page shows Shopify's own markers.
export default defineContentScript({
  matches: ["https://*/*"],
  excludeMatches: ["https://www.amazon.com/*"],
  main: (ctx) => {
    if (!isLikelyShopify(document)) return;
    return startStore(
      ctx,
      createShopifyAdapter({ fetch: (input, init) => fetch(input, init), location: () => new URL(location.href), doc: document }),
    );
  },
});
