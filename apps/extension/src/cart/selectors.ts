// Every CSS selector the Amazon readers use, keyed by a stable name. These are
// the shipped defaults, taken from real amazon.com pages (see __fixtures__).
// The backend can override any of them as data (StoreOverrides.selectors), so
// a page that changes its HTML can be fixed without a store release. Only
// selector strings live here: cross-checks, Amazon's type codes, and URL
// parsing stay in the readers.
export const AMAZON_SELECTORS = {
  // Cart page (/gp/cart/view.html)
  "cart.form": "#sc-active-cart form#activeCartViewForm",
  "cart.activeItems": '#sc-active-cart [data-name="Active Items"] [data-itemtype="active"][data-asin]',
  // An item just deleted or saved for later stays in the active list, marked.
  "cart.removedItem": '[data-removed="true"]',
  "cart.itemTitle": ".sc-product-title .a-truncate-full",
  "cart.subtotal": "#sc-subtotal-amount-buybox",

  // Checkout (/checkout/p/<purchase id>/<step>)
  "checkout.lineItems": "#checkout-item-block-panel .lineitem-container",
  "checkout.itemTitle": ".lineitem-title-text",
  "checkout.itemPrice": ".apex-price-to-pay-value .a-offscreen",
  "checkout.itemQuantity": 'fieldset[name="checkout-quantity-stepper"]',
  "checkout.summary": "#subtotals-marketplace-table",
  // Within the summary: the element carrying a row's type code (its value,
  // e.g. ITEMS_TAX_EXCLUSIVE, is matched in code), its row, and the amount.
  "checkout.summaryTypeCode": "input",
  "checkout.summaryRow": "li",
  "checkout.summaryAmount": ".order-summary-line-definition",
  "checkout.orderTotal": ".grand-total-cell .order-summary-line-definition, li:last-child .order-summary-line-definition",

  // Product page (/dp/<ASIN>)
  "product.page": "#dp",
  "product.title": "span#productTitle",
  "product.buyBoxAsin": "form#addToCart input#ASIN",
  "product.buyBoxPrice": "form#addToCart #corePrice_feature_div .apex-pricetopay-value .a-offscreen",
  "product.pagePrice": "#corePriceDisplay_desktop_feature_div .priceToPay",
  "product.priceWhole": ".a-price-whole",
  "product.priceFraction": ".a-price-fraction",
  "product.quantity": "form#addToCart select#quantity",

  // Added-to-cart page (/cart/smart-wagon)
  "addedToCart.confirmation": "#sw-atc-confirmation",
  "addedToCart.success": "#NATC_SMART_WAGON_CONF_MSG_SUCCESS",
  "addedToCart.addedItems": "#add-to-cart-confirmation-image [data-itemid]",
  "addedToCart.cartSubtotal": "#sw-subtotal .a-offscreen",
  "addedToCart.cartQuantity": "input#sw-total-quantity",

  // Nav mini cart (#nav-flyout-ewc), on most pages
  "minicart.lines": '#nav-flyout-ewc .ewc-item[data-itemtype="active"][data-asin]',
  // A removed / saved-for-later line keeps its old data; only its message shows.
  "minicart.goneMessages": ".ewc-item-remove-msg, .ewc-item-moved-to-sfl-msg",
  "minicart.hiddenMessage": ".aok-hidden",
  "minicart.subtotal": "#nav-flyout-ewc .ewc-subtotal-amount",
} as const;

export type AmazonSelectorKey = keyof typeof AMAZON_SELECTORS;
export type AmazonSelectors = Readonly<Record<AmazonSelectorKey, string>>;
// Backend overrides: readerKey -> selector. Unknown keys are ignored.
export type SelectorOverrides = Readonly<Record<string, string>>;

export interface ResolvedSelectors {
  selectors: AmazonSelectors;
  // Plain-English notes about overrides that were ignored, for the debug panel.
  notes: string[];
}

const KEYS = new Set<string>(Object.keys(AMAZON_SELECTORS));

// Merge overrides over the defaults. A bad config never breaks reading: an
// unknown key is ignored, and an override that isn't a valid CSS selector
// falls back to the default for that key.
export function resolveAmazonSelectors(doc: Document, overrides?: SelectorOverrides): ResolvedSelectors {
  if (!overrides) return { selectors: AMAZON_SELECTORS, notes: [] };

  const selectors: Record<string, string> = { ...AMAZON_SELECTORS };
  const notes: string[] = [];
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(overrides)) {
    if (!KEYS.has(key)) {
      unknown.push(key);
    } else if (isValidSelector(doc, value)) {
      selectors[key] = value;
    } else {
      notes.push(`ignored invalid selector override for ${key}`);
    }
  }
  if (unknown.length > 0) notes.push(`ignored unknown selector keys: ${unknown.join(", ")}`);
  return { selectors: selectors as AmazonSelectors, notes };
}

function isValidSelector(doc: Document, selector: unknown): boolean {
  if (typeof selector !== "string" || selector.trim() === "") return false;
  try {
    doc.createDocumentFragment().querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

// Attach override notes to a reading's details without touching its problems:
// an ignored override doesn't make an otherwise good reading unreliable.
export function withConfigNotes<T extends { details?: Record<string, string> }>(result: T, notes: string[]): T {
  if (notes.length === 0) return result;
  return { ...result, details: { ...result.details, config: notes.join("; ") } };
}
