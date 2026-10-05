import type { CartDraft } from "../messages";
import { isAmazonHost } from "./amazon";
import { parsePriceToMinor } from "./price";
import { CURRENCY, cleanName, finishReading, formatMinor, quote, type Reading } from "./reading";

// Selectors come from a real amazon.com product page (sanitized copy in
// __fixtures__). The buy box is form#addToCart: it holds the price you pay,
// the quantity dropdown, the selected variant's ASIN, and the Add to cart /
// Buy Now buttons. The struck-through "List Price" (.basisPrice) is ignored.
const PRODUCT_PATH = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/;
const BUY_BOX = "form#addToCart";
const BUY_BOX_PRICE = `${BUY_BOX} #corePrice_feature_div .apex-pricetopay-value .a-offscreen`;
// The same price, shown again under the title. When present it must agree.
const PAGE_PRICE = "#corePriceDisplay_desktop_feature_div .priceToPay";
const QUANTITY = `${BUY_BOX} select#quantity`;
// span: a hidden input in the product details reuses the productTitle id.
const TITLE = "span#productTitle";

function asinFromPath(url: URL): string | null {
  return PRODUCT_PATH.exec(url.pathname)?.[1] ?? null;
}

// True on an amazon.com product page: a /dp/<ASIN> (or /gp/product/<ASIN>)
// URL that renders the product detail page.
export function isAmazonProductPage(url: URL, doc: Document): boolean {
  return isAmazonHost(url) && asinFromPath(url) !== null && doc.querySelector("#dp") !== null;
}

// The product as a one-item cart: what Add to cart or Buy Now would add.
// Returns null if this isn't a product page or anything can't be read reliably.
export function extractAmazonProduct(doc: Document, url: URL): CartDraft | null {
  return isAmazonProductPage(url, doc) ? readAmazonProduct(doc, url).draft : null;
}

// The product reader behind extractAmazonProduct, with the reasons it gave up.
export function readAmazonProduct(doc: Document, url: URL): Reading {
  const problems: string[] = [];
  const details: Record<string, string> = {};

  // The buy box's ASIN is the selected variant; the URL may name the parent.
  const formAsin = doc.querySelector<HTMLInputElement>(`${BUY_BOX} input#ASIN`)?.value ?? "";
  const asin = /^[A-Z0-9]{10}$/.test(formAsin) ? formAsin : asinFromPath(url);
  details.asin = asin ?? "(none)";

  const name = cleanName(doc.querySelector(TITLE)?.textContent);
  if (!name) problems.push(`no product title (${TITLE})`);

  const priceText = doc.querySelector(BUY_BOX_PRICE)?.textContent ?? null;
  details["buy box price"] = quote(priceText);
  const price = parsePriceToMinor(priceText ?? "", CURRENCY);
  if (price === null) {
    problems.push(priceText === null ? "no price in the buy box" : `buy box price ${quote(priceText)} isn't a readable price`);
  }

  const pagePrice = readSplitPrice(doc.querySelector(PAGE_PRICE));
  details["page price"] = pagePrice === null ? "(not shown)" : formatMinor(pagePrice);
  if (price !== null && pagePrice !== null && price !== pagePrice) {
    problems.push(`buy box price ${formatMinor(price)} but the page shows ${formatMinor(pagePrice)}`);
  }

  const qtySelect = doc.querySelector<HTMLSelectElement>(QUANTITY);
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
  return finishReading(pageUrl, items, total, problems, details);
}

// Amazon renders some prices as separate whole and fraction spans with an
// empty offscreen copy: <span class="a-price-whole">45<span>.</span></span>
// <span class="a-price-fraction">98</span>. Returns minor units or null.
function readSplitPrice(element: Element | null): number | null {
  if (!element) return null;
  const whole = element.querySelector(".a-price-whole")?.textContent?.replace(/[.\s]+$/, "") ?? "";
  const fraction = element.querySelector(".a-price-fraction")?.textContent?.trim() ?? "";
  if (!whole || !fraction) return null;
  return parsePriceToMinor(`${whole}.${fraction}`, CURRENCY);
}
