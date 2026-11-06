import { describe, expect, it } from "vitest";

import { isAmazonOrderConfirmation } from "./confirmation";
import cartHtml from "./__fixtures__/amazon-cart.html?raw";
import addedHtml from "./__fixtures__/amazon-added-to-cart.html?raw";
import checkoutHtml from "./__fixtures__/amazon-checkout-from-cart.html?raw";
import confirmationHtml from "./__fixtures__/amazon-order-confirmation.html?raw";
import productHtml from "./__fixtures__/amazon-product.html?raw";

// The real URL shape, with its ids replaced by X.
const CONFIRMATION_URL = new URL(
  "https://www.amazon.com/gp/buy/thankyou/handlers/display.html?purchaseId=X&ref_=chk_typ_browserRefresh&isRefresh=1&executionId=X",
);

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("isAmazonOrderConfirmation", () => {
  it("is true on the real 'Order placed, thanks!' page", () => {
    expect(isAmazonOrderConfirmation(parse(confirmationHtml), CONFIRMATION_URL)).toBe(true);
  });

  it("is true on any thank-you path, with or without the query", () => {
    const doc = parse(confirmationHtml);
    expect(isAmazonOrderConfirmation(doc, new URL("https://www.amazon.com/gp/buy/thankyou/handlers/display.html"))).toBe(true);
    expect(isAmazonOrderConfirmation(doc, new URL("https://www.amazon.com/gp/buy/thankyou/other"))).toBe(true);
  });

  it("is false on the thank-you URL without the green 'Order placed' alert (a failed or pending order)", () => {
    const doc = parse(confirmationHtml);
    doc.querySelector(".a-alert-inline-success")!.classList.replace("a-alert-inline-success", "a-alert-inline-warning");
    expect(isAmazonOrderConfirmation(doc, CONFIRMATION_URL)).toBe(false);
  });

  it.each([
    ["cart", cartHtml, "https://www.amazon.com/gp/cart/view.html"],
    ["added to cart", addedHtml, "https://www.amazon.com/cart/smart-wagon?newItems=X"],
    ["checkout", checkoutHtml, "https://www.amazon.com/checkout/p/p-X/spc"],
    ["product", productHtml, "https://www.amazon.com/dp/B0TEST0005"],
  ])("is false on the %s page", (_, html, href) => {
    expect(isAmazonOrderConfirmation(parse(html), new URL(href))).toBe(false);
  });

  it("is false when the confirmation markup shows up on another path", () => {
    expect(isAmazonOrderConfirmation(parse(confirmationHtml), new URL("https://www.amazon.com/gp/cart/view.html"))).toBe(false);
  });

  it("is false off www.amazon.com or over http", () => {
    const doc = parse(confirmationHtml);
    expect(isAmazonOrderConfirmation(doc, new URL("https://www.amazon.co.uk/gp/buy/thankyou/handlers/display.html"))).toBe(false);
    expect(isAmazonOrderConfirmation(doc, new URL("http://www.amazon.com/gp/buy/thankyou/handlers/display.html"))).toBe(false);
  });

  it("follows a backend selector override", () => {
    const doc = parse(confirmationHtml);
    expect(isAmazonOrderConfirmation(doc, CONFIRMATION_URL, { "confirmation.placed": "#no-such-alert" })).toBe(false);
    expect(isAmazonOrderConfirmation(doc, CONFIRMATION_URL, { "confirmation.placed": "#widget-purchaseConfirmationStatus" })).toBe(true);
  });
});
