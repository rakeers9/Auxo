import { isAmazonHost } from "./amazon";
import { resolveAmazonSelectors, type SelectorOverrides } from "./selectors";

// The page Amazon shows after Place your order. Taken from a real order
// (__fixtures__/amazon-order-confirmation.html):
// /gp/buy/thankyou/handlers/display.html?purchaseId=<id>&...
const CONFIRMATION_PATH = /^\/gp\/buy\/thankyou\//;

// True only when the order went through: the thank-you URL and Amazon's green
// "Order placed, thanks!" alert. Nothing is read from the page; the purchase
// sent as "bought" is the cart read at checkout (tracking/purchase.ts).
export function isAmazonOrderConfirmation(doc: Document, url: URL, overrides?: SelectorOverrides): boolean {
  if (!isAmazonHost(url) || !CONFIRMATION_PATH.test(url.pathname)) return false;
  const { selectors: s } = resolveAmazonSelectors(doc, overrides);
  return doc.querySelector(s["confirmation.placed"]) !== null;
}
