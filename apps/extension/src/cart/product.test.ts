import { CartSchema } from "@auxo/shared";
import { describe, expect, it } from "vitest";

import { hashCart } from "./hash";
import { extractAmazonProduct, isAmazonProductPage } from "./product";
// Sanitized copies of real amazon.com pages (product names and IDs replaced).
import productHtml from "./__fixtures__/amazon-product.html?raw";
import cartHtml from "./__fixtures__/amazon-cart.html?raw";
import emptyCartHtml from "./__fixtures__/amazon-cart-empty.html?raw";
import checkoutHtml from "./__fixtures__/amazon-checkout-from-cart.html?raw";

// Real product URL shape (slug, /dp/<ASIN>, tracking query), with fake values.
const PRODUCT_URL = new URL("https://www.amazon.com/Side-Table-Charging-Station/dp/B0TEST0005?ref=dlx_deals_dg&pf_rd_r=XYZ&th=1");
const CART_URL = new URL("https://www.amazon.com/gp/cart/view.html");
const CHECKOUT_URL = new URL("https://www.amazon.com/checkout/p/p-000-0000000-0000000/spc");

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function productWith(change: (doc: Document) => void): Document {
  const doc = parse(productHtml);
  change(doc);
  return doc;
}

const quantity = (doc: Document) => doc.querySelector<HTMLSelectElement>("form#addToCart select#quantity")!;

describe("isAmazonProductPage", () => {
  it("is true on a product page, with or without the slug", () => {
    expect(isAmazonProductPage(PRODUCT_URL, parse(productHtml))).toBe(true);
    expect(isAmazonProductPage(new URL("https://www.amazon.com/dp/B0TEST0005"), parse(productHtml))).toBe(true);
    expect(isAmazonProductPage(new URL("https://www.amazon.com/gp/product/B0TEST0005/ref=x"), parse(productHtml))).toBe(true);
  });

  it("is false on the cart, empty cart, and checkout pages", () => {
    expect(isAmazonProductPage(CART_URL, parse(cartHtml))).toBe(false);
    expect(isAmazonProductPage(CART_URL, parse(emptyCartHtml))).toBe(false);
    expect(isAmazonProductPage(CHECKOUT_URL, parse(checkoutHtml))).toBe(false);
  });

  it("is false without a product URL, off www.amazon.com, or without the product page", () => {
    expect(isAmazonProductPage(new URL("https://www.amazon.com/s?k=lamp"), parse(productHtml))).toBe(false);
    expect(isAmazonProductPage(new URL("https://www.amazon.co.uk/dp/B0TEST0005"), parse(productHtml))).toBe(false);
    expect(isAmazonProductPage(PRODUCT_URL, parse(cartHtml))).toBe(false);
  });
});

describe("extractAmazonProduct", () => {
  it("reads the product as a one-item cart at the price paid, not the list price", () => {
    expect(extractAmazonProduct(parse(productHtml), PRODUCT_URL)).toEqual({
      merchant: "amazon.com",
      // $45.98 is the price to pay; the struck-through List Price is $55.99.
      items: [{ name: "Side table with charging station", price_minor: 4598, qty: 1 }],
      total_minor: 4598,
      currency: "USD",
      // Slug, ref, and tracking query dropped.
      url: "https://www.amazon.com/dp/B0TEST0005",
    });
  });

  it("uses the selected quantity, and totals price × qty", () => {
    const doc = productWith((d) => { quantity(d).value = "3"; });
    const draft = extractAmazonProduct(doc, PRODUCT_URL);
    expect(draft?.items).toEqual([{ name: "Side table with charging station", price_minor: 4598, qty: 3 }]);
    expect(draft?.total_minor).toBe(13794);
  });

  it("names the buy box's ASIN (the selected variant) in the URL", () => {
    const parentUrl = new URL("https://www.amazon.com/dp/B0PARENT01");
    expect(extractAmazonProduct(parse(productHtml), parentUrl)?.url).toBe("https://www.amazon.com/dp/B0TEST0005");
  });

  it("ignores cart items listed in the nav flyout", () => {
    const doc = parse(productHtml);
    expect(doc.querySelectorAll('#nav-flyout-ewc [data-itemtype="active"]').length).toBe(4);
    expect(extractAmazonProduct(doc, PRODUCT_URL)?.items).toHaveLength(1);
  });

  it("returns null off product pages", () => {
    expect(extractAmazonProduct(parse(cartHtml), CART_URL)).toBeNull();
    expect(extractAmazonProduct(parse(checkoutHtml), CHECKOUT_URL)).toBeNull();
  });

  describe("returns null instead of guessing", () => {
    it.each<[string, (d: Document) => void]>([
      ["the buy box price is missing", (d) => d.querySelector("form#addToCart #corePrice_feature_div .apex-pricetopay-value .a-offscreen")!.remove()],
      ["the buy box price disagrees with the page price", (d) => { d.querySelector("form#addToCart #corePrice_feature_div .apex-pricetopay-value .a-offscreen")!.textContent = "$44.98"; }],
      ["the quantity dropdown is missing", (d) => quantity(d).remove()],
      ["the title is missing", (d) => { d.querySelector("span#productTitle")!.textContent = " "; }],
    ])("when %s", (_label, change) => {
      expect(extractAmazonProduct(productWith(change), PRODUCT_URL)).toBeNull();
    });
  });

  it("still reads the buy box price when the page doesn't repeat it", () => {
    const doc = productWith((d) => d.getElementById("corePriceDisplay_desktop_feature_div")!.remove());
    expect(extractAmazonProduct(doc, PRODUCT_URL)?.total_minor).toBe(4598);
  });

  it("the extracted product plus its hash is a valid Cart", async () => {
    const draft = extractAmazonProduct(parse(productHtml), PRODUCT_URL);
    expect(draft).not.toBeNull();
    expect(CartSchema.safeParse({ ...draft!, cart_hash: await hashCart(draft!) }).success).toBe(true);
  });
});
