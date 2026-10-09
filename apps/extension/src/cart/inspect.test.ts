import { describe, expect, it } from "vitest";

import { extractAmazonCart } from "./amazon";
import { extractAmazonCheckout } from "./checkout";
import { inspectAmazonPage } from "./inspect";
import { extractAmazonProduct } from "./product";
import buyNowCheckoutHtml from "./__fixtures__/amazon-checkout-buy-now.html?raw";
import fromCartCheckoutHtml from "./__fixtures__/amazon-checkout-from-cart.html?raw";
// Sanitized copies of real amazon.com pages (product names and IDs replaced).
import cartHtml from "./__fixtures__/amazon-cart.html?raw";
import emptyCartHtml from "./__fixtures__/amazon-cart-empty.html?raw";
import productHtml from "./__fixtures__/amazon-product.html?raw";
import savedItemCartHtml from "./__fixtures__/amazon-cart-saved-item.html?raw";

const CART_URL = new URL("https://www.amazon.com/gp/cart/view.html");
const PRODUCT_URL = new URL("https://www.amazon.com/dp/B0TEST0005");

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function cartWith(change: (doc: Document) => void): Document {
  const doc = parse(cartHtml);
  change(doc);
  return doc;
}

const firstItem = (doc: Document) => doc.querySelector('#sc-active-cart [data-asin="B0TEST0001"]')!;

describe("inspectAmazonPage on cart pages", () => {
  it("reports the same draft extractAmazonCart returns, with no problems", () => {
    for (const html of [cartHtml, savedItemCartHtml]) {
      const doc = parse(html);
      const inspection = inspectAmazonPage(doc, CART_URL);
      expect(inspection.pageType).toBe("cart");
      expect(inspection.problems).toEqual([]);
      expect(inspection.draft).not.toBeNull();
      expect(inspection.draft).toEqual(extractAmazonCart(doc, CART_URL));
    }
  });

  it("shows raw readings", () => {
    expect(inspectAmazonPage(parse(cartHtml), CART_URL).details).toEqual({
      "items seen": "4",
      removed: "0",
      subtotal: '"$126.84"',
      "items sum": "$126.84",
    });
  });

  it("reports a verifiably empty cart as an empty draft with no problems", () => {
    const inspection = inspectAmazonPage(parse(emptyCartHtml), CART_URL);
    expect(inspection.pageType).toBe("cart");
    expect(inspection.problems).toEqual([]);
    expect(inspection.draft?.items).toEqual([]);
    expect(inspection.draft?.total_minor).toBe(0);
    expect(inspection.details).toEqual({ "items seen": "1", removed: "1", subtotal: "(missing)", "nav cart count": '"0"', empty: "yes" });
  });

  it("counts items skipped because they were just saved for later", () => {
    expect(inspectAmazonPage(parse(savedItemCartHtml), CART_URL).details?.removed).toBe("1");
  });

  // One case per reason the cart reader gives up. Each must also make
  // extractAmazonCart return null, since both share one code path.
  it.each<[string, () => Document, string]>([
    [
      "an empty-looking cart the nav bar doesn't confirm",
      () => {
        const doc = parse(emptyCartHtml);
        doc.getElementById("nav-cart-count")!.textContent = "6";
        return doc;
      },
      "no items in the active cart",
    ],
    ["a missing price", () => cartWith((d) => firstItem(d).removeAttribute("data-price")), 'item 1 has no readable data-price: (missing)'],
    ["an unreadable price", () => cartWith((d) => firstItem(d).setAttribute("data-price", "see price in cart")), 'item 1 has no readable data-price: "see price in cart"'],
    ["a bad quantity", () => cartWith((d) => firstItem(d).setAttribute("data-quantity", "1.5")), 'item 1 has no positive whole data-quantity: "1.5"'],
    [
      "a missing name",
      () =>
        cartWith((d) => {
          firstItem(d).removeAttribute("data-producttitle");
          firstItem(d).querySelector(".sc-product-title .a-truncate-full")!.textContent = "";
        }),
      "item 1 has no name (no data-producttitle or visible title)",
    ],
    ["a missing subtotal", () => cartWith((d) => d.getElementById("sc-subtotal-amount-buybox")!.remove()), "no subtotal (#sc-subtotal-amount-buybox) on the page"],
    ["an unreadable subtotal", () => cartWith((d) => { d.getElementById("sc-subtotal-amount-buybox")!.textContent = "pending"; }), 'subtotal "pending" isn\'t a readable price'],
    ["items that don't add up", () => cartWith((d) => firstItem(d).setAttribute("data-price", "10.99")), "items sum $129.84 but Amazon's total says $126.84"],
  ])("explains %s", (_label, makeDoc, problem) => {
    const doc = makeDoc();
    const inspection = inspectAmazonPage(doc, CART_URL);
    expect(inspection.pageType).toBe("cart");
    expect(inspection.draft).toBeNull();
    expect(inspection.problems).toEqual([problem]);
    expect(extractAmazonCart(doc, CART_URL)).toBeNull();
  });

  it("lists every broken item, not just the first", () => {
    const doc = cartWith((d) => {
      for (const el of d.querySelectorAll("#sc-active-cart [data-itemtype='active']")) el.removeAttribute("data-quantity");
    });
    expect(inspectAmazonPage(doc, CART_URL).problems).toHaveLength(4);
  });
});

