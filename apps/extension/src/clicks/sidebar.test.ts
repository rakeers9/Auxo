import { describe, expect, it } from "vitest";

import afterDeleteLastHtml from "../cart/__fixtures__/amazon-sidebar-after-delete-last.html?raw";
import afterMinusHtml from "../cart/__fixtures__/amazon-sidebar-after-minus.html?raw";
import afterPlusHtml from "../cart/__fixtures__/amazon-sidebar-after-plus.html?raw";
import beforeDeleteLastHtml from "../cart/__fixtures__/amazon-sidebar-before-delete-last.html?raw";
import beforeHtml from "../cart/__fixtures__/amazon-sidebar-before.html?raw";
import { classifyChange, classifyClick } from "./classify";
import { EDIT_INTENTS } from "./guess";

// Amazon's cart sidebar (#nav-flyout-ewc) across real before/after saves of
// one line (auxo-1c, read only): qty 1 → + → qty 2 → − → qty 1, and a last
// item at qty 1 before and after it's deleted. The − button is the same
// element throughout; only its icon says whether it deletes (trash, qty 1)
// or subtracts one (small-remove, qty ≥ 2).

const URL_ = new URL("https://www.amazon.com/side-table/dp/B0TEST0005");

const STATES = {
  before: { html: beforeHtml, qty: "1", minus: "remove_item" },
  afterPlus: { html: afterPlusHtml, qty: "2", minus: "decrease_qty" },
  afterMinus: { html: afterMinusHtml, qty: "1", minus: "remove_item" },
  beforeDeleteLast: { html: beforeDeleteLastHtml, qty: "1", minus: "remove_item" },
} as const;

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function find(root: Document | Element, selector: string): Element {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`fixture has no ${selector}`);
  return el;
}

function sidebar(html: string): Element {
  return find(parse(html), "#nav-flyout-ewc");
}

describe.each(Object.entries(STATES))("sidebar %s", (_state, { html, qty, minus }) => {
  const root = sidebar(html);
  const stepper = find(root, '[data-action="a-stepper"]');
  const minusButton = find(stepper, '[data-action="a-stepper-decrement"]');
  const plusButton = find(stepper, '[data-action="a-stepper-increment"]');

  it(`is the one line at quantity ${qty}`, () => {
    expect(root.querySelectorAll('[data-action="a-stepper"]')).toHaveLength(1);
    expect(stepper.getAttribute("data-steppervalue")).toBe(qty);
    expect(find(root, 'input[name="quantityBox"]').getAttribute("value")).toBe(qty);
  });

  it(`− is ${minus}, on the button and on its icon`, () => {
    const icon = find(minusButton, '[data-a-selector="decrement-icon"]');
    expect(icon.classList.contains(minus === "remove_item" ? "a-icon-small-trash" : "a-icon-small-remove")).toBe(true);
    expect(classifyClick(minusButton, URL_)).toMatchObject({ intent: minus, source: "known" });
    expect(classifyClick(icon, URL_)).toMatchObject({ intent: minus, source: "known" });
  });

  it("+ is increase_qty, on the button and on its icon", () => {
    expect(classifyClick(plusButton, URL_)).toMatchObject({ intent: "increase_qty", source: "known" });
    expect(classifyClick(find(plusButton, ".a-icon-small-add"), URL_)).toMatchObject({
      intent: "increase_qty",
      source: "known",
    });
  });

  it("typing a higher quantity is increase_qty, and 0 is remove_item", () => {
    const box = () => find(sidebar(html), 'input[name="quantityBox"]') as HTMLInputElement;
    const higher = box();
    higher.value = String(Number(qty) + 1);
    expect(classifyChange(higher, URL_)).toMatchObject({ intent: "increase_qty", source: "known" });
    const zero = box();
    zero.value = "0";
    expect(classifyChange(zero, URL_)).toMatchObject({ intent: "remove_item", source: "known" });
  });

  it("every other control in the sidebar is nothing, and nothing is a buy intent", () => {
    for (const control of root.querySelectorAll("button, a, input, [role=button]")) {
      if (control === minusButton || control === plusButton) continue;
      expect(classifyClick(control, URL_), control.outerHTML.slice(0, 120)).toBeNull();
    }
  });
});

describe("the − flips meaning on the same line as the quantity changes", () => {
  const line = (html: string) => find(sidebar(html), '[id^="sc-item-"]');

  it("before, after +, and after − are the same line", () => {
    const ids = [beforeHtml, afterPlusHtml, afterMinusHtml].map((html) => line(html).id);
    expect(new Set(ids).size).toBe(1);
  });

  it("remove_item at qty 1 → decrease_qty at qty 2 → remove_item at qty 1", () => {
    const intents = [beforeHtml, afterPlusHtml, afterMinusHtml].map(
      (html) => classifyClick(find(line(html), '[data-action="a-stepper-decrement"]'), URL_)?.intent,
    );
    expect(intents).toEqual(["remove_item", "decrease_qty", "remove_item"]);
  });
});

describe("sidebar after deleting the last item", () => {
  const root = sidebar(afterDeleteLastHtml);

  it("the stepper and quantity box are gone and the removed message shows", () => {
    expect(root.querySelector('[data-action="a-stepper"]')).toBeNull();
    expect(root.querySelector('input[name="quantityBox"]')).toBeNull();
    expect(find(root, ".ewc-item-remove-msg").classList.contains("aok-hidden")).toBe(false);
  });

  it("is the same line that was deleted", () => {
    expect(find(root, '[id^="sc-item-"]').id).toBe(find(sidebar(beforeDeleteLastHtml), '[id^="sc-item-"]').id);
  });

  it("nothing left in the sidebar classifies, as a cart edit or a buy intent", () => {
    const controls = [...root.querySelectorAll("button, a, input, [role=button], .ewc-item-remove-msg")];
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(classifyClick(control, URL_), control.outerHTML.slice(0, 120)).toBeNull();
    }
  });
});

describe("no sidebar state ever yields a buy intent", () => {
  it.each([beforeHtml, afterPlusHtml, afterMinusHtml, beforeDeleteLastHtml, afterDeleteLastHtml])(
    "fixture %#",
    (html) => {
      for (const control of sidebar(html).querySelectorAll("*")) {
        const intent = classifyClick(control, URL_)?.intent;
        if (intent !== undefined) expect(EDIT_INTENTS.has(intent), intent).toBe(true);
      }
    },
  );
});
