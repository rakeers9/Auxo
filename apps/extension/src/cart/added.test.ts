import { CartSchema } from "@auxo/shared";
import { describe, expect, it } from "vitest";

import { extractAmazonAddedToCart, isAmazonAddedToCartPage } from "./added";
import { isAmazonCartPage } from "./amazon";
import { isAmazonCheckoutPage } from "./checkout";
import { hashCart } from "./hash";
import { inspectAmazonPage } from "./inspect";
import { isAmazonProductPage } from "./product";
// Sanitized copies of real amazon.com pages (product names and IDs replaced).
import addedHtml from "./__fixtures__/amazon-added-to-cart.html?raw";
import cartHtml from "./__fixtures__/amazon-cart.html?raw";
import productHtml from "./__fixtures__/amazon-product.html?raw";

// The fake id of the added item in the fixture, in the real URL shape.
const ADDED_ID = "00000000-0000-4000-8000-000000000005";
const ADDED_URL = new URL(`https://www.amazon.com/cart/smart-wagon?newItems=${ADDED_ID},1&ref_=sw_refresh`);

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function addedWith(change: (doc: Document) => void): Document {
  const doc = parse(addedHtml);
  change(doc);
  return doc;
}

const addedLine = (d: Document) => d.querySelector(`#nav-flyout-ewc [data-itemid="${ADDED_ID}"]`)!;
const subtotal = (d: Document) => d.querySelector("#sw-subtotal .a-offscreen")!;

describe("isAmazonAddedToCartPage", () => {
  it("is true on /cart/smart-wagon with the confirmation block", () => {
    expect(isAmazonAddedToCartPage(ADDED_URL, parse(addedHtml))).toBe(true);
    expect(isAmazonAddedToCartPage(new URL("https://www.amazon.com/cart/smart-wagon/"), parse(addedHtml))).toBe(true);
  });

  it("is false on other pages or without the confirmation block", () => {
    expect(isAmazonAddedToCartPage(new URL("https://www.amazon.com/gp/cart/view.html"), parse(cartHtml))).toBe(false);
    expect(isAmazonAddedToCartPage(ADDED_URL, parse(cartHtml))).toBe(false);
    expect(isAmazonAddedToCartPage(new URL("https://www.amazon.co.uk/cart/smart-wagon"), parse(addedHtml))).toBe(false);
  });

  it("isn't mistaken for the cart, checkout, or product page", () => {
    const doc = parse(addedHtml);
    expect(isAmazonCartPage(ADDED_URL, doc)).toBe(false);
    expect(isAmazonCheckoutPage(ADDED_URL, doc)).toBe(false);
    expect(isAmazonProductPage(ADDED_URL, doc)).toBe(false);
    expect(isAmazonAddedToCartPage(new URL("https://www.amazon.com/dp/B0TEST0005"), parse(productHtml))).toBe(false);
  });
});

describe("extractAmazonAddedToCart", () => {
  it("reads the added item from the mini cart, at the quantity added", () => {
    expect(extractAmazonAddedToCart(parse(addedHtml), ADDED_URL)).toEqual({
      merchant: "amazon.com",
      items: [{ name: "Stainless steel water bottle, 32 oz", price_minor: 2639, qty: 1 }],
      total_minor: 2639,
      currency: "USD",
      url: "https://www.amazon.com/cart/smart-wagon",
    });
  });

  it("uses the quantity just added, not the cart line's total", () => {
    // The cart already held 2 more of this item: the line shows 3, the URL says 1 added.
    const doc = addedWith((d) => {
      addedLine(d).setAttribute("data-quantity", "3");
      subtotal(d).textContent = "$270.72";
    });
    expect(extractAmazonAddedToCart(doc, ADDED_URL)?.items).toEqual([
      { name: "Stainless steel water bottle, 32 oz", price_minor: 2639, qty: 1 },
    ]);
  });

  it("the extracted item plus its hash is a valid Cart", async () => {
    const draft = extractAmazonAddedToCart(parse(addedHtml), ADDED_URL);
    expect(draft).not.toBeNull();
    expect(CartSchema.safeParse({ ...draft!, cart_hash: await hashCart(draft!) }).success).toBe(true);
  });
});

describe("inspectAmazonPage on the added-to-cart page", () => {
  it("reports the same draft, plus the success message, cart subtotal, and item count", () => {
    const doc = parse(addedHtml);
    const inspection = inspectAmazonPage(doc, ADDED_URL);
    expect(inspection.pageType).toBe("added_to_cart");
    expect(inspection.problems).toEqual([]);
    expect(inspection.draft).toEqual(extractAmazonAddedToCart(doc, ADDED_URL));
    expect(inspection.details).toEqual({
      added: "yes",
      "cart subtotal": '"$217.94"',
      "cart items": "6",
      "mini cart sum": "$217.94",
      "added qty": "1",
      "items sum": "$26.39",
    });
  });

  it.each<[string, (d: Document) => void, URL, string[]]>([
    ["no success message", (d) => d.getElementById("NATC_SMART_WAGON_CONF_MSG_SUCCESS")!.remove(), ADDED_URL, ['no "Added to cart" confirmation on the page']],
    ["no added item in the confirmation", (d) => d.querySelector("#add-to-cart-confirmation-image [data-itemid]")!.remove(), ADDED_URL, ["the confirmation doesn't show which item was added"]],
    ["no quantity in the URL", () => {}, new URL("https://www.amazon.com/cart/smart-wagon?ref_=sw_refresh"), ["the quantity added isn't in the URL (newItems)"]],
    ["a URL quantity for another item", () => {}, new URL("https://www.amazon.com/cart/smart-wagon?newItems=00000000-0000-4000-8000-000000000006,1"), ["the quantity added isn't in the URL (newItems)"]],
    ["more added than the cart holds", () => {}, new URL(`https://www.amazon.com/cart/smart-wagon?newItems=${ADDED_ID},2`), ["URL says 2 added but the cart holds 1"]],
    ["a mini cart that doesn't add up", (d) => addedLine(d).setAttribute("data-price", "27.39"), ADDED_URL, ["mini cart sums $218.94 but the cart subtotal says $217.94"]],
    ["a missing cart subtotal", (d) => subtotal(d).remove(), ADDED_URL, ["no cart subtotal (#sw-subtotal .a-offscreen) on the page"]],
    [
      "an empty mini cart",
      (d) => { for (const el of d.querySelectorAll("#nav-flyout-ewc [data-itemtype]")) el.remove(); },
      ADDED_URL,
      ["the mini cart is empty or not loaded"],
    ],
    [
      "the added item missing from the mini cart",
      (d) => {
        addedLine(d).remove();
        subtotal(d).textContent = "$191.55";
      },
      ADDED_URL,
      ["the added item isn't in the mini cart"],
    ],
  ])("explains %s", (_label, change, url, problems) => {
    const doc = addedWith(change);
    const inspection = inspectAmazonPage(doc, url);
    expect(inspection.pageType).toBe("added_to_cart");
    expect(inspection.draft).toBeNull();
    expect(inspection.problems).toEqual(problems);
    expect(extractAmazonAddedToCart(doc, url)).toBeNull();
  });

  it("says added: no when the success message is missing", () => {
    const doc = addedWith((d) => d.getElementById("NATC_SMART_WAGON_CONF_MSG_SUCCESS")!.remove());
    expect(inspectAmazonPage(doc, ADDED_URL).details?.added).toBe("no");
  });
});
