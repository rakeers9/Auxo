import { CartSchema } from "@auxo/shared";

import type { CartDraft } from "../messages";
import { parsePriceToMinor } from "./price";

// Selectors come from real amazon.com cart pages (sanitized copies live in
// __fixtures__). Items in the Active Items list carry their own data-price
// (unit price), data-quantity and data-producttitle attributes.
const ACTIVE_CART = "#sc-active-cart";
const ACTIVE_ITEMS = `${ACTIVE_CART} [data-name="Active Items"] [data-itemtype="active"][data-asin]`;
const SUBTOTAL = "#sc-subtotal-amount-buybox";

const MERCHANT = "amazon.com";
const CURRENCY = "USD";
const MAX_NAME_LENGTH = 500;

const CartDraftSchema = CartSchema.omit({ cart_hash: true });

// True on the amazon.com cart page, empty or not. Other pages (a product page,
// for example) also include the cart in the nav flyout, so we look for the
// cart page's own Active Cart form rather than for cart items.
export function isAmazonCartPage(url: URL, doc: Document): boolean {
  return (
    url.protocol === "https:" &&
    url.hostname === "www.amazon.com" &&
    doc.querySelector(`${ACTIVE_CART} form#activeCartViewForm`) !== null
  );
}

// Read the active cart. Returns null if this isn't a cart page, the cart is
// empty, or anything can't be read reliably, so the caller fails open instead
// of acting on a guess. The line items must add up to Amazon's own subtotal.
export function extractAmazonCart(doc: Document, url: URL): CartDraft | null {
  if (!isAmazonCartPage(url, doc)) return null;

  const items: CartDraft["items"] = [];
  for (const element of doc.querySelectorAll(ACTIVE_ITEMS)) {
    // "Save for later" and "Delete" leave the item in the active list, marked
    // data-removed, until the page reloads. Amazon's subtotal already excludes it.
    if (element.getAttribute("data-removed") === "true") continue;
    const item = readItem(element);
    if (!item) return null;
    items.push(item);
  }
  if (items.length === 0) return null;

  const total = parsePriceToMinor(doc.querySelector(SUBTOTAL)?.textContent ?? "", CURRENCY);
  if (total === null) return null;
  const sum = items.reduce((acc, item) => acc + item.price_minor * item.qty, 0);
  if (!Number.isSafeInteger(sum) || sum !== total) return null;

  const draft: CartDraft = {
    merchant: MERCHANT,
    items,
    total_minor: total,
    currency: CURRENCY,
    // Origin and path only: query strings can carry session and tracking values.
    url: `${url.origin}${url.pathname}`,
  };
  return CartDraftSchema.safeParse(draft).success ? draft : null;
}

function readItem(element: Element): CartDraft["items"][number] | null {
  const name = normalize(
    element.getAttribute("data-producttitle") ||
      element.querySelector(".sc-product-title .a-truncate-full")?.textContent ||
      "",
  ).slice(0, MAX_NAME_LENGTH);
  const priceMinor = parsePriceToMinor(element.getAttribute("data-price") ?? "", CURRENCY);
  const qtyText = element.getAttribute("data-quantity") ?? "";
  const qty = /^\d+$/.test(qtyText) ? Number(qtyText) : 0;

  if (!name || priceMinor === null || qty < 1) return null;
  return { name, price_minor: priceMinor, qty };
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
