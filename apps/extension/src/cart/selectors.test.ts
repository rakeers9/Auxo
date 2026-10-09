import { describe, expect, it } from "vitest";

import { readAmazonCart } from "./amazon";
import { readAmazonCheckout } from "./checkout";
import { inspectAmazonPage } from "./inspect";
import { readAmazonMiniCart } from "./minicart";
import { readAmazonProduct } from "./product";
import { AMAZON_SELECTORS, resolveAmazonSelectors } from "./selectors";
// Sanitized copies of real amazon.com pages.
import cartHtml from "./__fixtures__/amazon-cart.html?raw";
import checkoutHtml from "./__fixtures__/amazon-checkout-from-cart.html?raw";
import minicartHtml from "./__fixtures__/amazon-product-minicart.html?raw";
import productHtml from "./__fixtures__/amazon-product.html?raw";
// Reader sources, to check that every selector they use comes from AMAZON_SELECTORS.
import addedSrc from "./added.ts?raw";
import amazonSrc from "./amazon.ts?raw";
import checkoutSrc from "./checkout.ts?raw";
import inspectSrc from "./inspect.ts?raw";
import minicartSrc from "./minicart.ts?raw";
import productSrc from "./product.ts?raw";

const CART_URL = new URL("https://www.amazon.com/gp/cart/view.html");
const CHECKOUT_URL = new URL("https://www.amazon.com/checkout/p/p-000-0000000-0000000/spc");
const PRODUCT_URL = new URL("https://www.amazon.com/dp/B0TEST0005");

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("selector overrides change what is read", () => {
  it("cart: a renamed subtotal id is read through cart.subtotal", () => {
    const doc = parse(cartHtml);
    doc.getElementById("sc-subtotal-amount-buybox")!.id = "sc-subtotal-v2";

    expect(readAmazonCart(doc, CART_URL).problems).toEqual(["no subtotal (#sc-subtotal-amount-buybox) on the page"]);
    const reading = readAmazonCart(doc, CART_URL, { "cart.subtotal": "#sc-subtotal-v2" });
    expect(reading.problems).toEqual([]);
    expect(reading.draft?.total_minor).toBe(12684);
    expect(reading.details.config).toBeUndefined();
  });

  it("checkout: renamed line items are read through checkout.lineItems", () => {
    const doc = parse(checkoutHtml);
    for (const el of doc.querySelectorAll(".lineitem-container")) el.classList.replace("lineitem-container", "line-item-v2");

    expect(readAmazonCheckout(doc, CHECKOUT_URL).draft).toBeNull();
    const draft = readAmazonCheckout(doc, CHECKOUT_URL, { "checkout.lineItems": "#checkout-item-block-panel .line-item-v2" }).draft;
    expect(draft?.items).toHaveLength(2);
    expect(draft?.total_minor).toBe(6996);
  });

  it("product: a moved buy box price is read through product.buyBoxPrice", () => {
    const doc = parse(productHtml);
    const price = doc.querySelector("form#addToCart #corePrice_feature_div .apex-pricetopay-value .a-offscreen")!;
    price.classList.replace("a-offscreen", "price-v2");

    expect(readAmazonProduct(doc, PRODUCT_URL).problems).toEqual(["no price in the buy box"]);
    const override = { "product.buyBoxPrice": "form#addToCart #corePrice_feature_div .price-v2" };
    expect(readAmazonProduct(doc, PRODUCT_URL, override).draft?.total_minor).toBe(4598);
  });

  it("mini cart: a renamed hidden class is honoured through minicart.hiddenMessage", () => {
    const doc = parse(minicartHtml);
    for (const el of doc.querySelectorAll(".aok-hidden")) el.classList.replace("aok-hidden", "is-hidden");

    // With the default, every message now looks visible, so every line is skipped.
    expect(readAmazonMiniCart(doc, PRODUCT_URL).problems).toEqual(["the mini cart is empty or not loaded"]);
    expect(readAmazonMiniCart(doc, PRODUCT_URL, { "minicart.hiddenMessage": ".is-hidden" }).draft?.total_minor).toBe(6996);
  });
});

