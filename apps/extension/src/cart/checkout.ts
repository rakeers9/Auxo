import type { CartDraft } from "../messages";
import { isAmazonHost } from "./amazon";
import { parsePriceToMinor } from "./price";
import { CURRENCY, cleanName, finishReading, quote, type Reading } from "./reading";

// Selectors come from real amazon.com checkout pages, reached both from the
// cart (Proceed to checkout) and from a product (Buy Now). Both land on the
// same one-page "Place Your Order" layout at /checkout/p/<purchase-id>/spc;
// other steps (address, pay, ...) live under the same prefix.
const CHECKOUT_PATH = /^\/checkout\/p\/[^/]+\/([^/]+)/;
const LINE_ITEMS = "#checkout-item-block-panel .lineitem-container";
const SUMMARY = "#subtotals-marketplace-table";
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
export function isAmazonCheckoutPage(url: URL, _doc: Document): boolean {
  return checkoutStep(url) !== null;
}

// Read the items being bought. Returns null if this isn't checkout, the step
// doesn't show the items, or anything can't be read reliably. As on the cart,
// the lines must add up exactly to Amazon's own items subtotal.
export function extractAmazonCheckout(doc: Document, url: URL): CartDraft | null {
  return isAmazonCheckoutPage(url, doc) ? readAmazonCheckout(doc, url).draft : null;
}

// The checkout reader behind extractAmazonCheckout, with the reasons it gave up.
export function readAmazonCheckout(doc: Document, url: URL): Reading {
  const step = checkoutStep(url) ?? "unknown";
  const problems: string[] = [];
  const details: Record<string, string> = { step };
  const items: CartDraft["items"] = [];

  const elements = [...doc.querySelectorAll(LINE_ITEMS)];
  details["items seen"] = String(elements.length);
  if (elements.length === 0) {
    problems.push(`checkout ${step} step: items not shown on this step`);
    return { draft: null, problems, details };
  }

  elements.forEach((element, index) => {
    const label = `item ${index + 1}`;
    const name = cleanName(element.querySelector(".lineitem-title-text")?.textContent);
    // The price you pay (a struck-through list price may sit next to it).
    const priceText = element.querySelector(".apex-price-to-pay-value .a-offscreen")?.textContent ?? null;
    const priceMinor = parsePriceToMinor(priceText ?? "", CURRENCY);
    const qtyText = element.querySelector('fieldset[name="checkout-quantity-stepper"]')?.getAttribute("data-steppervalue") ?? null;
    const qty = qtyText !== null && /^\d+$/.test(qtyText) ? Number(qtyText) : 0;

    if (!name) problems.push(`${label} has no name`);
    if (priceMinor === null) problems.push(`${label} has no readable price: ${quote(priceText)}`);
    if (qty < 1) problems.push(`${label} has no readable quantity: ${quote(qtyText)}`);
    if (name && priceMinor !== null && qty >= 1) items.push({ name, price_minor: priceMinor, qty });
  });

  const subtotalRow = doc.querySelector(`${SUMMARY} input[value="${ITEMS_SUBTOTAL_CODE}"]`)?.closest("li");
  const subtotalText = subtotalRow?.querySelector(".order-summary-line-definition")?.textContent ?? null;
  details["items subtotal"] = quote(subtotalText);
  const orderTotal = doc.querySelector(`${SUMMARY} .grand-total-cell .order-summary-line-definition, ${SUMMARY} li:last-child .order-summary-line-definition`);
  details["order total"] = quote(orderTotal?.textContent);

  const total = parsePriceToMinor(subtotalText ?? "", CURRENCY);
  if (total === null) {
    problems.push(subtotalText === null ? `no items subtotal (${ITEMS_SUBTOTAL_CODE}) in the order summary` : `items subtotal ${quote(subtotalText)} isn't a readable price`);
  }

  // The checkout path carries the purchase id, so report checkout generically.
  return finishReading(`${url.origin}/checkout`, items, total, problems, details);
}
