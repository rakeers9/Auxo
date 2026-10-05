import type { CartDraft } from "../messages";
import { isAmazonHost } from "./amazon";
import { scanMiniCart } from "./minicart";
import { parsePriceToMinor } from "./price";
import { CURRENCY, finishReading, formatMinor, quote, type Reading } from "./reading";

// Selectors come from a real amazon.com "Added to cart" page (sanitized copy
// in __fixtures__). After Add to cart, Amazon navigates to
// /cart/smart-wagon?newItems=<item id>,<qty added>. The confirmation block
// names the added item only by id (an image with data-itemid); its name and
// price come from the same item in the nav mini cart, which lists the whole
// cart and must add up to this page's cart subtotal.
const ADDED_PATH = "/cart/smart-wagon";
const CONFIRMATION = "#sw-atc-confirmation";
const SUCCESS = "#NATC_SMART_WAGON_CONF_MSG_SUCCESS";
const ADDED_ITEMS = "#add-to-cart-confirmation-image [data-itemid]";
const CART_SUBTOTAL = "#sw-subtotal .a-offscreen";
const CART_QUANTITY = "input#sw-total-quantity";

// True on the page Amazon shows right after Add to cart, whether or not the
// add succeeded (the success message is reported in details).
export function isAmazonAddedToCartPage(url: URL, doc: Document): boolean {
  return isAmazonHost(url) && url.pathname.replace(/\/$/, "") === ADDED_PATH && doc.querySelector(CONFIRMATION) !== null;
}

// The item just added, as a one-item cart at the quantity added. Returns null
// if this isn't the page or anything can't be read reliably.
export function extractAmazonAddedToCart(doc: Document, url: URL): CartDraft | null {
  return isAmazonAddedToCartPage(url, doc) ? readAmazonAddedToCart(doc, url).draft : null;
}

// The reader behind extractAmazonAddedToCart, with the reasons it gave up.
export function readAmazonAddedToCart(doc: Document, url: URL): Reading {
  const problems: string[] = [];
  const details: Record<string, string> = {};

  const added = doc.querySelector(SUCCESS) !== null;
  details.added = added ? "yes" : "no";
  const subtotalText = doc.querySelector(CART_SUBTOTAL)?.textContent ?? null;
  details["cart subtotal"] = quote(subtotalText);
  details["cart items"] = doc.querySelector<HTMLInputElement>(CART_QUANTITY)?.value || "(missing)";
  if (!added) problems.push('no "Added to cart" confirmation on the page');

  const addedIds = [...doc.querySelectorAll(ADDED_ITEMS)].map((el) => el.getAttribute("data-itemid") ?? "");
  const addedId = addedIds.length === 1 ? addedIds[0] : undefined;
  if (!addedId) {
    problems.push(addedIds.length > 1 ? `the confirmation shows ${addedIds.length} added items; only single adds are read` : "the confirmation doesn't show which item was added");
    return { draft: null, problems, details };
  }

  // The whole mini cart must add up to this page's cart subtotal, so the
  // added item's price is trusted only when every line reads cleanly.
  const scan = scanMiniCart(doc);
  problems.push(...scan.problems);
  details["mini cart sum"] = formatMinor(scan.sum);
  const subtotal = parsePriceToMinor(subtotalText ?? "", CURRENCY);
  if (subtotal === null) {
    problems.push(subtotalText === null ? `no cart subtotal (${CART_SUBTOTAL}) on the page` : `cart subtotal ${quote(subtotalText)} isn't a readable price`);
  } else if (problems.length === 0 && scan.lines.length > 0 && scan.sum !== subtotal) {
    problems.push(`mini cart sums ${formatMinor(scan.sum)} but the cart subtotal says ${formatMinor(subtotal)}`);
  }
  const line = scan.lines.find((l) => l.itemId === addedId);
  if (scan.seen - scan.skipped === 0) problems.push("the mini cart is empty or not loaded");
  else if (!line && scan.problems.length === 0) problems.push("the added item isn't in the mini cart");

  // newItems=<item id>,<qty added>: the mini cart line holds the item's total
  // quantity in the cart, which may include copies added earlier.
  const newItems = /^([0-9a-f-]{36}),(\d+)$/i.exec(url.searchParams.get("newItems") ?? "");
  const addedQty = newItems && newItems[1] === addedId ? Number(newItems[2]) : 0;
  details["added qty"] = addedQty > 0 ? String(addedQty) : "(not in URL)";
  if (addedQty < 1) problems.push("the quantity added isn't in the URL (newItems)");
  else if (line && addedQty > line.qty) problems.push(`URL says ${addedQty} added but the cart holds ${line.qty}`);

  const ok = line !== undefined && addedQty >= 1;
  const items = ok ? [{ name: line.name, price_minor: line.price_minor, qty: addedQty }] : [];
  return finishReading(`${url.origin}${ADDED_PATH}`, items, ok ? line.price_minor * addedQty : null, problems, details);
}
