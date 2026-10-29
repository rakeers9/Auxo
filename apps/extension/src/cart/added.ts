import type { CartDraft } from "../messages";
import { isAmazonHost } from "./amazon";
import { scanMiniCart } from "./minicart";
import { parsePriceToMinor } from "./price";
import { CURRENCY, finishReading, formatMinor, quote, type Reading } from "./reading";
import { resolveAmazonSelectors, withConfigNotes, type SelectorOverrides } from "./selectors";

// Selectors come from a real amazon.com "Added to cart" page (sanitized copy
// in __fixtures__). After Add to cart, Amazon navigates to
// /cart/smart-wagon?newItems=<item id>,<qty added>. The confirmation block
// names the added item only by id (an image with data-itemid); its name and
// price come from the same item in the nav mini cart, which lists the whole
// cart and must add up to this page's cart subtotal. Selectors: "addedToCart.*".
const ADDED_PATH = "/cart/smart-wagon";

// True on the page Amazon shows right after Add to cart, whether or not the
// add succeeded (the success message is reported in details).
export function isAmazonAddedToCartPage(url: URL, doc: Document, overrides?: SelectorOverrides): boolean {
  const { selectors: s } = resolveAmazonSelectors(doc, overrides);
  return isAmazonHost(url) && url.pathname.replace(/\/$/, "") === ADDED_PATH && doc.querySelector(s["addedToCart.confirmation"]) !== null;
}

// The item just added, as a one-item cart at the quantity added. Returns null
// if this isn't the page or anything can't be read reliably.
export function extractAmazonAddedToCart(doc: Document, url: URL, overrides?: SelectorOverrides): CartDraft | null {
  return isAmazonAddedToCartPage(url, doc, overrides) ? readAmazonAddedToCart(doc, url, overrides).draft : null;
}

// The reader behind extractAmazonAddedToCart, with the reasons it gave up.
export function readAmazonAddedToCart(doc: Document, url: URL, overrides?: SelectorOverrides): Reading {
  const { selectors: s, notes } = resolveAmazonSelectors(doc, overrides);
  const problems: string[] = [];
  const details: Record<string, string> = {};

  const added = doc.querySelector(s["addedToCart.success"]) !== null;
  details.added = added ? "yes" : "no";
  const subtotalText = doc.querySelector(s["addedToCart.cartSubtotal"])?.textContent ?? null;
  details["cart subtotal"] = quote(subtotalText);
  details["cart items"] = doc.querySelector<HTMLInputElement>(s["addedToCart.cartQuantity"])?.value || "(missing)";
  if (!added) problems.push('no "Added to cart" confirmation on the page');

  // The confirmation names each added item by id. "Add all" offers add several.
  const addedIds = [...new Set([...doc.querySelectorAll(s["addedToCart.addedItems"])].map((el) => el.getAttribute("data-itemid") ?? ""))];
  if (addedIds.length === 0 || addedIds.includes("")) {
    problems.push("the confirmation doesn't show which item was added");
    return withConfigNotes({ draft: null, problems, details }, notes);
  }

  // The whole mini cart must add up to this page's cart subtotal, so the
  // added items' prices are trusted only when every line reads cleanly.
  const scan = scanMiniCart(doc, s);
  problems.push(...scan.problems);
  details["mini cart sum"] = formatMinor(scan.sum);
  const subtotal = parsePriceToMinor(subtotalText ?? "", CURRENCY);
  if (subtotal === null) {
    problems.push(subtotalText === null ? `no cart subtotal (${s["addedToCart.cartSubtotal"]}) on the page` : `cart subtotal ${quote(subtotalText)} isn't a readable price`);
  } else if (problems.length === 0 && scan.lines.length > 0 && scan.sum !== subtotal) {
    problems.push(`mini cart sums ${formatMinor(scan.sum)} but the cart subtotal says ${formatMinor(subtotal)}`);
  }
  if (scan.seen - scan.skipped === 0) problems.push("the mini cart is empty or not loaded");

  // newItems=<item id>,<qty added>, or several joined with "|". The mini cart
  // line holds an item's total quantity in the cart, which may include copies
  // added earlier.
  const addedQtys = new Map<string, number>();
  for (const entry of (url.searchParams.get("newItems") ?? "").split("|")) {
    const match = /^([0-9a-f-]{36}),(\d+)$/i.exec(entry);
    if (match?.[1]) addedQtys.set(match[1], Number(match[2]));
  }
  details["added qty"] = addedIds.map((id) => String(addedQtys.get(id) ?? "?")).join(", ");
  if (addedIds.length > 1) details["added items"] = String(addedIds.length);

  const items: CartDraft["items"] = [];
  let total = 0;
  for (const [index, id] of addedIds.entries()) {
    const label = addedIds.length > 1 ? `added item ${index + 1}` : "the added item";
    const line = scan.lines.find((l) => l.itemId === id);
    const addedQty = addedQtys.get(id) ?? 0;
    if (!line && scan.problems.length === 0 && scan.seen - scan.skipped > 0) problems.push(`${label} isn't in the mini cart`);
    if (addedQty < 1) problems.push(addedIds.length > 1 ? `the quantity added for ${label} isn't in the URL (newItems)` : "the quantity added isn't in the URL (newItems)");
    else if (line && addedQty > line.qty) problems.push(`URL says ${addedQty} added but the cart holds ${line.qty}${addedIds.length > 1 ? ` (${label})` : ""}`);
    if (line && addedQty >= 1) {
      items.push({ name: line.name, price_minor: line.price_minor, qty: addedQty });
      total += line.price_minor * addedQty;
    }
  }

  const ok = items.length === addedIds.length;
  return withConfigNotes(finishReading(`${url.origin}${ADDED_PATH}`, ok ? items : [], ok ? total : null, problems, details), notes);
}
