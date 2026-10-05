import { extractAmazonCart, isAmazonCartPage } from "../cart";
import type { PageInspection } from "../messages";

// Temporary inspector built on the cart functions that exist today. It will
// be replaced by inspectAmazonPage from src/cart (AUX-11), which also detects
// checkout and explains why a read failed.
export function inspectPage(doc: Document, url: URL): PageInspection {
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