describe("inspectAmazonPage on checkout pages", () => {
  const checkoutUrl = (step: string) => new URL(`https://www.amazon.com/checkout/p/p-000-0000000-0000000/${step}`);
  const SPC = checkoutUrl("spc");

  function checkoutWith(change: (doc: Document) => void): Document {
    const doc = parse(fromCartCheckoutHtml);
    change(doc);
    return doc;
  }
  const firstLine = (doc: Document) => doc.querySelector(".lineitem-container")!;

  it("reports the same draft extractAmazonCheckout returns, for both checkout paths", () => {
    for (const html of [fromCartCheckoutHtml, buyNowCheckoutHtml]) {
      const doc = parse(html);
      const inspection = inspectAmazonPage(doc, SPC);
      expect(inspection.pageType).toBe("checkout");
      expect(inspection.problems).toEqual([]);
      expect(inspection.draft).not.toBeNull();
      expect(inspection.draft).toEqual(extractAmazonCheckout(doc, SPC));
    }
  });

  it("shows raw readings, without the purchase id", () => {
    const inspection = inspectAmazonPage(parse(fromCartCheckoutHtml), SPC);
    expect(inspection.details).toEqual({
      step: "spc",
      "items seen": "2",
      "items subtotal": '"$69.96"',
      "order total": '"$74.86"',
      "items sum": "$69.96",
    });
    expect(JSON.stringify(inspection)).not.toContain("0000000");
  });

  it("still says checkout on a step without items", () => {
    expect(inspectAmazonPage(parse(productHtml), checkoutUrl("address"))).toEqual({
      pageType: "checkout",
      draft: null,
      problems: ["checkout address step: items not shown on this step"],
      details: { step: "address", "items seen": "0" },
    });
  });

  it.each<[string, (doc: Document) => void, string]>([
    ["a missing price", (d) => firstLine(d).querySelector(".apex-price-to-pay-value .a-offscreen")!.remove(), "item 1 has no readable price: (missing)"],
    ["a missing quantity", (d) => firstLine(d).querySelector('fieldset[name="checkout-quantity-stepper"]')!.remove(), "item 1 has no readable quantity: (missing)"],
    ["a missing name", (d) => { firstLine(d).querySelector(".lineitem-title-text")!.textContent = ""; }, "item 1 has no name"],
    ["a missing items subtotal", (d) => d.querySelector('input[value="ITEMS_TAX_EXCLUSIVE"]')!.closest("li")!.remove(), "no items subtotal (ITEMS_TAX_EXCLUSIVE) in the order summary"],
    [
      "an unreadable items subtotal",
      // The type code input sits inside the amount cell, so only the amount text changes.
      (d) => { d.querySelector('input[value="ITEMS_TAX_EXCLUSIVE"]')!.closest("li")!.querySelector(".order-summary-line-definition .a-nowrap")!.textContent = "--"; },
      'items subtotal "--" isn\'t a readable price',
    ],
    [
      "items that don't add up",
      (d) => firstLine(d).querySelector('fieldset[name="checkout-quantity-stepper"]')!.setAttribute("data-steppervalue", "2"),
      "items sum $59.97 but Amazon's total says $69.96",
    ],
  ])("explains %s", (_label, change, problem) => {
    const doc = checkoutWith(change);
    const inspection = inspectAmazonPage(doc, SPC);
    expect(inspection.pageType).toBe("checkout");
    expect(inspection.draft).toBeNull();
    expect(inspection.problems).toEqual([problem]);
    expect(extractAmazonCheckout(doc, SPC)).toBeNull();
  });
});

