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
  if (!isThankYouPage(url)) return false;
  const { selectors: s } = resolveAmazonSelectors(doc, overrides);
  return doc.querySelector(s["confirmation.placed"]) !== null;
}

// How long the thank-you page gets to draw its "Order placed" alert.
export const CONFIRMATION_WAIT_MS = 5_000;

export interface ConfirmationWaitOptions {
  timeoutMs?: number;
  // Aborted when the content script goes away (the extension reloads):
  // stops watching at once and answers false.
  signal?: AbortSignal;
}

// Like isAmazonOrderConfirmation, but on the thank-you page it waits up to
// `timeoutMs` for the alert, in case Amazon draws it after the content script
// starts. Off that page it answers at once and watches nothing. It answers
// once; the observer and timer are always cleaned up.
export function waitForAmazonOrderConfirmation(
  doc: Document,
  url: URL,
  overrides?: SelectorOverrides,
  options: ConfirmationWaitOptions = {},
): Promise<boolean> {
  const { timeoutMs = CONFIRMATION_WAIT_MS, signal } = options;
  if (!isThankYouPage(url) || signal?.aborted) return Promise.resolve(false);
  const placed = () => isAmazonOrderConfirmation(doc, url, overrides);
  if (placed()) return Promise.resolve(true);

  return new Promise((resolve) => {
    let done = false;
    const finish = (result: boolean) => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish(false);
    const observer = new MutationObserver(() => {
      if (placed()) finish(true);
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    const timer = setTimeout(() => finish(placed()), timeoutMs);
    signal?.addEventListener("abort", onAbort);
  });
}

function isThankYouPage(url: URL): boolean {
  return isAmazonHost(url) && CONFIRMATION_PATH.test(url.pathname);
}
