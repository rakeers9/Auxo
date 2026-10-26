import { ReadFailureCodeSchema, type ReadFailureCode } from "@auxo/shared";
import { describe, expect, it } from "vitest";

import { readShopifyCartFrom } from "../content/shopify";
import { failureCodes, problemCode } from "./codes";
import { inspectAmazonPage } from "./inspect";
import { readAmazonMiniCart } from "./minicart";
import { finishReading } from "./reading";
import { readShopifyCart } from "./shopify";
// Sanitized copies of real pages and responses (names and IDs replaced).
import addedHtml from "./__fixtures__/amazon-added-to-cart.html?raw";
import cartHtml from "./__fixtures__/amazon-cart.html?raw";
import fromCartCheckoutHtml from "./__fixtures__/amazon-checkout-from-cart.html?raw";
import minicartHtml from "./__fixtures__/amazon-product-minicart.html?raw";
import productHtml from "./__fixtures__/amazon-product.html?raw";
import shopifyCartText from "./__fixtures__/shopify/allbirds-cart.json?raw";
import shopifyEmptyCartText from "./__fixtures__/shopify/allbirds-cart-empty.json?raw";
import shopifyHeadlessBody from "./__fixtures__/shopify/gymshark-cart-headless.html?raw";

// Every message here comes from the real readers on a broken copy of a real
// page, never typed by hand: reword a message and its case fails here.

const CART_URL = new URL("https://www.amazon.com/gp/cart/view.html");
const PRODUCT_URL = new URL("https://www.amazon.com/dp/B0TEST0005");
const SPC_URL = new URL("https://www.amazon.com/checkout/p/p-000-0000000-0000000/spc");
const ADDED_ID = "00000000-0000-4000-8000-000000000005";
const ADDED_URL = new URL(`https://www.amazon.com/cart/smart-wagon?newItems=${ADDED_ID},1&ref_=sw_refresh`);
const SHOPIFY_URL = new URL("https://www.allbirds.com/cart");

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function changed(html: string, change: (d: Document) => void): Document {
  const doc = parse(html);
  change(doc);
  return doc;
}

const cartItem = (d: Document) => d.querySelector('#sc-active-cart [data-asin="B0TEST0001"]')!;
const checkoutLine = (d: Document) => d.querySelector(".lineitem-container")!;
const buyBoxPrice = (d: Document) => d.querySelector("form#addToCart #corePrice_feature_div .apex-pricetopay-value .a-offscreen")!;
const quantity = (d: Document) => d.querySelector<HTMLSelectElement>("form#addToCart select#quantity")!;
const addedLine = (d: Document) => d.querySelector(`#nav-flyout-ewc [data-itemid="${ADDED_ID}"]`)!;
const addedSubtotal = (d: Document) => d.querySelector("#sw-subtotal .a-offscreen")!;
const miniLine = (d: Document, asin: string) => d.querySelector(`#nav-flyout-ewc .ewc-item[data-asin="${asin}"]`)!;
const miniSubtotal = (d: Document) => d.querySelector("#nav-flyout-ewc .ewc-subtotal-amount")!;

const cart = (change: (d: Document) => void) => inspectAmazonPage(changed(cartHtml, change), CART_URL).problems;
const checkout = (change: (d: Document) => void) => inspectAmazonPage(changed(fromCartCheckoutHtml, change), SPC_URL).problems;
const product = (change: (d: Document) => void) => inspectAmazonPage(changed(productHtml, change), PRODUCT_URL).problems;
const added = (change: (d: Document) => void, url = ADDED_URL) => inspectAmazonPage(changed(addedHtml, change), url).problems;
const minicart = (change: (d: Document) => void) => readAmazonMiniCart(changed(minicartHtml, change), PRODUCT_URL).problems;
const shopify = (change: (c: Record<string, any>) => void) => {
  const body = JSON.parse(shopifyCartText) as Record<string, any>;
  change(body);
  return readShopifyCart(body, SHOPIFY_URL).problems;
};