describe("inspectAmazonPage on product pages", () => {
  function productWith(change: (doc: Document) => void): Document {
    const doc = parse(productHtml);
    change(doc);
    return doc;
  }
  const buyBoxPrice = (d: Document) => d.querySelector("form#addToCart #corePrice_feature_div .apex-pricetopay-value .a-offscreen")!;
  const quantity = (d: Document) => d.querySelector<HTMLSelectElement>("form#addToCart select#quantity")!;

  it("reports the same draft extractAmazonProduct returns, with raw readings", () => {
    const doc = parse(productHtml);
    const inspection = inspectAmazonPage(doc, PRODUCT_URL);
    expect(inspection.pageType).toBe("product");
    expect(inspection.problems).toEqual([]);
    expect(inspection.draft).toEqual(extractAmazonProduct(doc, PRODUCT_URL));
    expect(inspection.details).toEqual({
      asin: "B0TEST0005",
      "buy box price": '"$45.98"',
      "page price": "$45.98",
      qty: '"1"',
      "items sum": "$45.98",
    });
  });

  it.each<[string, (d: Document) => void, string]>([
    ["a missing buy box price", (d) => buyBoxPrice(d).remove(), "no price in the buy box"],
    ["an unreadable buy box price", (d) => { buyBoxPrice(d).textContent = "See options"; }, 'buy box price "See options" isn\'t a readable price'],
    ["prices that disagree", (d) => { buyBoxPrice(d).textContent = "$44.98"; }, "buy box price $44.98 but the page shows $45.98"],
    ["a missing quantity dropdown", (d) => quantity(d).remove(), "no quantity dropdown in the buy box"],
    [
      "a quantity that isn't a number",
      (d) => {
        const option = d.createElement("option");
        option.value = "31+";
        quantity(d).append(option);
        quantity(d).value = "31+";
      },
      'quantity "31+" isn\'t a positive whole number',
    ],
    ["a missing title", (d) => { d.querySelector("span#productTitle")!.textContent = ""; }, "no product title (span#productTitle)"],
  ])("explains %s", (_label, change, problem) => {
    const doc = productWith(change);
    const inspection = inspectAmazonPage(doc, PRODUCT_URL);
    expect(inspection.pageType).toBe("product");
    expect(inspection.draft).toBeNull();
    expect(inspection.problems).toEqual([problem]);
    expect(extractAmazonProduct(doc, PRODUCT_URL)).toBeNull();
  });
});

describe("inspectAmazonPage on other pages", () => {
  it("says an Amazon page that isn't a product, cart, or checkout is other", () => {
    expect(inspectAmazonPage(parse(productHtml), new URL("https://www.amazon.com/s?k=lamp"))).toEqual({
      pageType: "other",
      draft: null,
      problems: ["not a product, added-to-cart, cart, or checkout page"],
    });
  });

  it("says when the page isn't on www.amazon.com", () => {
    const inspection = inspectAmazonPage(parse(cartHtml), new URL("https://www.amazon.co.uk/gp/cart/view.html"));
    expect(inspection.pageType).toBe("other");
    expect(inspection.problems).toEqual(["not on https://www.amazon.com (this is https://www.amazon.co.uk)"]);
  });
});
