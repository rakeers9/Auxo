import type { CartDraft } from "../messages";
import { parsePriceToMinor } from "./price";
import { CURRENCY, cleanName, finishReading, quote, type Reading } from "./reading";
import { AMAZON_SELECTORS, resolveAmazonSelectors, withConfigNotes, type AmazonSelectors, type SelectorOverrides } from "./selectors";

// The nav mini cart (#nav-flyout-ewc) lists the whole cart on most amazon.com
// pages, with +/- steppers and remove buttons. Selectors come from real pages
// (sanitized copies in __fixtures__). Removing an item, or moving it to Save
// for later, leaves its line in the DOM with the old data-price and
// data-quantity and NO data-removed: the only sign is that its remove / saved
// message loses aok-hidden. The subtotal already excludes it. The hidden
// #ewc-total-quantity goes stale, so it isn't used. Selectors: "minicart.*".

export interface MiniCartLine {
  itemId: string;
  name: string;
  price_minor: number;
  qty: number;
}

export interface MiniCartScan {
  lines: MiniCartLine[];
  // Lines with any unreadable field, for messages; they are not in `lines`.
  problems: string[];
  sum: number;
  subtotal: number | null;
  subtotalText: string | null;
  skipped: number;
  seen: number;
}

// Read every live mini cart line and the mini cart subtotal, without judging
// whether they agree (callers decide; see readAmazonMiniCart).
export function scanMiniCart(doc: Document, s: AmazonSelectors = AMAZON_SELECTORS): MiniCartScan {
  const problems: string[] = [];
  const lines: MiniCartLine[] = [];
  let sum = 0;
  let skipped = 0;
  const elements = [...doc.querySelectorAll(s["minicart.lines"])];

  elements.forEach((element, index) => {
    const gone = [...element.querySelectorAll(s["minicart.goneMessages"])].some((m) => !m.matches(s["minicart.hiddenMessage"]));
    if (gone) {
      skipped++;
      return;
    }
    const label = `mini cart item ${index + 1}`;
    const name = cleanName(element.getAttribute("data-producttitle"));
    const priceText = element.getAttribute("data-price");
    const price = parsePriceToMinor(priceText ?? "", CURRENCY);
    const qtyText = element.getAttribute("data-quantity");
    const qty = qtyText !== null && /^\d+$/.test(qtyText) ? Number(qtyText) : 0;

    if (!name) problems.push(`${label} has no name (data-producttitle)`);
    if (price === null) problems.push(`${label} has no readable data-price: ${quote(priceText)}`);
    if (qty < 1) problems.push(`${label} has no positive whole data-quantity: ${quote(qtyText)}`);
    if (name && price !== null && qty >= 1) {
      lines.push({ itemId: element.getAttribute("data-itemid") ?? "", name, price_minor: price, qty });
      sum += price * qty;
    }
  });

  const subtotalText = doc.querySelector(s["minicart.subtotal"])?.textContent ?? null;
  return { lines, problems, sum, subtotal: parsePriceToMinor(subtotalText ?? "", CURRENCY), subtotalText, skipped, seen: elements.length };
}

// The whole cart as the mini cart shows it, on any page that has one. The
// live lines must add up exactly to the mini cart subtotal, or the draft is null.
export function readAmazonMiniCart(doc: Document, url: URL, overrides?: SelectorOverrides): Reading {
  const { selectors: s, notes } = resolveAmazonSelectors(doc, overrides);
  const scan = scanMiniCart(doc, s);
  const problems = [...scan.problems];
  const details: Record<string, string> = {
    "mini cart items": String(scan.seen),
    "removed skipped": String(scan.skipped),
    "mini cart subtotal": quote(scan.subtotalText),
  };

  if (scan.seen - scan.skipped === 0) problems.push("the mini cart is empty or not loaded");
  if (scan.subtotal === null && scan.seen - scan.skipped > 0) {
    problems.push(scan.subtotalText === null ? `no mini cart subtotal (${s["minicart.subtotal"]})` : `mini cart subtotal ${quote(scan.subtotalText)} isn't a readable price`);
  }

  const items: CartDraft["items"] = scan.lines.map(({ name, price_minor, qty }) => ({ name, price_minor, qty }));
  // The cart page's URL: the mini cart is the cart, whatever page shows it.
  return withConfigNotes(finishReading(`${url.origin}/gp/cart/view.html`, items, scan.subtotal, problems, details, { totalLabel: "the mini cart subtotal" }), notes);
}
