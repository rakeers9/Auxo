import { z } from "zod";

// Why a page reader couldn't read a page, as stable codes only (AUX-47). The
// extension's `problems` strings quote page text (titles, prices, labels), so
// they never leave the browser; each one maps to a code here. Reports carry
// no user, URL path, item, price, or exact time: only what ranking reader
// failures needs. Purpose: a to-do list of selectors and readers to fix.

export const ReaderSchema = z.enum([
  "amazon_cart",
  "amazon_checkout",
  "amazon_product",
  "amazon_added_to_cart",
  "amazon_minicart",
  "shopify_cart",
]);

export const ReadFailureCodeSchema = z.enum([
  // A line item (cart, checkout, mini cart, Shopify cart).
  "item.no_name",
  "item.no_price",
  "item.no_qty",
  // A line's unit price times quantity doesn't match its line total.
  "item.price_mismatch",
  // The page's own total.
  "total.missing",
  "total.unreadable",
  "total.mismatch",
  "cart.no_items",
  "cart.schema_invalid",
  // Product page.
  "product.no_title",
  "qty.no_dropdown",
  "qty.unreadable",
  "price.no_layer_found",
  "price.layers_conflict",
  // Amazon's "Added to cart" page.
  "added.no_confirmation",
  "added.no_item",
  "added.item_not_in_minicart",
  "added.no_qty_in_url",
  "added.qty_mismatch",
  "minicart.not_loaded",
  // Shopify's /cart.js.
  "shopify.no_cart_api",
  "shopify.currency_unsupported",
  "shopify.timeout",
  "shopify.fetch_failed",
  // A problem the extension has no code for yet: a mapping to add.
  "unknown",
]);

// The page the reader ran on. "other" is a page with no reader of its own
// where the cart sidebar (amazon_minicart) is still read, e.g. search results.
export const ReadFailurePageTypeSchema = z.enum(["product", "cart", "checkout", "added_to_cart", "other"]);

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// zod runs this even when the format check failed, so it must not throw.
function isRealDay(day: string): boolean {
  if (!DAY.test(day)) return false;
  const time = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(day);
}

export const ReadFailureReportSchema = z
  .object({
    reader: ReaderSchema,
    page_type: ReadFailurePageTypeSchema,
    // The store's hostname for stores with their own reader (www.amazon.com);
    // null where the host would only say which shop the user visited.
    store_host: z.string().regex(HOSTNAME).nullable(),
    // The extension's manifest version.
    extension_version: z.string().regex(/^\d{1,9}(?:\.\d{1,9}){0,3}$/),
    codes: z
      .array(ReadFailureCodeSchema)
      .min(1)
      .max(20)
      .refine((codes) => new Set(codes).size === codes.length, "codes must be unique"),
    // UTC calendar day of the failure, never a time.
    day: z
      .string()
      .regex(DAY)
      .refine(isRealDay, "day must be a real date"),
  })
  .strict();

export type Reader = z.infer<typeof ReaderSchema>;
export type ReadFailureCode = z.infer<typeof ReadFailureCodeSchema>;
export type ReadFailurePageType = z.infer<typeof ReadFailurePageTypeSchema>;
export type ReadFailureReport = z.infer<typeof ReadFailureReportSchema>;
