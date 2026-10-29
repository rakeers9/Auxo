import { CartSchema } from "@auxo/shared";
import { describe, expect, it } from "vitest";

import { extractAmazonAddedToCart, isAmazonAddedToCartPage, readAmazonAddedToCart } from "./added";
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

  describe('"Add all" offers (several items added at once)', () => {
    // Real URL shape: newItems=<id>,<qty>|<id>,<qty>|... The fixture's mini cart
    // already lists the other two items; the extra confirmation entries are copies
    // of the first one (the real page's markup for several items wasn't saved).
    const ID_CHAIR = "00000000-0000-4000-8000-000000000006";
    const ID_KEYBOARD = "00000000-0000-4000-8000-000000000007";
    const multiUrl = (...entries: string[]) => new URL(`https://www.amazon.com/cart/smart-wagon?newItems=${entries.join("|")}&ref_=sw_refresh`);
    const withConfirmed = (ids: string[]) =>
      addedWith((d) => {
        const container = d.querySelector("#add-to-cart-confirmation-image")!;
        for (const id of ids) {
          const copy = container.querySelector("[data-itemid]")!.cloneNode(true) as Element;
          copy.setAttribute("data-itemid", id);
          container.appendChild(copy);
        }
      });

    it("reads every added item at the quantity added", () => {
      const doc = withConfirmed([ID_CHAIR, ID_KEYBOARD]);
      const reading = readAmazonAddedToCart(doc, multiUrl(`${ADDED_ID},1`, `${ID_CHAIR},1`, `${ID_KEYBOARD},1`));
      expect(reading.problems).toEqual([]);
      expect(reading.draft?.items).toEqual([
        { name: "Stainless steel water bottle, 32 oz", price_minor: 2639, qty: 1 },
        { name: "Office chair with lumbar support", price_minor: 12159, qty: 1 },
        { name: "Wireless keyboard, full size", price_minor: 3999, qty: 1 },
      ]);
      expect(reading.draft?.total_minor).toBe(18797);
      expect(reading.details["added items"]).toBe("3");
    });

    it.each([2, 5, 9, 40])("reads an offer that adds %i items, not just three", (count) => {
      // The fixture's added item plus (count - 1) more lines of $10.00, in the
      // mini cart, the confirmation block, and the cart subtotal.
      const extra = Array.from({ length: count - 1 }, (_, i) => `00000000-0000-4000-8000-${String(1000 + i).padStart(12, "0")}`);
      const doc = addedWith((d) => {
        const line = addedLine(d);
        const confirmation = d.querySelector("#add-to-cart-confirmation-image")!;
        for (const [i, id] of extra.entries()) {
          const lineCopy = line.cloneNode(true) as Element;
          lineCopy.setAttribute("data-itemid", id);
          lineCopy.setAttribute("data-producttitle", `Extra item ${i + 1}`);
          lineCopy.setAttribute("data-price", "10.00");
          line.after(lineCopy);
          const imageCopy = confirmation.querySelector("[data-itemid]")!.cloneNode(true) as Element;
          imageCopy.setAttribute("data-itemid", id);
          confirmation.appendChild(imageCopy);
        }
        subtotal(d).textContent = `$${(217.94 + extra.length * 10).toFixed(2)}`;
      });
      const reading = readAmazonAddedToCart(doc, multiUrl(`${ADDED_ID},1`, ...extra.map((id) => `${id},1`)));
      expect(reading.problems).toEqual([]);
      expect(reading.draft?.items).toHaveLength(count);
      expect(reading.draft?.items[count - 1]).toEqual({ name: `Extra item ${count - 1}`, price_minor: 1000, qty: 1 });
      expect(reading.draft?.total_minor).toBe(2639 + (count - 1) * 1000);
    });

    it("gives up, naming the item, when one added item's quantity is missing from the URL", () => {
      const doc = withConfirmed([ID_CHAIR, ID_KEYBOARD]);
      const reading = readAmazonAddedToCart(doc, multiUrl(`${ADDED_ID},1`, `${ID_CHAIR},1`));
      expect(reading.draft).toBeNull();
      expect(reading.problems).toEqual(["the quantity added for added item 3 isn't in the URL (newItems)"]);
    });

    it("gives up when an added item isn't in the mini cart", () => {
      const missing = "00000000-0000-4000-8000-0000000000ff";
      const doc = withConfirmed([missing]);
      const reading = readAmazonAddedToCart(doc, multiUrl(`${ADDED_ID},1`, `${missing},1`));
      expect(reading.draft).toBeNull();
      expect(reading.problems).toEqual(["added item 2 isn't in the mini cart"]);
    });
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