describe("a bad config never breaks reading", () => {
  it.each(["div[", "#", ">>>", "", "   "])("ignores the invalid selector %j and uses the default, with a note", (bad) => {
    const reading = readAmazonCart(parse(cartHtml), CART_URL, { "cart.subtotal": bad });
    expect(reading.problems).toEqual([]);
    expect(reading.draft?.total_minor).toBe(12684);
    expect(reading.details.config).toBe("ignored invalid selector override for cart.subtotal");
  });

  it("ignores unknown keys, and notes them", () => {
    const reading = readAmazonCart(parse(cartHtml), CART_URL, { "cart.nope": "#x", "walmart.cart": ".y" });
    expect(reading.draft?.total_minor).toBe(12684);
    expect(reading.details.config).toBe("ignored unknown selector keys: cart.nope, walmart.cart");
  });

  it("keeps the good overrides when others are bad", () => {
    const doc = parse(cartHtml);
    doc.getElementById("sc-subtotal-amount-buybox")!.id = "sc-subtotal-v2";
    const reading = readAmazonCart(doc, CART_URL, { "cart.subtotal": "#sc-subtotal-v2", "cart.itemTitle": "div[" });
    expect(reading.draft?.total_minor).toBe(12684);
    expect(reading.details.config).toBe("ignored invalid selector override for cart.itemTitle");
  });

  it("inspectAmazonPage passes overrides through and reports notes on every page type", () => {
    const doc = parse(cartHtml);
    doc.getElementById("sc-subtotal-amount-buybox")!.id = "sc-subtotal-v2";
    const inspection = inspectAmazonPage(doc, CART_URL, { "cart.subtotal": "#sc-subtotal-v2", bogus: "a" });
    expect(inspection.pageType).toBe("cart");
    expect(inspection.draft?.total_minor).toBe(12684);
    expect(inspection.details?.config).toBe("ignored unknown selector keys: bogus");

    // A search URL with product HTML: neither cart (no cart form) nor product (no /dp/).
    const other = inspectAmazonPage(parse(productHtml), new URL("https://www.amazon.com/s?k=x"), { bogus: "a" });
    expect(other.pageType).toBe("other");
    expect(other.details).toEqual({ config: "ignored unknown selector keys: bogus" });
  });

  it("without overrides, the defaults are used and nothing is noted", () => {
    const resolved = resolveAmazonSelectors(parse(cartHtml));
    expect(resolved.selectors).toBe(AMAZON_SELECTORS);
    expect(resolved.notes).toEqual([]);
    expect(readAmazonCart(parse(cartHtml), CART_URL).details.config).toBeUndefined();
  });
});

describe("AMAZON_SELECTORS covers every selector the readers use", () => {
  const sources = { added: addedSrc, amazon: amazonSrc, checkout: checkoutSrc, inspect: inspectSrc, minicart: minicartSrc, product: productSrc };

  it.each(Object.entries(sources))("%s.ts has no hardcoded selector in a DOM query", (_name, src) => {
    // Any querySelector / querySelectorAll / closest / matches called with a literal.
    const literalQuery = /\.(?:querySelector|querySelectorAll|closest|matches)(?:<[^>]+>)?\(\s*["'`]/g;
    expect(src.match(literalQuery)).toBeNull();
  });

  it("every key is used by some reader", () => {
    const all = Object.values(sources).join("\n");
    const unused = Object.keys(AMAZON_SELECTORS).filter((key) => !all.includes(`s["${key}"]`));
    expect(unused).toEqual([]);
  });

  it("every default is a valid selector", () => {
    const fragment = parse("").createDocumentFragment();
    for (const selector of Object.values(AMAZON_SELECTORS)) expect(() => fragment.querySelector(selector)).not.toThrow();
  });
});
