import type { CartDraft } from "../messages";
import { isAmazonHost } from "./amazon";
import { parsePriceToMinor } from "./price";
import { CURRENCY, cleanName, finishReading, formatMinor, quote, type Reading } from "./reading";
import { resolveAmazonSelectors, withConfigNotes, type AmazonSelectors, type SelectorOverrides } from "./selectors";

// Selectors come from a real amazon.com product page (sanitized copy in
// __fixtures__). The buy box is form#addToCart: it holds the price you pay,
// the quantity dropdown, the selected variant's ASIN, and the Add to cart /
// Buy Now buttons. The struck-through "List Price" (.basisPrice) is ignored.
const PRODUCT_PATH = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/;
// "product.pagePrice" repeats the buy box price under the title; when present
// it must agree. "product.title" is span#: a hidden input in the product
// details reuses the productTitle id.

function asinFromPath(url: URL): string | null {
  return PRODUCT_PATH.exec(url.pathname)?.[1] ?? null;
}

// True on an amazon.com product page: a /dp/<ASIN> (or /gp/product/<ASIN>)
// URL that renders the product detail page.
export function isAmazonProductPage(url: URL, doc: Document, overrides?: SelectorOverrides): boolean {
  const { selectors: s } = resolveAmazonSelectors(doc, overrides);
  return isAmazonHost(url) && asinFromPath(url) !== null && doc.querySelector(s["product.page"]) !== null;
}

// The product as a one-item cart: what Add to cart or Buy Now would add.
// Returns null if this isn't a product page or anything can't be read reliably.
export function extractAmazonProduct(doc: Document, url: URL, overrides?: SelectorOverrides): CartDraft | null {
  return isAmazonProductPage(url, doc, overrides) ? readAmazonProduct(doc, url, overrides).draft : null;
}

// The product reader behind extractAmazonProduct, with the reasons it gave up.
export function readAmazonProduct(doc: Document, url: URL, overrides?: SelectorOverrides): Reading {
  const { selectors: s, notes } = resolveAmazonSelectors(doc, overrides);
  const problems: string[] = [];
  const details: Record<string, string> = {};

  // The buy box's ASIN is the selected variant; the URL may name the parent.
  const formAsin = doc.querySelector<HTMLInputElement>(s["product.buyBoxAsin"])?.value ?? "";
  const asin = /^[A-Z0-9]{10}$/.test(formAsin) ? formAsin : asinFromPath(url);
  details.asin = asin ?? "(none)";

  const name = cleanName(doc.querySelector(s["product.title"])?.textContent);
  if (!name) problems.push(`no product title (${s["product.title"]})`);

  const priceText = doc.querySelector(s["product.buyBoxPrice"])?.textContent ?? null;
  details["buy box price"] = quote(priceText);
  const price = parsePriceToMinor(priceText ?? "", CURRENCY);
  if (price === null) {
    problems.push(priceText === null ? "no price in the buy box" : `buy box price ${quote(priceText)} isn't a readable price`);
  }

  const pagePrice = readSplitPrice(doc.querySelector(s["product.pagePrice"]), s);
  details["page price"] = pagePrice === null ? "(not shown)" : formatMinor(pagePrice);
  if (price !== null && pagePrice !== null && price !== pagePrice) {
    problems.push(`buy box price ${formatMinor(price)} but the page shows ${formatMinor(pagePrice)}`);
  }

  const qtySelect = doc.querySelector<HTMLSelectElement>(s["product.quantity"]);
  const qtyText = qtySelect?.value ?? null;
  details.qty = quote(qtyText);
  const qty = qtyText !== null && /^\d+$/.test(qtyText) ? Number(qtyText) : 0;
  if (qty < 1) {
    problems.push(qtySelect ? `quantity ${quote(qtyText)} isn't a positive whole number` : "no quantity dropdown in the buy box");
  }

  const items = name && price !== null && qty >= 1 ? [{ name, price_minor: price, qty }] : [];
  const total = price !== null && qty >= 1 ? price * qty : null;
  // Canonical product URL: the slug, ref, and tracking query are dropped.
  const pageUrl = asin ? `${url.origin}/dp/${asin}` : `${url.origin}${url.pathname}`;
  return withConfigNotes(finishReading(pageUrl, items, total, problems, details), notes);
}

// Amazon renders some prices as separate whole and fraction spans with an
// empty offscreen copy: <span class="a-price-whole">45<span>.</span></span>
// <span class="a-price-fraction">98</span>. Returns minor units or null.
function readSplitPrice(element: Element | null, s: AmazonSelectors): number | null {
  if (!element) return null;
  const whole = element.querySelector(s["product.priceWhole"])?.textContent?.replace(/[.\s]+$/, "") ?? "";
  const fraction = element.querySelector(s["product.priceFraction"])?.textContent?.trim() ?? "";
  if (!whole || !fraction) return null;
  return parsePriceToMinor(`${whole}.${fraction}`, CURRENCY);
}
