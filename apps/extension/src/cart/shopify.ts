import { z } from "zod";

import type { CartDraft } from "../messages";
import { cleanName, finishReading, formatMinor, type Reading } from "./reading";

// Grounded in real responses (sanitized copies in __fixtures__/shopify):
// a classic Shopify store (Allbirds) serves its cart as JSON at /cart.js,
// amounts in the currency's minor units. A headless Shopify store (Gymshark)
// has no such API: /cart.js returns an HTML 404 page.

// Classic Shopify storefronts render these; a headless one only links Shopify's
// image CDN, which isn't enough to expect /cart.js. Only decides whether to probe.
const SHOPIFY_HINTS = 'meta[name="shopify-digital-wallet"], script#shopify-features';
const SHOPIFY_INLINE_GLOBAL = /\bShopify\.shop\s*=/;

export function isLikelyShopify(doc: Document): boolean {
  if (doc.querySelector(SHOPIFY_HINTS)) return true;
  return [...doc.scripts].some((script) => !script.src && SHOPIFY_INLINE_GLOBAL.test(script.textContent ?? ""));
}

export type ShopifyPageType = "product" | "cart" | "other";

// From the URL alone. Checkout is left out on purpose: real pages only show
// Shopify's /checkouts/ prefix (for /checkouts/internal/preloads.js), and the
// checkout page path couldn't be verified without starting a checkout.
export function shopifyPageType(url: URL): ShopifyPageType {
  if (/^\/(?:collections\/[^/]+\/)?products\/[^/]+\/?$/.test(url.pathname)) return "product";
  if (/^\/cart\/?$/.test(url.pathname)) return "cart";
  return "other";
}

// Only the fields the reader uses. `title` is skipped: real carts send it
// HTML-escaped ("Men&#39;s ..."), so the name is built from product_title and
// variant_title, which arrive as plain text.
const ShopifyLineSchema = z.object({
  product_title: z.string(),
  variant_title: z.string().nullish(),
  product_has_only_default_variant: z.boolean().optional(),
  quantity: z.number().int(),
  // Per-unit price after line-level discounts (price / original_price are before).
  final_price: z.number().int(),
  // final_price x quantity, as Shopify computed it.
  final_line_price: z.number().int(),
});

export const ShopifyCartSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  // Sum of final_line_price: items after line discounts, before shipping, tax,
  // and cart-level discounts (which total_price includes). Matches the Amazon
  // readers' items subtotal.
  items_subtotal_price: z.number().int(),
  total_price: z.number().int().optional(),
  items: z.array(ShopifyLineSchema),
});

export type ShopifyCart = z.infer<typeof ShopifyCartSchema>;

const NO_CART_API = "no Shopify cart API on this site";

// Read a Shopify /cart.js response: the parsed JSON, or the raw body as a
// string (a headless store answers with HTML). Same bar as the Amazon readers:
// lines must add up exactly to the store's items subtotal, or the draft is null.
export function readShopifyCart(response: unknown, url: URL): Reading {
  const details: Record<string, string> = {};
  let json = response;
  if (typeof response === "string") {
    try {
      json = JSON.parse(response) as unknown;
    } catch {
      details.response = "not JSON";
      return { draft: null, problems: [NO_CART_API], details };
    }
  }
  const parsed = ShopifyCartSchema.safeParse(json);
  if (!parsed.success) {
    details.response = "JSON, but not a Shopify cart";
    return { draft: null, problems: [NO_CART_API], details };
  }

  const cart = parsed.data;
  const problems: string[] = [];
  details.currency = cart.currency;
  details["items seen"] = String(cart.items.length);
  details["items subtotal"] = formatMinor(cart.items_subtotal_price, cart.currency);
  if (cart.total_price !== undefined) details["cart total"] = formatMinor(cart.total_price, cart.currency);

  if (minorDigits(cart.currency) !== 2) {
    problems.push(`currency ${cart.currency} isn't supported yet (only 2-decimal currencies are verified)`);
  }
  if (cart.items.length === 0) problems.push("the cart is empty");

  const items: CartDraft["items"] = [];
  cart.items.forEach((line, index) => {
    const label = `item ${index + 1}`;
    const variant = line.product_has_only_default_variant ? null : line.variant_title?.trim();
    const name = cleanName(variant ? `${line.product_title} - ${variant}` : line.product_title);
    if (!name) problems.push(`${label} has no product_title`);
    if (line.quantity < 1) problems.push(`${label} has quantity ${line.quantity}`);
    if (line.final_price < 0) problems.push(`${label} has a negative final_price`);
    // An uneven discount split leaves no exact integer unit price.
    if (line.final_price * line.quantity !== line.final_line_price) {
      problems.push(`${label}: final_price ${line.final_price} x ${line.quantity} doesn't equal final_line_price ${line.final_line_price}`);
    }
    if (name && line.quantity >= 1 && line.final_price >= 0) items.push({ name, price_minor: line.final_price, qty: line.quantity });
  });

  return finishReading(`${url.origin}/cart`, items, cart.items_subtotal_price, problems, details, {
    totalLabel: "the cart's items_subtotal_price",
    merchant: url.hostname,
    currency: cart.currency,
  });
}

// Digits after the decimal point for a currency, from the runtime's ICU data.
function minorDigits(currency: string): number | null {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? null;
  } catch {
    return null;
  }
}
