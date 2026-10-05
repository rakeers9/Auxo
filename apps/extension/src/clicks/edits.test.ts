import { afterEach, describe, expect, it } from "vitest";

import addedToCartHtml from "../cart/__fixtures__/amazon-added-to-cart.html?raw";
import cartEmptyHtml from "../cart/__fixtures__/amazon-cart-empty.html?raw";
import cartSavedItemHtml from "../cart/__fixtures__/amazon-cart-saved-item.html?raw";
import cartHtml from "../cart/__fixtures__/amazon-cart.html?raw";
import minicartHtml from "../cart/__fixtures__/amazon-product-minicart.html?raw";
import productHtml from "../cart/__fixtures__/amazon-product.html?raw";
import dawnCartHtml from "../cart/__fixtures__/shopify/dawn-cart-buttons.html?raw";
import deathwishCartHtml from "../cart/__fixtures__/shopify/deathwish-cart-buttons.html?raw";
import horizonCartHtml from "../cart/__fixtures__/shopify/horizon-cart-buttons.html?raw";
import horizonDrawerHtml from "../cart/__fixtures__/shopify/horizon-drawer-buttons.html?raw";
import { classifyChange, classifyClick, classifySubmit, quantityChangeIntent } from "./classify";
import { KNOWN_IGNORED, KNOWN_QUANTITY_FIELDS, PLATFORM_QUANTITY_FIELDS } from "./known";

// Cart edits (+, −, delete, save for later) against real saved pages: Amazon's
// cart page and cart sidebar, and Shopify's Dawn, Horizon (page and drawer)
// and Death Wish Coffee carts.

const AMAZON_CART = new URL("https://www.amazon.com/gp/cart/view.html");
const AMAZON_PRODUCT = new URL("https://www.amazon.com/side-table/dp/B0TEST0005");
const OTHER_HOST = new URL("https://www.amazon.co.uk/gp/cart/view.html");
const STORE_CART = new URL("https://some-store.example/cart");

const AMAZON_PAGES = [cartHtml, cartSavedItemHtml, minicartHtml, productHtml, addedToCartHtml];
const SHOPIFY_CARTS = { dawn: dawnCartHtml, horizon: horizonCartHtml, deathwish: deathwishCartHtml, drawer: horizonDrawerHtml };

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function find(root: Document | Element, selector: string): Element {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`fixture has no ${selector}`);
  return el;
}

