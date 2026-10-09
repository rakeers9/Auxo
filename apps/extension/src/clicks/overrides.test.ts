import { StoreOverridesSchema } from "@auxo/shared";
import { afterEach, describe, expect, it } from "vitest";

import productHtml from "../cart/__fixtures__/amazon-product.html?raw";
import { classifyClick, classifySubmit } from "./classify";
import { controlsFor, KNOWN_CONTROLS, type ButtonOverrides } from "./known";

const AMAZON = new URL("https://www.amazon.com/side-table/dp/B0TEST0005");
const SHOP = new URL("https://shop.example.com/products/lamp");

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function find(root: Document, selector: string): Element {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`no ${selector}`);
  return el;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("controlsFor", () => {
  it("returns the bundled controls when there are no overrides", () => {
    expect(controlsFor("www.amazon.com")).toBe(KNOWN_CONTROLS["www.amazon.com"]);
    expect(controlsFor("www.amazon.com", {})).toEqual(KNOWN_CONTROLS["www.amazon.com"]);
    expect(controlsFor("shop.example.com")).toEqual([]);
  });

  it("replaces only the overridden intent and keeps the order", () => {
    const merged = controlsFor("www.amazon.com", { add_to_cart: ["#atc-v2"] });
    const defaults = KNOWN_CONTROLS["www.amazon.com"] ?? [];
    expect(merged.map((c) => c.intent)).toEqual(defaults.map((c) => c.intent));
    for (const control of merged) {
      const expected = control.intent === "add_to_cart" ? ["#atc-v2"] : defaults.find((d) => d.intent === control.intent)?.selectors;
      expect(control.selectors).toEqual(expected);
    }
  });

  it("ignores non-list values and unknown intents in untrusted config", () => {
    const bad = { add_to_cart: "#x", page_view: ["#y"], nonsense: ["#z"] } as unknown as ButtonOverrides;
    expect(controlsFor("www.amazon.com", bad)).toEqual(KNOWN_CONTROLS["www.amazon.com"]);
    expect(controlsFor("shop.example.com", bad)).toEqual([]);
  });

  it("accepts the buttons shape of the StoreOverrides contract", () => {
    const overrides = StoreOverridesSchema.parse({ enabled: true, buttons: { buy_now: ["#bn"] } });
    expect(controlsFor("www.amazon.com", overrides.buttons).find((c) => c.intent === "buy_now")?.selectors).toEqual([
      "#bn",
    ]);
  });
});

describe("classifyClick with button overrides", () => {
  it("an override replaces one intent's selectors and keeps the others (real product page)", () => {
    const doc = parse(productHtml);
    // Point add_to_cart at a selector that isn't on the page: the bundled one stops matching...
    const buttons: ButtonOverrides = { add_to_cart: ["#add-to-cart-button-v2"] };
    const atc = classifyClick(find(doc, "#add-to-cart-button"), AMAZON, buttons);
    expect(atc?.source).not.toBe("known");
    // ...while buy_now, checkout, and view_cart keep their bundled selectors.
    expect(classifyClick(find(doc, "#buy-now-button"), AMAZON, buttons)).toMatchObject({
      intent: "buy_now",
      source: "known",
    });
    expect(classifyClick(find(doc, "#nav-cart-count"), AMAZON, buttons)).toMatchObject({
      intent: "view_cart",
      source: "known",
    });
  });

  it("an override's new selector is matched with closest()", () => {
    const doc = parse(productHtml);
    const buttons: ButtonOverrides = { add_to_cart: ['[id="submit.add-to-cart"]'] };
    expect(classifyClick(find(doc, '[id="submit.add-to-cart-announce"]'), AMAZON, buttons)).toMatchObject({
      intent: "add_to_cart",
      source: "known",
    });
  });

  it("an invalid selector is skipped and the rest of the list still works", () => {
    const doc = parse(productHtml);
    const buttons: ButtonOverrides = { buy_now: ["div[[[", "#buy-now-button"], add_to_cart: [":::"] };
    expect(() => classifyClick(find(doc, "#buy-now-button"), AMAZON, buttons)).not.toThrow();
    expect(classifyClick(find(doc, "#buy-now-button"), AMAZON, buttons)).toMatchObject({
      intent: "buy_now",
      source: "known",
    });
    // An override of only invalid selectors matches nothing; the click falls back to a guess.
    expect(classifyClick(find(doc, "#add-to-cart-button"), AMAZON, buttons)).toEqual({
      intent: "add_to_cart",
      source: "guess",
      label: "Add to cart",
    });
  });

  it("an empty list turns an intent's known buttons off", () => {
    const doc = parse(productHtml);
    expect(classifyClick(find(doc, "#nav-cart-count"), AMAZON, { view_cart: [] })).toBeNull();
  });

  it("a host with no bundled controls gains known buttons purely from config", () => {
    document.body.innerHTML =
      '<div class="pdp"><button class="js-atc"><span class="t">Get it</span></button></div>' +
      '<a class="mini-bag" href="/bag"><i class="n">2</i></a>';
    const buttons: ButtonOverrides = { add_to_cart: [".js-atc"], view_cart: ["a.mini-bag"] };

    expect(classifyClick(find(document, ".t"), SHOP, buttons)).toEqual({
      intent: "add_to_cart",
      source: "known",
      label: "Get it",
    });
    expect(classifyClick(find(document, ".n"), SHOP, buttons)).toMatchObject({ intent: "view_cart", source: "known" });
    // Without config the same host has no known buttons.
    expect(classifyClick(find(document, ".t"), SHOP)).toBeNull();
  });

  it("overriding one intent on a new host doesn't pull in another host's defaults", () => {
    const doc = parse(productHtml);
    // Amazon's bundled buy_now selector must not apply on shop.example.com.
    expect(classifyClick(find(doc, "#buy-now-button"), SHOP, { add_to_cart: ["#x"] })?.source).not.toBe("known");
  });
});

describe("classifySubmit with button overrides", () => {
  it("uses overridden selectors for the submitter", () => {
    document.body.innerHTML = '<form action="/x"><button type="submit" class="po">Confirm</button></form>';
    const form = find(document, "form") as HTMLFormElement;
    const submitter = find(document, ".po");
    expect(classifySubmit(form, submitter, SHOP, { place_order: [".po"] })).toEqual({
      intent: "place_order",
      source: "known",
      label: "Confirm",
    });
    expect(classifySubmit(form, submitter, SHOP)).toBeNull();
  });

  it("an invalid selector never breaks a submit", () => {
    const doc = parse(productHtml);
    const form = find(doc, "form#addToCart") as HTMLFormElement;
    expect(classifySubmit(form, find(doc, "#buy-now-button"), AMAZON, { buy_now: ["<<"] })).toEqual({
      intent: "checkout",
      source: "guess",
    });
  });
});
