import type { CartDraft } from "../messages";
import { isAmazonHost } from "./amazon";
import { parsePriceToMinor } from "./price";
import { CURRENCY, cleanName, finishReading, quote, type Reading } from "./reading";
import { resolveAmazonSelectors, withConfigNotes, type SelectorOverrides } from "./selectors";

// Selectors come from real amazon.com checkout pages, reached both from the
// cart (Proceed to checkout) and from a product (Buy Now). Both land on the
// same one-page "Place Your Order" layout at /checkout/p/<purchase-id>/spc;
// other steps (address, pay, ...) live under the same prefix.
const CHECKOUT_PATH = /^\/checkout\/p\/[^/]+\/([^/]+)/;
// The summary rows carry a hidden type code; this one is the items subtotal
// (before shipping and tax), which is what the cart page's subtotal shows.
const ITEMS_SUBTOTAL_CODE = "ITEMS_TAX_EXCLUSIVE";

// The checkout step from the URL ("spc", "address", "pay", ...), or null if
// this isn't checkout. The purchase id is never returned.
function checkoutStep(url: URL): string | null {
  if (!isAmazonHost(url)) return null;
  return CHECKOUT_PATH.exec(url.pathname)?.[1] ?? null;
}

// True on every amazon.com checkout step, whether or not it shows the items,
// so the extension knows it's in checkout even before the review page.
export function isAmazonCheckoutPage(url: URL, _doc: Document, _overrides?: SelectorOverrides): boolean {
  return checkoutStep(url) !== null;
}

// Read the items being bought. Returns null if this isn't checkout, the step
// doesn't show the items, or anything can't be read reliably. As on the cart,
// the lines must add up exactly to Amazon's own items subtotal.
export function extractAmazonCheckout(doc: Document, url: URL, overrides?: SelectorOverrides): CartDraft | null {
  return isAmazonCheckoutPage(url, doc) ? readAmazonCheckout(doc, url, overrides).draft : null;
}

// The checkout reader behind extractAmazonCheckout, with the reasons it gave up.
export function readAmazonCheckout(doc: Document, url: URL, overrides?: SelectorOverrides): Reading {
  const { selectors: s, notes } = resolveAmazonSelectors(doc, overrides);
  const step = checkoutStep(url) ?? "unknown";
  const problems: string[] = [];
  const details: Record<string, string> = { step };
  const items: CartDraft["items"] = [];

  const elements = [...doc.querySelectorAll(s["checkout.lineItems"])];
  details["items seen"] = String(elements.length);
  if (elements.length === 0) {
    problems.push(`checkout ${step} step: items not shown on this step`);
    return withConfigNotes({ draft: null, problems, details }, notes);
  }

  elements.forEach((element, index) => {
    const label = `item ${index + 1}`;
    const name = cleanName(element.querySelector(s["checkout.itemTitle"])?.textContent);
    // The price you pay (a struck-through list price may sit next to it).
    const priceText = element.querySelector(s["checkout.itemPrice"])?.textContent ?? null;
    const priceMinor = parsePriceToMinor(priceText ?? "", CURRENCY);
    const qtyText = element.querySelector(s["checkout.itemQuantity"])?.getAttribute("data-steppervalue") ?? null;
    const qty = qtyText !== null && /^\d+$/.test(qtyText) ? Number(qtyText) : 0;

    if (!name) problems.push(`${label} has no name`);
    if (priceMinor === null) problems.push(`${label} has no readable price: ${quote(priceText)}`);
    if (qty < 1) problems.push(`${label} has no readable quantity: ${quote(qtyText)}`);
    if (name && priceMinor !== null && qty >= 1) items.push({ name, price_minor: priceMinor, qty });
  });

  const summary = doc.querySelector(s["checkout.summary"]);
  const codeInput = [...(summary?.querySelectorAll(s["checkout.summaryTypeCode"]) ?? [])].find(
    (el) => el.getAttribute("value") === ITEMS_SUBTOTAL_CODE,
  );
  const subtotalRow = codeInput?.closest(s["checkout.summaryRow"]);
  const subtotalText = subtotalRow?.querySelector(s["checkout.summaryAmount"])?.textContent ?? null;
  details["items subtotal"] = quote(subtotalText);
  const orderTotal = summary?.querySelector(s["checkout.orderTotal"]);
  details["order total"] = quote(orderTotal?.textContent);

  const total = parsePriceToMinor(subtotalText ?? "", CURRENCY);
  if (total === null) {
    problems.push(subtotalText === null ? `no items subtotal (${ITEMS_SUBTOTAL_CODE}) in the order summary` : `items subtotal ${quote(subtotalText)} isn't a readable price`);
  }

  // The checkout path carries the purchase id, so report checkout generically.
  return withConfigNotes(finishReading(`${url.origin}/checkout`, items, total, problems, details), notes);
}
