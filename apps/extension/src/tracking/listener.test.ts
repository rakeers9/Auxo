import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClickSignal } from "../messages";
import { listenForBuyIntents, type BuyIntentClassifiers } from "./listener";

const URL_ = new URL("https://www.amazon.com/dp/B0TEST0001");
const signal: ClickSignal = { intent: "add_to_cart", source: "known", label: "Add to Cart" };

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  document.body.innerHTML = "";
});

function setup(classifiers: Partial<BuyIntentClassifiers> = {}) {
  document.body.innerHTML = '<form id="f" action="/cart/add"><button id="b"><span id="s">Add</span></button></form><a id="other">x</a>';
  const onSignal = vi.fn<(s: ClickSignal) => void>();
  const all: BuyIntentClassifiers = {
    classifyClick: vi.fn((target) => ((target as Element | null)?.id === "s" ? signal : null)),
    classifySubmit: vi.fn(() => null),
    ...classifiers,
  };
  stop = listenForBuyIntents(document, all, onSignal, () => URL_);
  return { onSignal, all };
}

describe("listenForBuyIntents", () => {
  it("reports a classified click with the real target and URL", () => {
    const { onSignal, all } = setup();
    document.getElementById("s")!.click();

    expect(all.classifyClick).toHaveBeenCalledWith(document.getElementById("s"), URL_);
    expect(onSignal).toHaveBeenCalledWith(signal);
  });

  it("ignores clicks that aren't buy intents", () => {
    const { onSignal } = setup();
    document.getElementById("other")!.click();

    expect(onSignal).not.toHaveBeenCalled();
  });

  it("hears the click before the page's own handlers, and never blocks it", () => {
    const order: string[] = [];
    const { onSignal } = setup();
    onSignal.mockImplementation(() => order.push("auxo"));
    const span = document.getElementById("s")!;
    span.addEventListener("click", (event) => {
      order.push("page");
      expect(event.defaultPrevented).toBe(false);
    });

    span.click();
    expect(order).toEqual(["auxo", "page"]);
  });

  it("reports form submits with the submitter", () => {
    const submitSignal: ClickSignal = { intent: "add_to_cart", source: "guess" };
    const { onSignal, all } = setup({ classifySubmit: vi.fn(() => submitSignal) });
    const form = document.getElementById("f") as HTMLFormElement;
    form.addEventListener("submit", (event) => event.preventDefault());

    form.requestSubmit(document.getElementById("b") as HTMLButtonElement);
    expect(all.classifySubmit).toHaveBeenCalledWith(form, document.getElementById("b"), URL_);
    expect(onSignal).toHaveBeenCalledWith(submitSignal);
  });

  it("counts a click and the submit it causes as one action", () => {
    let t = 0;
    const onSignal = vi.fn<(s: ClickSignal) => void>();
    document.body.innerHTML = '<form id="f"><button id="b">Buy</button></form>';
    const form = document.getElementById("f") as HTMLFormElement;
    form.addEventListener("submit", (event) => event.preventDefault());
    const buy: ClickSignal = { intent: "buy_now", source: "known" };
    stop = listenForBuyIntents(document, { classifyClick: () => buy, classifySubmit: () => buy }, onSignal, () => URL_, () => t);

    document.getElementById("b")!.click(); // click, then the submit it triggers
    expect(onSignal).toHaveBeenCalledTimes(1);

    t = 1_500;
    document.getElementById("b")!.click();
    expect(onSignal).toHaveBeenCalledTimes(2);
  });

  it("never merges two real clicks, so fast repeated + taps all count", () => {
    const onSignal = vi.fn<(s: ClickSignal) => void>();
    document.body.innerHTML = '<button id="plus">+</button>';
    stop = listenForBuyIntents(
      document,
      { classifyClick: () => ({ intent: "increase_qty", source: "known" }), classifySubmit: () => null },
      onSignal,
      () => URL_,
      () => 0,
    );

    for (let i = 0; i < 3; i += 1) document.getElementById("plus")!.click();
    expect(onSignal).toHaveBeenCalledTimes(3);
  });

  it("reports quantity dropdown changes", () => {
    const onSignal = vi.fn<(s: ClickSignal) => void>();
    document.body.innerHTML = '<select id="qty"><option value="1" selected>1</option><option value="2">2</option></select>';
    const classifyChange = vi.fn(() => ({ intent: "increase_qty" as const, source: "known" as const }));
    stop = listenForBuyIntents(document, { classifyClick: () => null, classifySubmit: () => null, classifyChange }, onSignal, () => URL_);

    const select = document.getElementById("qty") as HTMLSelectElement;
    select.value = "2";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    expect(classifyChange).toHaveBeenCalledWith(select, URL_);
    expect(onSignal).toHaveBeenCalledWith({ intent: "increase_qty", source: "known" });
  });

  it("does not merge different intents that happen close together", () => {
    let t = 0;
    const onSignal = vi.fn<(s: ClickSignal) => void>();
    document.body.innerHTML = '<button id="a">A</button><button id="c">C</button>';
    stop = listenForBuyIntents(
      document,
      {
        classifyClick: (target) =>
          (target as Element).id === "a" ? { intent: "add_to_cart", source: "known" } : { intent: "view_cart", source: "known" },
        classifySubmit: () => null,
      },
      onSignal,
      () => URL_,
      () => t,
    );

    document.getElementById("a")!.click();
    t = 10;
    document.getElementById("c")!.click();
    expect(onSignal).toHaveBeenCalledTimes(2);
  });

  it("stops a click the gate blocks: the page never sees it, and nothing is replayed", () => {
    document.body.innerHTML = '<a id="buy" href="#go"><span id="inner">Place your order</span></a>';
    const onSignal = vi.fn<(s: ClickSignal) => void>();
    const onBlocked = vi.fn<(s: ClickSignal) => void>();
    const place: ClickSignal = { intent: "place_order", source: "known", label: "Place your order" };
    const pageHandler = vi.fn();
    document.getElementById("buy")!.addEventListener("click", pageHandler);
    stop = listenForBuyIntents(
      document,
      { classifyClick: () => place, classifySubmit: () => null },
      onSignal,
      () => URL_,
      () => 0,
      { shouldBlock: () => true, onBlocked },
    );

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    document.getElementById("inner")!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(pageHandler).not.toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalledWith(place);
    expect(onSignal).not.toHaveBeenCalled();
  });

  it("lets the click through untouched when the gate allows it", () => {
    document.body.innerHTML = '<button id="b">Place your order</button>';
    const onSignal = vi.fn<(s: ClickSignal) => void>();
    const pageHandler = vi.fn();
    document.getElementById("b")!.addEventListener("click", pageHandler);
    const place: ClickSignal = { intent: "place_order", source: "known" };
    stop = listenForBuyIntents(document, { classifyClick: () => place, classifySubmit: () => null }, onSignal, () => URL_, () => 0, {
      shouldBlock: () => false,
      onBlocked: vi.fn(),
    });

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    document.getElementById("b")!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(pageHandler).toHaveBeenCalledTimes(1);
    expect(onSignal).toHaveBeenCalledWith(place);
  });

  it("never blocks when the gate throws", () => {
    document.body.innerHTML = '<button id="b">Buy</button>';
    const pageHandler = vi.fn();
    document.getElementById("b")!.addEventListener("click", pageHandler);
    stop = listenForBuyIntents(
      document,
      { classifyClick: () => ({ intent: "buy_now", source: "known" }), classifySubmit: () => null },
      vi.fn(),
      () => URL_,
      () => 0,
      {
        shouldBlock: () => {
          throw new Error("bug");
        },
        onBlocked: vi.fn(),
      },
    );

    document.getElementById("b")!.click();
    expect(pageHandler).toHaveBeenCalledTimes(1);
  });

  it("a blocked submit button doesn't submit its form", () => {
    document.body.innerHTML = '<form id="f"><input id="go" type="submit" value="Proceed to checkout"></form>';
    const submitted = vi.fn((event: Event) => event.preventDefault());
    document.getElementById("f")!.addEventListener("submit", submitted);
    const checkout: ClickSignal = { intent: "checkout", source: "known" };
    stop = listenForBuyIntents(document, { classifyClick: () => checkout, classifySubmit: () => checkout }, vi.fn(), () => URL_, () => 0, {
      shouldBlock: () => true,
      onBlocked: vi.fn(),
    });

    document.getElementById("go")!.click();
    expect(submitted).not.toHaveBeenCalled();
  });

  it("swallows classifier and handler errors", () => {
    const { onSignal } = setup({
      classifyClick: () => {
        throw new Error("bug");
      },
    });
    expect(() => document.getElementById("s")!.click()).not.toThrow();
    expect(onSignal).not.toHaveBeenCalled();

    stop?.();
    const second = setup();
    second.onSignal.mockImplementation(() => {
      throw new Error("bug");
    });
    expect(() => document.getElementById("s")!.click()).not.toThrow();
  });

  it("stops listening", () => {
    const { onSignal } = setup();
    stop?.();
    stop = undefined;
    document.getElementById("s")!.click();

    expect(onSignal).not.toHaveBeenCalled();
  });
});
