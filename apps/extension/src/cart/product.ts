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
// "product.title" is span#: a hidden input in the product details reuses the
// productTitle id.

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

  const price = settlePrice(
    [tryBuyBoxSelector, tryNearForm, tryPagePrice].map((attempt) => attempt(doc, s)),
    problems,
    details,
  );

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

// The price is looked for in layers, most precise first. Every layer that finds
// a price must agree with the others: a disagreement is flagged, never guessed.
// `minors` is empty when a layer found nothing, and `why` then says so.
interface PriceTry {
  strategy: string;
  minors: number[];
  why: string;
}

const found = (strategy: string, minors: number[]): PriceTry => ({ strategy, minors, why: "" });
const missed = (strategy: string, why: string): PriceTry => ({ strategy, minors: [], why });

// Layer 1: the exact buy box selector (product.buyBoxPrice).
function tryBuyBoxSelector(doc: Document, s: AmazonSelectors): PriceTry {
  const element = doc.querySelector(s["product.buyBoxPrice"]);
  if (!element) return missed("buy box", "selector matched nothing");
  const minor = parsePriceToMinor(element.textContent ?? "", CURRENCY);
  return minor === null ? missed("buy box", `${quote(element.textContent)} isn't a readable price`) : found("buy box", [minor]);
}

// Layer 2, the general one: from the add-to-cart form, walk outward until an
// ancestor holds a "price to pay", and read it. Some layouts (the accordion buy
// box) put the price beside the form instead of inside it; this finds it, and
// stops before the next offer's price (a used offer has its own row).
function tryNearForm(doc: Document, s: AmazonSelectors): PriceTry {
  const form = doc.querySelector(s["product.buyBoxForm"]);
  if (!form) return missed("near form", "no add-to-cart form");
  for (let node: Element | null = form; node && node !== doc.body; node = node.parentElement) {
    const candidates = [...node.querySelectorAll(s["product.priceToPay"])].filter((e) => !e.closest(s["product.listPrice"]));
    if (candidates.length === 0) continue;
    const minors = [...new Set(candidates.map((e) => readPriceElement(e, s)).filter((m): m is number => m !== null))];
    return minors.length > 0 ? found("near form", minors) : missed("near form", "a price to pay is there but has no readable number");
  }
  return missed("near form", "no price to pay around the form");
}

// Layer 3: the price repeated under the title.
function tryPagePrice(doc: Document, s: AmazonSelectors): PriceTry {
  const element = doc.querySelector(s["product.pagePrice"]);
  if (!element) return missed("page price", "not shown");
  const minor = readPriceElement(element, s);
  return minor === null ? missed("page price", "shown but not readable") : found("page price", [minor]);
}

// The agreed price, or null with the reason in `problems`.
function settlePrice(tries: PriceTry[], problems: string[], details: Record<string, string>): number | null {
  const hits = tries.filter((t) => t.minors.length > 0);
  const distinct = new Set(hits.flatMap((t) => t.minors));
  if (distinct.size === 0) {
    problems.push(`no price found (${tries.map((t) => `${t.strategy}: ${t.why}`).join("; ")})`);
    details.price = "(none)";
    return null;
  }
  if (distinct.size > 1) {
    problems.push(`conflicting prices: ${hits.map((t) => `${t.strategy} ${t.minors.map((m) => formatMinor(m)).join(" / ")}`).join(", ")}`);
    details.price = "(conflict)";
    return null;
  }
  const price = hits[0]!.minors[0]!;
  details.price = `${formatMinor(price)} via ${hits.map((t) => t.strategy).join(" + ")}`;
  return price;
}

// A price element: its offscreen text, or else its whole and fraction spans
// (the offscreen copy is sometimes blank).
function readPriceElement(element: Element, s: AmazonSelectors): number | null {
  const offscreen = element.querySelector(s["product.priceOffscreen"])?.textContent ?? "";
  return parsePriceToMinor(offscreen, CURRENCY) ?? readSplitPrice(element, s);
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
