import type { Reader, ReadFailureCode } from "@auxo/shared";

// Each reader `problems` string as a stable code (AUX-47). The strings quote
// page text, so only codes are ever reported. Patterns match the fixed part
// of each message, never what it quotes; codes.test.ts produces every
// message from the real readers, so a reworded message fails a test instead
// of silently changing (or losing) its code.

// Not reader failures: the page is in a state with nothing to read yet.
const EXPECTED: RegExp[] = [
  /^nothing is selected for checkout \(/,
  /^checkout .+ step: items not shown on this step$/,
  /^the cart is empty$/,
  /^Shopify product pages aren't read/,
  /^not a (?:Shopify )?product\b/,
  /^not on https:\/\/www\.amazon\.com /,
  /^not read yet$/,
];

// First match wins.
const PATTERNS: Array<[RegExp, ReadFailureCode]> = [
  [/^(?:mini cart )?item \d+ has no (?:name|product_title)\b/, "item.no_name"],
  [/^(?:mini cart )?item \d+ has no readable (?:data-)?price: /, "item.no_price"],
  [/^item \d+ has a negative final_price$/, "item.no_price"],
  [/^(?:mini cart )?item \d+ has no (?:positive whole data-quantity|readable quantity): /, "item.no_qty"],
  [/^item \d+ has quantity -?\d+$/, "item.no_qty"],
  [/^item \d+: final_price .+ doesn't equal final_line_price /, "item.price_mismatch"],
  [/^no (?:items |mini cart |cart )?subtotal \(/, "total.missing"],
  [/^(?:items |mini cart |cart )?subtotal ".*" isn't a readable price$/, "total.unreadable"],
  [/^items sum .+ but .+ says /, "total.mismatch"],
  [/^mini cart sums .+ but the cart subtotal says /, "total.mismatch"],
  [/^no items in the active cart$/, "cart.no_items"],
  [/^cart failed the shared Cart schema/, "cart.schema_invalid"],
  [/^no product title \(/, "product.no_title"],
  [/^no quantity dropdown in the buy box$/, "qty.no_dropdown"],
  [/^quantity .+ isn't a positive whole number$/, "qty.unreadable"],
  [/^no price found \(/, "price.no_layer_found"],
  [/^conflicting prices: /, "price.layers_conflict"],
  [/^no "Added to cart" confirmation on the page$/, "added.no_confirmation"],
  [/^the confirmation doesn't show which item was added$/, "added.no_item"],
  [/^(?:the added item|added item \d+) isn't in the mini cart$/, "added.item_not_in_minicart"],
  [/^the quantity added (?:for added item \d+ )?isn't in the URL\b/, "added.no_qty_in_url"],
  [/^URL says \d+ added but the cart holds \d+/, "added.qty_mismatch"],
  [/^the mini cart is empty or not loaded$/, "minicart.not_loaded"],
  [/^no Shopify cart API on this site$/, "shopify.no_cart_api"],
  [/^currency .+ isn't supported yet\b/, "shopify.currency_unsupported"],
  [/^\/cart\.js didn't answer in time$/, "shopify.timeout"],
  [/^\/cart\.js couldn't be fetched$/, "shopify.fetch_failed"],
];

// The sidebar is often just not open or not rendered yet on other pages.
const EXPECTED_FOR: Partial<Record<Reader, ReadFailureCode[]>> = {
  amazon_minicart: ["minicart.not_loaded"],
};

// The code for one problem: null when it's an expected page state rather
// than a failure, "unknown" when no pattern knows it (a mapping to add).
export function problemCode(problem: string): ReadFailureCode | null {
  if (EXPECTED.some((pattern) => pattern.test(problem))) return null;
  return PATTERNS.find(([pattern]) => pattern.test(problem))?.[1] ?? "unknown";
}

// A reading's failure codes for this reader, each once, in first-seen order.
export function failureCodes(reader: Reader, problems: readonly string[]): ReadFailureCode[] {
  const expected = new Set(EXPECTED_FOR[reader] ?? []);
  const codes = new Set<ReadFailureCode>();
  for (const problem of problems) {
    const code = problemCode(problem);
    if (code !== null && !expected.has(code)) codes.add(code);
  }
  return [...codes];
}