// Sets a field's current value (not its original one) and classifies the change.
function change(field: Element, value: string, url: URL, platform?: "shopify") {
  (field as HTMLInputElement).value = value;
  return classifyChange(field, url, undefined, platform);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("fixture grounding", () => {
  it("every Amazon ignored control and quantity field exists in a real fixture", () => {
    const docs = AMAZON_PAGES.map(parse);
    for (const selector of [...(KNOWN_IGNORED["www.amazon.com"] ?? []), ...(KNOWN_QUANTITY_FIELDS["www.amazon.com"] ?? [])]) {
      expect(docs.some((doc) => doc.querySelector(selector)), selector).toBe(true);
    }
  });

  it("every Shopify quantity field exists in every real Shopify cart", () => {
    for (const [store, html] of Object.entries(SHOPIFY_CARTS)) {
      for (const selector of PLATFORM_QUANTITY_FIELDS.shopify) {
        expect(parse(html).querySelector(selector), `${store} ${selector}`).not.toBeNull();
      }
    }
  });
});

describe("Amazon cart page (amazon-cart.html)", () => {
  const doc = parse(cartHtml);
  const row = (n: number) => find(doc, `#sc-active-00000000-0000-4000-8000-00000000000${n}`);

  it("+ is increase_qty, on the button or its icon", () => {
    const plus = find(row(1), '[data-action="a-stepper-increment"]');
    expect(classifyClick(plus, AMAZON_CART)).toMatchObject({ intent: "increase_qty", source: "known" });
    expect(classifyClick(plus.firstElementChild ?? plus, AMAZON_CART)).toMatchObject({ intent: "increase_qty" });
  });

  it("− at quantity 3 is decrease_qty", () => {
    const minus = find(row(1), '[data-action="a-stepper-decrement"]');
    expect(find(row(1), "fieldset").getAttribute("data-steppervalue")).toBe("3");
    expect(minus.querySelector(".a-icon-small-remove")).not.toBeNull();
    expect(classifyClick(minus, AMAZON_CART)).toMatchObject({ intent: "decrease_qty", source: "known" });
  });

  it("− at quantity 1 (the trash icon) is remove_item, on the button or the icon", () => {
    const minus = find(row(2), '[data-action="a-stepper-decrement"]');
    expect(find(row(2), "fieldset").getAttribute("data-steppervalue")).toBe("1");
    const trash = find(minus, ".a-icon-small-trash");
    expect(classifyClick(minus, AMAZON_CART)).toMatchObject({ intent: "remove_item", source: "known" });
    expect(classifyClick(trash, AMAZON_CART)).toMatchObject({ intent: "remove_item", source: "known" });
  });

  it("Delete (input or its wrapper) is remove_item", () => {
    const del = find(row(1), 'input[name="submit.delete-active"]');
    expect(classifyClick(del, AMAZON_CART)).toEqual({ intent: "remove_item", source: "known", label: "Delete" });
    expect(classifyClick(find(row(1), 'span[data-action="delete-active"]'), AMAZON_CART)).toMatchObject({
      intent: "remove_item",
      source: "known",
    });
    expect(classifySubmit(find(doc, "#activeCartViewForm") as HTMLFormElement, del, AMAZON_CART)).toMatchObject({
      intent: "remove_item",
      source: "known",
    });
  });

  it("Save for later (input or its wrapper) is save_for_later", () => {
    const sfl = find(row(1), 'input[name="submit.save-for-later"]');
    expect(classifyClick(sfl, AMAZON_CART)).toEqual({ intent: "save_for_later", source: "known", label: "Save for later" });
    expect(classifyClick(find(row(1), 'span[data-action="save-for-later"]'), AMAZON_CART)).toMatchObject({
      intent: "save_for_later",
      source: "known",
    });
    expect(classifySubmit(find(doc, "#activeCartViewForm") as HTMLFormElement, sfl, AMAZON_CART)).toMatchObject({
      intent: "save_for_later",
      source: "known",
    });
  });

  it("the quantity value display and box are not clicks", () => {
    expect(classifyClick(find(row(1), '[data-action="a-stepper-spinbutton"]'), AMAZON_CART)).toBeNull();
    expect(classifyClick(find(row(1), 'input[name="quantityBox"]'), AMAZON_CART)).toBeNull();
  });

  it("on another host the stepper is not known, and Delete / Save for later are only guesses", () => {
    expect(classifyClick(find(row(1), '[data-action="a-stepper-increment"]'), OTHER_HOST)).toBeNull();
    expect(classifyClick(find(row(1), 'input[name="submit.delete-active"]'), OTHER_HOST)).toEqual({
      intent: "remove_item",
      source: "guess",
      label: "Delete",
    });
    expect(classifyClick(find(row(1), 'input[name="submit.save-for-later"]'), OTHER_HOST)).toMatchObject({
      intent: "save_for_later",
      source: "guess",
    });
  });
});

describe("Amazon saved-for-later list (amazon-cart-saved-item.html)", () => {
  const doc = parse(cartSavedItemHtml);

  it("deleting a saved item is not remove_item (it was never in the cart), click or submit", () => {
    const del = find(doc, 'input[name="submit.delete-saved"]');
    expect(del.getAttribute("value")).toBe("Delete");
    expect(classifyClick(del, AMAZON_CART)).toBeNull();
    expect(classifySubmit(find(doc, "#savedCartViewForm") as HTMLFormElement, del, AMAZON_CART)).toBeNull();
  });

  it("the active items' Delete on the same page is still remove_item", () => {
    expect(classifyClick(find(doc, 'input[name="submit.delete-active"]'), AMAZON_CART)).toMatchObject({
      intent: "remove_item",
      source: "known",
    });
  });

  it("Add to list is nothing", () => {
    expect(classifyClick(find(doc, 'input[name="submit.add-to-list-popover"]'), AMAZON_CART)).toBeNull();
  });
});

describe("Amazon saved list: Move to cart puts the item back in the cart (add_to_cart)", () => {
  describe.each([
    ["amazon-cart-saved-item.html", cartSavedItemHtml],
    ["amazon-cart-empty.html", cartEmptyHtml],
  ])("%s", (_name, html) => {
    const doc = parse(html);
    const input = find(doc, 'input[name="submit.move-to-cart"]');

    it("the input is known add_to_cart, labeled from its value", () => {
      expect(classifyClick(input, AMAZON_CART)).toEqual({ intent: "add_to_cart", source: "known", label: "Move to cart" });
    });

    it("a click on the button's inner text span is known add_to_cart", () => {
      const wrapper = find(doc, '[data-feature-id="grid-view-move-to-cart"]');
      const inner = find(wrapper, ".a-button-text");
      expect(classifyClick(inner, AMAZON_CART)).toMatchObject({ intent: "add_to_cart", source: "known" });
    });

    it("submitting the saved list's form with it is known add_to_cart", () => {
      const form = find(doc, "#savedCartViewForm") as HTMLFormElement;
      expect(form.contains(input)).toBe(true);
      expect(classifySubmit(form, input, AMAZON_CART)).toMatchObject({ intent: "add_to_cart", source: "known" });
    });

    it("its Delete stays ignored", () => {
      expect(classifyClick(find(doc, 'input[name="submit.delete-saved"]'), AMAZON_CART)).toBeNull();
    });
  });

  it("off Amazon, Move to cart is neither known nor guessed", () => {
    const input = find(parse(cartSavedItemHtml), 'input[name="submit.move-to-cart"]');
    expect(classifyClick(input, OTHER_HOST)).toBeNull();
  });
});

describe("Amazon cart sidebar (amazon-product-minicart.html)", () => {
  const doc = parse(minicartHtml);
  const sidebar = find(doc, "#nav-flyout-ewc");
  const steppers = [...sidebar.querySelectorAll('fieldset[data-action="a-stepper"]')];

  it("has a quantity-1 and a quantity-3 line", () => {
    expect(steppers.map((s) => s.getAttribute("data-steppervalue")).sort()).toEqual(["1", "3"]);
  });

  it.each([
    ["1", "remove_item"],
    ["3", "decrease_qty"],
  ])("− at quantity %s is %s", (qty, intent) => {
    const stepper = steppers.find((s) => s.getAttribute("data-steppervalue") === qty) as Element;
    expect(classifyClick(find(stepper, '[data-action="a-stepper-decrement"]'), AMAZON_PRODUCT)).toMatchObject({
      intent,
      source: "known",
    });
  });

  it("+ is increase_qty on every line", () => {
    for (const stepper of steppers) {
      expect(classifyClick(find(stepper, '[data-action="a-stepper-increment"]'), AMAZON_PRODUCT)).toMatchObject({
        intent: "increase_qty",
        source: "known",
      });
    }
  });

  it("the close button is nothing", () => {
    expect(classifyClick(find(doc, "#ewc-smart-wagon-close-button"), AMAZON_PRODUCT)).toBeNull();
  });
});

describe("classifyChange on Amazon's quantity box", () => {
  it.each([
    ["5", "increase_qty"],
    ["2", "decrease_qty"],
    ["0", "remove_item"],
  ])("cart page, 3 → %s is %s", (value, intent) => {
    const box = find(parse(cartHtml), '#sc-active-00000000-0000-4000-8000-000000000001 input[name="quantityBox"]');
    expect(box.getAttribute("value")).toBe("3");
    expect(change(box, value, AMAZON_CART)).toMatchObject({ intent, source: "known" });
  });

  it("sidebar, 1 → 2 is increase_qty", () => {
    const sidebar = find(parse(minicartHtml), "#nav-flyout-ewc");
    const box = [...sidebar.querySelectorAll<HTMLInputElement>('input[name="quantityBox"]')].find(
      (b) => b.getAttribute("value") === "1",
    ) as Element;
    expect(change(box, "2", AMAZON_PRODUCT)).toMatchObject({ intent: "increase_qty", source: "known" });
  });

  it("no change, an empty box, or text is nothing", () => {
    const box = find(parse(cartHtml), 'input[name="quantityBox"]');
    expect(change(box, box.getAttribute("value") ?? "", AMAZON_CART)).toBeNull();
    expect(change(box, "", AMAZON_CART)).toBeNull();
    expect(change(box, "abc", AMAZON_CART)).toBeNull();
  });

  it("the product page's 'how many to add' dropdown is not a cart edit", () => {
    const select = find(parse(productHtml), "select#quantity") as HTMLSelectElement;
    select.selectedIndex = Math.min(2, select.options.length - 1);
    expect(classifyChange(select, AMAZON_PRODUCT)).toBeNull();
  });

  it("on another host the box is unknown", () => {
    expect(change(find(parse(cartHtml), 'input[name="quantityBox"]'), "5", OTHER_HOST)).toBeNull();
  });

  it("non-fields and empty targets are nothing", () => {
    const doc = parse(cartHtml);
    expect(classifyChange(find(doc, '[data-action="a-stepper-increment"]'), AMAZON_CART)).toBeNull();
    expect(classifyChange(null, AMAZON_CART)).toBeNull();
    expect(classifyChange(window, AMAZON_CART)).toBeNull();
  });
});

describe.each(Object.entries(SHOPIFY_CARTS))("Shopify %s cart line", (store, html) => {
  const doc = parse(html);
  const line = find(doc, 'input[name="updates[]"]').parentElement as Element;

  it("+ is increase_qty and − is decrease_qty, on the button or its inner span", () => {
    const plus = find(line, 'button[name="plus"]');
    const minus = find(line, 'button[name="minus"]');
    expect(classifyClick(plus, STORE_CART, undefined, "shopify")).toMatchObject({ intent: "increase_qty", source: "known" });
    expect(classifyClick(minus, STORE_CART, undefined, "shopify")).toMatchObject({ intent: "decrease_qty", source: "known" });
    const inner = plus.querySelector("span");
    if (inner) expect(classifyClick(inner, STORE_CART, undefined, "shopify")?.intent).toBe("increase_qty");
  });

  it("remove is remove_item", () => {
    const remove = find(doc, 'a[href*="/cart/change"][href*="quantity=0"], button.cart-items__remove');
    expect(classifyClick(remove, STORE_CART, undefined, "shopify")).toMatchObject({ intent: "remove_item", source: "known" });
  });

  it.each([
    ["3", "increase_qty"],
    ["0", "remove_item"],
  ])("typing %s into the quantity (from 1) is %s", (value, intent) => {
    const input = find(parse(html), 'input[name="updates[]"]');
    expect(input.getAttribute("value")).toBe("1");
    expect(change(input, value, STORE_CART, "shopify")).toMatchObject({ intent, source: "known" });
  });

  it("without platform 'shopify', none of it is known", () => {
    for (const el of [find(line, 'button[name="plus"]'), find(line, 'button[name="minus"]')]) {
      expect(classifyClick(el, STORE_CART)?.source, store).not.toBe("known");
    }
    expect(change(find(parse(html), 'input[name="updates[]"]'), "3", STORE_CART)).toBeNull();
  });
});

describe("Shopify: the product form's own +/− (how many to add) are not cart edits", () => {
  it("Horizon product form +/− with the cart drawer on the same page", () => {
    const doc = parse(horizonDrawerHtml);
    const form = find(doc, ".quantity-selector:not(:has(input[name='updates[]']))");
    expect(form.querySelector('input[name="quantity"]')).not.toBeNull();
    for (const name of ["minus", "plus"]) {
      expect(classifyClick(find(form, `button[name="${name}"]`), STORE_CART, undefined, "shopify"), name).toBeNull();
    }
    expect(change(find(form, 'input[name="quantity"]'), "4", STORE_CART, "shopify")).toBeNull();
  });
});

describe("quantityChangeIntent", () => {
  function select(options: string, chosen: number): HTMLSelectElement {
    document.body.innerHTML = `<select>${options}</select>`;
    const el = document.querySelector("select") as HTMLSelectElement;
    el.selectedIndex = chosen;
    return el;
  }

  it("compares with the option selected in the HTML", () => {
    const opts = '<option value="1">1</option><option value="2" selected>2</option><option value="3">3</option>';
    expect(quantityChangeIntent(select(opts, 2))).toBe("increase_qty");
    expect(quantityChangeIntent(select(opts, 0))).toBe("decrease_qty");
    expect(quantityChangeIntent(select(opts, 1))).toBeNull();
  });

  it("without a selected option, the first option is the original", () => {
    expect(quantityChangeIntent(select('<option value="1">1</option><option value="2">2</option>', 1))).toBe("increase_qty");
  });

  it("0 or a delete/remove option is remove_item", () => {
    const opts = '<option value="0">0 (Delete)</option><option value="1" selected>1</option>';
    expect(quantityChangeIntent(select(opts, 0))).toBe("remove_item");
    expect(quantityChangeIntent(select('<option value="x">Remove</option><option value="1" selected>1</option>', 0))).toBe(
      "remove_item",
    );
  });

  it("reads leading digits (10+) and ignores non-numbers", () => {
    expect(quantityChangeIntent(select('<option value="9" selected>9</option><option value="10+">10+</option>', 1))).toBe(
      "increase_qty",
    );
    expect(quantityChangeIntent(select('<option value="1" selected>1</option><option value="more">More</option>', 1))).toBeNull();
  });

  it("an input falls back to Amazon's data-old-value when it has no value attribute", () => {
    document.body.innerHTML = '<span data-old-value="2"><input type="number"></span>';
    const input = document.querySelector("input") as HTMLInputElement;
    input.value = "1";
    expect(quantityChangeIntent(input)).toBe("decrease_qty");
  });

  it("other elements are nothing", () => {
    document.body.innerHTML = "<div></div>";
    expect(quantityChangeIntent(document.querySelector("div") as Element)).toBeNull();
  });
});
