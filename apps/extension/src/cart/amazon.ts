import type { CartDraft } from "../messages";
import { parsePriceToMinor } from "./price";
import { CURRENCY, cleanName, finishReading, quote, type Reading } from "./reading";

// Selectors come from real amazon.com cart pages (sanitized copies live in
// __fixtures__). Items in the Active Items list carry their own data-price
// (unit price), data-quantity and data-producttitle attributes.
const ACTIVE_CART = "#sc-active-cart";
const ACTIVE_CART_FORM = `${ACTIVE_CART} form#activeCartViewForm`;
const ACTIVE_ITEMS = `${ACTIVE_CART} [data-name="Active Items"] [data-itemtype="active"][data-asin]`;
const SUBTOTAL = "#sc-subtotal-amount-buybox";

export function isAmazonHost(url: URL): boolean {
  return url.protocol === "https:" && url.hostname === "www.amazon.com";
}

// True on the amazon.com cart page, empty or not. Other pages (a product page,
// for example) also include the cart in the nav flyout, so we look for the
// cart page's own Active Cart form rather than for cart items.
export function isAmazonCartPage(url: URL, doc: Document): boolean {
  return isAmazonHost(url) && doc.querySelector(ACTIVE_CART_FORM) !== null;
}

// Read the active cart. Returns null if this isn't a cart page, the cart is
// empty, or anything can't be read reliably, so the caller fails open instead
// of acting on a guess. The line items must add up to Amazon's own subtotal.
export function extractAmazonCart(doc: Document, url: URL): CartDraft | null {
  return isAmazonCartPage(url, doc) ? readAmazonCart(doc, url).draft : null;
}

// The cart reader behind extractAmazonCart, with the reasons it gave up.
export function readAmazonCart(doc: Document, url: URL): Reading {
  const problems: string[] = [];
  const details: Record<string, string> = {};
  const items: CartDraft["items"] = [];
  let removed = 0;

  const elements = [...doc.querySelectorAll(ACTIVE_ITEMS)];
  elements.forEach((element, index) => {
    // "Save for later" and "Delete" leave the item in the active list, marked
    // data-removed, until the page reloads. Amazon's subtotal already excludes it.
    if (element.getAttribute("data-removed") === "true") {
      removed++;
      return;
    }
    const label = `item ${index + 1}`;
    const name = cleanName(
      element.getAttribute("data-producttitle") ||
        element.querySelector(".sc-product-title .a-truncate-full")?.textContent,
    );
    const priceText = element.getAttribute("data-price");
    const priceMinor = parsePriceToMinor(priceText ?? "", CURRENCY);
    const qtyText = element.getAttribute("data-quantity");
    const qty = qtyText !== null && /^\d+$/.test(qtyText) ? Number(qtyText) : 0;

    if (!name) problems.push(`${label} has no name (no data-producttitle or visible title)`);
    if (priceMinor === null) problems.push(`${label} has no readable data-price: ${quote(priceText)}`);
    if (qty < 1) problems.push(`${label} has no positive whole data-quantity: ${quote(qtyText)}`);
    if (name && priceMinor !== null && qty >= 1) items.push({ name, price_minor: priceMinor, qty });
  });

  details["items seen"] = String(elements.length);
  details["removed"] = String(removed);
  if (elements.length - removed === 0) problems.push("no items in the active cart");

  const subtotalText = doc.querySelector(SUBTOTAL)?.textContent ?? null;
  details["subtotal"] = quote(subtotalText);
  const total = parsePriceToMinor(subtotalText ?? "", CURRENCY);
  if (elements.length - removed > 0 && total === null) {
    problems.push(subtotalText === null ? `no subtotal (${SUBTOTAL}) on the page` : `subtotal ${quote(subtotalText)} isn't a readable price`);
  }

  // Origin and path only: query strings can carry session and tracking values.
  return finishReading(`${url.origin}${url.pathname}`, items, total, problems, details);
}
