import type { StoreOverrides } from "@auxo/shared";

import { readShopifyCart, shopifyPageType } from "../cart";
import { classifyClick, classifySubmit } from "../clicks";
import type { CartDraft, PageInspection } from "../messages";
import { watchCartApi } from "../tracking/cart-api-watch";
import type { StoreAdapter } from "./runtime";

export const SHOPIFY_CART_TIMEOUT_MS = 2_500;

// Reads the visitor's own cart from the store's Ajax API (same origin, their
// cookies). Any failure, including headless stores without /cart.js, reads
// as "no cart", so Auxo fails open.
export async function readShopifyCartFrom(
  url: URL,
  fetchFn: typeof fetch,
  timeoutMs = SHOPIFY_CART_TIMEOUT_MS,
): Promise<{ draft: CartDraft | null; problems: string[]; details?: Record<string, string> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(new URL("/cart.js", url.origin), {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    return readShopifyCart(await response.text(), url);
  } catch {
    return { draft: null, problems: [controller.signal.aborted ? "/cart.js didn't answer in time" : "/cart.js couldn't be fetched"] };
  } finally {
    clearTimeout(timer);
  }
}

// Shopify: the cart comes from /cart.js, not the page, so reads are async and
// cart changes (adds from the product page, edits on /cart, the cart drawer)
// are noticed by re-reading /cart.js after the page changes.
export function createShopifyAdapter(deps: { fetch: typeof fetch; location: () => URL; doc: Document }): StoreAdapter {
  const read = () => readShopifyCartFrom(deps.location(), deps.fetch);

  return {
    async inspect(): Promise<PageInspection> {
      const pageType = shopifyPageType(deps.location());
      if (pageType === "cart") return { pageType, ...(await read()) };
      return {
        pageType,
        draft: null,
        problems:
          pageType === "product"
            ? ["Shopify product pages aren't read; adds show up in the cart (/cart.js)"]
            : ["not a Shopify product or cart page"],
      };
    },
    classifyClick: (target, url, overrides: StoreOverrides | null) => classifyClick(target, url, overrides?.buttons, "shopify"),
    classifySubmit: (form, submitter, url, overrides: StoreOverrides | null) =>
      classifySubmit(form, submitter, url, overrides?.buttons, "shopify"),
    watch: ({ miniCart, ignore }) => {
      const watcher = watchCartApi(deps.doc, async () => (await read()).draft, {
        onChange: (before, after, diff) => void miniCart.onChange(before, after, diff),
      }, { ignore });
      return () => watcher.stop();
    },
  };
}
