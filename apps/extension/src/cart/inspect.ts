import type { PageInspection } from "../messages";
import { isAmazonAddedToCartPage, readAmazonAddedToCart } from "./added";
import { isAmazonCartPage, isAmazonHost, readAmazonCart } from "./amazon";
import { isAmazonCheckoutPage, readAmazonCheckout } from "./checkout";
import { isAmazonProductPage, readAmazonProduct } from "./product";
import { resolveAmazonSelectors, withConfigNotes, type SelectorOverrides } from "./selectors";

// What the extension reads on this page, and why it read nothing. Uses the
// same readers as extractAmazonCart / extractAmazonCheckout, so the debug panel
// can never disagree with what the extension acts on. `overrides` are the
// backend's selector overrides (StoreOverrides.selectors); a bad one is
// ignored and noted in details, never fatal.
export function inspectAmazonPage(doc: Document, url: URL, overrides?: SelectorOverrides): PageInspection {
  if (isAmazonCartPage(url, doc, overrides)) return { pageType: "cart", ...readAmazonCart(doc, url, overrides) };
  if (isAmazonCheckoutPage(url, doc, overrides)) return { pageType: "checkout", ...readAmazonCheckout(doc, url, overrides) };
  if (isAmazonProductPage(url, doc, overrides)) return { pageType: "product", ...readAmazonProduct(doc, url, overrides) };
  if (isAmazonAddedToCartPage(url, doc, overrides)) {
    return { pageType: "added_to_cart", ...readAmazonAddedToCart(doc, url, overrides) };
  }

  const problems = isAmazonHost(url)
    ? ["not a product, added-to-cart, cart, or checkout page"]
    : [`not on https://www.amazon.com (this is ${url.protocol}//${url.hostname})`];
  const { notes } = resolveAmazonSelectors(doc, overrides);
  return withConfigNotes<PageInspection>({ pageType: "other", draft: null, problems }, notes);
}