const failures: Array<[string, () => string[] | Promise<string[]>, ReadFailureCode[]]> = [
  // Cart page
  ["cart: unreadable price", () => cart((d) => cartItem(d).setAttribute("data-price", "see price in cart")), ["item.no_price"]],
  ["cart: missing price", () => cart((d) => cartItem(d).removeAttribute("data-price")), ["item.no_price"]],
  ["cart: price past the cent with no shown price", () => cart((d) => { cartItem(d).setAttribute("data-price", "8.982"); cartItem(d).removeAttribute("data-displayprice"); }), ["item.no_price"]],
  ["cart: bad quantity", () => cart((d) => cartItem(d).setAttribute("data-quantity", "1.5")), ["item.no_qty"]],
  ["cart: no name", () => cart((d) => { cartItem(d).removeAttribute("data-producttitle"); cartItem(d).querySelector(".sc-product-title .a-truncate-full")!.textContent = ""; }), ["item.no_name"]],
  ["cart: no subtotal", () => cart((d) => d.getElementById("sc-subtotal-amount-buybox")!.remove()), ["total.missing"]],
  ["cart: unreadable subtotal", () => cart((d) => { d.getElementById("sc-subtotal-amount-buybox")!.textContent = "pending"; }), ["total.unreadable"]],
  ["cart: items don't add up", () => cart((d) => cartItem(d).setAttribute("data-price", "10.99")), ["total.mismatch"]],
  ["cart: no items", () => cart((d) => { for (const el of d.querySelectorAll("#sc-active-cart [data-itemtype='active']")) el.remove(); }), ["cart.no_items"]],
  // Checkout
  ["checkout: missing price", () => checkout((d) => checkoutLine(d).querySelector(".apex-price-to-pay-value .a-offscreen")!.remove()), ["item.no_price"]],
  ["checkout: missing quantity", () => checkout((d) => checkoutLine(d).querySelector('fieldset[name="checkout-quantity-stepper"]')!.remove()), ["item.no_qty"]],
  ["checkout: no name", () => checkout((d) => { checkoutLine(d).querySelector(".lineitem-title-text")!.textContent = ""; }), ["item.no_name"]],
  ["checkout: no items subtotal", () => checkout((d) => d.querySelector('input[value="ITEMS_TAX_EXCLUSIVE"]')!.closest("li")!.remove()), ["total.missing"]],
  ["checkout: unreadable items subtotal", () => checkout((d) => { d.querySelector('input[value="ITEMS_TAX_EXCLUSIVE"]')!.closest("li")!.querySelector(".order-summary-line-definition .a-nowrap")!.textContent = "--"; }), ["total.unreadable"]],
  ["checkout: items don't add up", () => checkout((d) => checkoutLine(d).querySelector('fieldset[name="checkout-quantity-stepper"]')!.setAttribute("data-steppervalue", "2")), ["total.mismatch"]],
  // Product page
  ["product: no price anywhere", () => product((d) => { d.querySelectorAll(".apex-pricetopay-value").forEach((e) => e.remove()); d.getElementById("corePriceDisplay_desktop_feature_div")?.remove(); }), ["price.no_layer_found"]],
  ["product: prices that disagree", () => product((d) => { buyBoxPrice(d).textContent = "$44.98"; }), ["price.layers_conflict"]],
  ["product: no quantity dropdown", () => product((d) => quantity(d).remove()), ["qty.no_dropdown"]],
  ["product: quantity not a number", () => product((d) => { const o = d.createElement("option"); o.value = "31+"; quantity(d).append(o); quantity(d).value = "31+"; }), ["qty.unreadable"]],
  ["product: no title", () => product((d) => { d.querySelector("span#productTitle")!.textContent = ""; }), ["product.no_title"]],
  // Added-to-cart page
  ["added: no confirmation", () => added((d) => d.getElementById("NATC_SMART_WAGON_CONF_MSG_SUCCESS")!.remove()), ["added.no_confirmation"]],
  ["added: confirmation without the item", () => added((d) => d.querySelector("#add-to-cart-confirmation-image [data-itemid]")!.remove()), ["added.no_item"]],
  ["added: no quantity in the URL", () => added(() => {}, new URL("https://www.amazon.com/cart/smart-wagon?ref_=sw_refresh")), ["added.no_qty_in_url"]],
  ["added: more added than the cart holds", () => added(() => {}, new URL(`https://www.amazon.com/cart/smart-wagon?newItems=${ADDED_ID},2`)), ["added.qty_mismatch"]],
  ["added: item not in the mini cart", () => added((d) => { addedLine(d).remove(); addedSubtotal(d).textContent = "$191.55"; }), ["added.item_not_in_minicart"]],
  ["added: mini cart doesn't add up", () => added((d) => addedLine(d).setAttribute("data-price", "27.39")), ["total.mismatch"]],
  ["added: no cart subtotal", () => added((d) => addedSubtotal(d).remove()), ["total.missing"]],
  ["added: empty mini cart", () => added((d) => { for (const el of d.querySelectorAll("#nav-flyout-ewc [data-itemtype]")) el.remove(); }), ["minicart.not_loaded"]],
  // Mini cart (sidebar)
  ["mini cart: unreadable price", () => minicart((d) => miniLine(d, "B0TEST0001").setAttribute("data-price", "n/a")), ["item.no_price"]],
  ["mini cart: bad quantity", () => minicart((d) => miniLine(d, "B0TEST0001").setAttribute("data-quantity", "0")), ["item.no_qty"]],
  ["mini cart: no name", () => minicart((d) => miniLine(d, "B0TEST0001").removeAttribute("data-producttitle")), ["item.no_name"]],
  ["mini cart: no subtotal", () => minicart((d) => miniSubtotal(d).remove()), ["total.missing"]],
  ["mini cart: unreadable subtotal", () => minicart((d) => { miniSubtotal(d).textContent = "soon"; }), ["total.unreadable"]],
  // Shopify /cart.js
  ["shopify: headless store", () => readShopifyCart(shopifyHeadlessBody, SHOPIFY_URL).problems, ["shopify.no_cart_api"]],
  ["shopify: lines don't add up", () => shopify((c) => { c.items_subtotal_price = 19999; }), ["total.mismatch"]],
  ["shopify: uneven discount split", () => shopify((c) => { c.items[0].final_line_price = 19999; }), ["item.price_mismatch"]],
  ["shopify: currency without 2 decimals", () => shopify((c) => { c.currency = "JPY"; }), ["shopify.currency_unsupported"]],
  ["shopify: no product title", () => shopify((c) => { c.items[0].product_title = ""; c.items[0].product_has_only_default_variant = true; }), ["item.no_name"]],
  ["shopify: zero quantity", () => shopify((c) => { c.items[0].quantity = 0; c.items[0].final_line_price = 0; }), ["item.no_qty"]],
  ["shopify: negative price", () => shopify((c) => { c.items[0].final_price = -1; c.items[0].final_line_price = -2; }), ["item.no_price"]],
  ["shopify: /cart.js unreachable", async () => (await readShopifyCartFrom(SHOPIFY_URL, async () => { throw new TypeError("offline"); })).problems, ["shopify.fetch_failed"]],
  [
    "shopify: /cart.js too slow",
    async () =>
      (await readShopifyCartFrom(SHOPIFY_URL, (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))), 1)).problems,
    ["shopify.timeout"],
  ],
  // Shared
  ["a cart the shared schema rejects", () => finishReading("not a url", [{ name: "Mug", price_minor: 999, qty: 1 }], 999, [], {}).problems, ["cart.schema_invalid"]],
];

