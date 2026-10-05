import { extractAmazonCart, isAmazonCartPage } from "../cart";
import type { PageInspection } from "../messages";

// Temporary inspector built on the cart functions that exist today. It will
// be replaced by inspectAmazonPage from src/cart (AUX-11), which also detects
// checkout and explains why a read failed.
// Amazon checkout is multi-step: /checkout/p/<purchase-id>/<step> (seen on a
// real address step, 2026-10-04). Until AUX-11 reads checkout items, the panel
// only reports which step we're on.
const CHECKOUT_PATH = /^\/checkout\/p\/[^/]+\/([^/?#]+)/;

export function inspectPage(doc: Document, url: URL): PageInspection {
  const checkout = url.hostname === "www.amazon.com" ? CHECKOUT_PATH.exec(url.pathname) : null;
  if (checkout) {
    return {
      pageType: "checkout",
      draft: null,
      problems: ["checkout items are not read yet (AUX-11 in progress)"],
      details: { "checkout step": checkout[1] ?? "unknown" },
    };
  }
  if (!isAmazonCartPage(url, doc)) {
    return { pageType: "other", draft: null, problems: [] };
  }
  const draft = extractAmazonCart(doc, url);
  return {
    pageType: "cart",
    draft,
    problems: draft ? [] : ["cart page found, but the items could not be read reliably (empty cart, or items don't add up to the subtotal)"],
  };
}
