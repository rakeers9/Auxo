import type { PageInspection } from "../messages";
import { isAmazonCartPage, isAmazonHost, readAmazonCart } from "./amazon";
import { isAmazonCheckoutPage, readAmazonCheckout } from "./checkout";

// What the extension reads on this page, and why it read nothing. Uses the
// same readers as extractAmazonCart / extractAmazonCheckout, so the debug panel
// can never disagree with what the extension acts on.
export function inspectAmazonPage(doc: Document, url: URL): PageInspection {
  if (isAmazonCartPage(url, doc)) return { pageType: "cart", ...readAmazonCart(doc, url) };
  if (isAmazonCheckoutPage(url, doc)) return { pageType: "checkout", ...readAmazonCheckout(doc, url) };

  const problems = isAmazonHost(url)
    ? ["not a cart or checkout page"]
    : [`not on https://www.amazon.com (this is ${url.protocol}//${url.hostname})`];
  return { pageType: "other", draft: null, problems };
}