const expectedStates: Array<[string, () => string[]]> = [
  ["cart: nothing ticked", () => cart((d) => { for (const el of d.querySelectorAll("#sc-active-cart [data-itemtype='active']")) el.setAttribute("data-isselected", "0"); })],
  ["checkout: a step without items", () => inspectAmazonPage(parse(productHtml), new URL("https://www.amazon.com/checkout/p/p-000-0000000-0000000/address")).problems],
  ["an Amazon page that isn't read", () => inspectAmazonPage(parse(productHtml), new URL("https://www.amazon.com/s?k=lamp")).problems],
  ["not amazon.com", () => inspectAmazonPage(parse(cartHtml), new URL("https://www.amazon.co.uk/gp/cart/view.html")).problems],
  ["shopify: an empty cart", () => readShopifyCart(shopifyEmptyCartText, SHOPIFY_URL).problems],
];

describe("problemCode", () => {
  it.each(failures)("maps %s", async (_label, read, codes) => {
    const problems = await read();
    expect(problems.length).toBeGreaterThan(0);
    expect([...new Set(problems.map(problemCode))]).toEqual(codes);
  });

  it.each(expectedStates)("treats %s as a page state, not a failure", (_label, read) => {
    const problems = read();
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.map(problemCode)).toEqual(problems.map(() => null));
  });

  it("maps a problem it doesn't know to unknown, so a new message still shows up", () => {
    expect(problemCode("the buy box moved somewhere new")).toBe("unknown");
  });

  it("has a real-reader case for every code except unknown", () => {
    const covered = new Set(failures.flatMap(([, , codes]) => codes));
    expect(ReadFailureCodeSchema.options.filter((code) => !covered.has(code))).toEqual(["unknown"]);
  });

  it("never depends on the quoted page text", () => {
    expect(problemCode('item 1 has no readable data-price: "no items in the active cart"')).toBe("item.no_price");
    expect(problemCode('subtotal "conflicting prices: $1" isn\'t a readable price')).toBe("total.unreadable");
  });
});

describe("failureCodes", () => {
  it("lists each code once, in order, without expected states", () => {
    expect(
      failureCodes("amazon_cart", [
        'item 1 has no readable data-price: "x"',
        'item 2 has no readable data-price: "y"',
        "nothing is selected for checkout (2 items in the cart, none ticked)",
        "no subtotal (#sc-subtotal-amount-buybox) on the page",
      ]),
    ).toEqual(["item.no_price", "total.missing"]);
  });

  it("doesn't count a sidebar that isn't loaded as a mini cart failure, but does on the added-to-cart page", () => {
    expect(failureCodes("amazon_minicart", ["the mini cart is empty or not loaded"])).toEqual([]);
    expect(failureCodes("amazon_added_to_cart", ["the mini cart is empty or not loaded"])).toEqual(["minicart.not_loaded"]);
  });

  it("returns nothing for a clean reading", () => {
    expect(failureCodes("amazon_product", [])).toEqual([]);
  });
});
