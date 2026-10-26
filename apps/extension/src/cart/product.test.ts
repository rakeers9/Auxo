import { CartSchema } from "@auxo/shared";
import { describe, expect, it } from "vitest";

import { hashCart } from "./hash";
import { extractAmazonProduct, isAmazonProductPage, readAmazonProduct } from "./product";
// Sanitized copies of real amazon.com pages (product names and IDs replaced).
import productHtml from "./__fixtures__/amazon-product.html?raw";
import accordionHtml from "./__fixtures__/amazon-product-accordion.html?raw";
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
      ["no price can be found anywhere", (d) => { d.querySelectorAll(".apex-pricetopay-value").forEach((e) => e.remove()); d.getElementById("corePriceDisplay_desktop_feature_div")?.remove(); }],
      ["the buy box price disagrees with the page price", (d) => { d.querySelector("form#addToCart #corePrice_feature_div .apex-pricetopay-value .a-offscreen")!.textContent = "$44.98"; }],
      ["the quantity dropdown is missing", (d) => quantity(d).remove()],
      ["the title is missing", (d) => { d.querySelector("span#productTitle")!.textContent = " "; }],
    ])("when %s", (_label, change) => {
      expect(extractAmazonProduct(productWith(change), PRODUCT_URL)).toBeNull();
    });
  });

  it("still reads the price when the exact buy box selector finds nothing (digit spans)", () => {
    const doc = productWith((d) => d.querySelector("form#addToCart #corePrice_feature_div .apex-pricetopay-value .a-offscreen")!.remove());
    const reading = readAmazonProduct(doc, PRODUCT_URL);
    expect(reading.draft?.total_minor).toBe(4598);
    expect(reading.details.price).toBe("$45.98 via near form + page price");
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

// Real page where the price to pay sits in the accordion row's header, outside
// form#addToCart, so the exact buy box selector finds nothing. The page also
// offers a used copy at $13.99 and shows a struck-through $21.99 list price.
describe("accordion buy box (price beside the form, not inside it)", () => {
  const URL_ACCORDION = new URL("https://www.amazon.com/Cat-Water-Fountain/dp/B0TEST0006/ref=sr_1_6?keywords=cat");

  it("the exact buy box selector alone finds nothing here", () => {
    const doc = parse(accordionHtml);
    expect(doc.querySelector("form#addToCart #corePrice_feature_div .apex-pricetopay-value .a-offscreen")).toBeNull();
  });

  it("reads the new price, not the used offer or the list price", () => {
    const reading = readAmazonProduct(parse(accordionHtml), URL_ACCORDION);
    expect(reading.problems).toEqual([]);
    expect(reading.draft).toEqual({
      merchant: "amazon.com",
      items: [{ name: "Cat water fountain", price_minor: 1999, qty: 1 }],
      total_minor: 1999,
      currency: "USD",
      url: "https://www.amazon.com/dp/B0TEST0006",
    });
  });

  it("says which layers found the price", () => {
    expect(readAmazonProduct(parse(accordionHtml), URL_ACCORDION).details.price).toBe("$19.99 via near form + page price");
  });

  it("reads the price from the digit spans when the offscreen copy is blank", () => {
    const doc = parse(accordionHtml);
    doc.querySelectorAll("#corePrice_feature_div .a-offscreen").forEach((e) => { e.textContent = " "; });
    const reading = readAmazonProduct(doc, URL_ACCORDION);
    expect(reading.draft?.total_minor).toBe(1999);
  });

  it("flags a conflict instead of choosing when the layers disagree", () => {
    const doc = parse(accordionHtml);
    // The header says $14.99 while the price under the title says $19.99.
    doc.querySelector("#newAccordionRow_0 .apex-pricetopay-value .a-offscreen")!.textContent = "$14.99";
    doc.querySelector("#newAccordionRow_0 .apex-pricetopay-value .a-price-whole")!.firstChild!.textContent = "14";
    const reading = readAmazonProduct(doc, URL_ACCORDION);
    expect(reading.draft).toBeNull();
    expect(reading.problems).toEqual(["conflicting prices: near form $14.99, page price $19.99"]);
    expect(reading.details.price).toBe("(conflict)");
  });

  it("explains why when no layer can read a price", () => {
    const doc = parse(accordionHtml);
    doc.querySelectorAll(".apex-pricetopay-value").forEach((e) => e.remove());
    doc.getElementById("corePriceDisplay_desktop_feature_div")?.remove();
    const reading = readAmazonProduct(doc, URL_ACCORDION);
    expect(reading.draft).toBeNull();
    expect(reading.problems).toEqual([
      "no price found (buy box: selector matched nothing; near form: no price to pay around the form; page price: not shown)",
    ]);
  });

  it("two different prices to pay beside one form are a conflict, not a pick", () => {
    const doc = parse(accordionHtml);
    // A second price to pay in the same row (e.g. a bundle) with another number.
    const row = doc.querySelector("#newAccordionRow_0 .apex-pricetopay-value")!;
    const other = row.cloneNode(true) as Element;
    other.querySelector(".a-offscreen")!.textContent = "$24.99";
    row.after(other);
    expect(readAmazonProduct(doc, URL_ACCORDION).problems[0]).toContain("conflicting prices: near form $19.99 / $24.99");
  });
});
