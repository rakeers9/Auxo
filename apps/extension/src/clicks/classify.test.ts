import { afterEach, describe, expect, it } from "vitest";

import { classifyClick, classifySubmit, MAX_DEPTH, MAX_LABEL_LENGTH } from "./classify";
import { EDIT_INTENTS, EXCLUDED_PHRASES, GUESS_PHRASES, guessFromAction, normalize } from "./guess";
import type { ClickIntent } from "./known";

const SHOP = new URL("https://shop.example.com/products/lamp");

function html(markup: string): void {
  document.body.innerHTML = markup;
}

function el(selector: string): Element {
  const found = document.querySelector(selector);
  if (!found) throw new Error(`no ${selector}`);
  return found;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("classifyClick guesses", () => {
  const cases = (Object.entries(GUESS_PHRASES) as Array<[ClickIntent, string[]]>).flatMap(([intent, phrases]) =>
    phrases.map((phrase) => [intent, phrase] as const),
  );

  it.each(cases)("%s: button text %j", (intent, phrase) => {
    html(`<button>${phrase}</button>`);
    expect(classifyClick(el("button"), SHOP)).toEqual({ intent, source: "guess", label: phrase });
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    html("<button>\n   ADD To   Cart  \n</button>");
    expect(classifyClick(el("button"), SHOP)).toEqual({ intent: "add_to_cart", source: "guess", label: "ADD To Cart" });
  });

  it("ignores counts and symbols around the phrase", () => {
    html('<a href="/cart">Cart (3)</a><button>Checkout →</button>');
    expect(classifyClick(el("a"), SHOP)?.intent).toBe("view_cart");
    expect(classifyClick(el("button"), SHOP)?.intent).toBe("checkout");
  });

  it("needs the whole phrase, not a phrase inside other words", () => {
    html("<button>Learn more about checkout</button><button>Cartoon</button><button>Add to cart and save 10%</button>");
    for (const b of document.querySelectorAll("button")) expect(classifyClick(b, SHOP)).toBeNull();
  });

  it.each([
    ["aria-label", '<button aria-label="Add to cart"><svg></svg></button>'],
    ["value", '<input type="submit" value="Buy now">'],
    ["title", '<a href="/cart" title="View cart"><img src="cart.svg"></a>'],
    ["alt", '<input type="image" src="pay.png" alt="Place order">'],
  ])("reads the %s", (_attr, markup) => {
    html(markup);
    const target = el("button, input, a");
    expect(classifyClick(target, SHOP)?.source).toBe("guess");
  });

  it.each(["button", '[role="button"]', 'input[type="button"]', 'input[type="submit"]', 'input[type="image"]', "a"])(
    "treats %s as a control",
    (selector) => {
      const tag = selector.startsWith("input")
        ? `<input ${selector.slice(6, -1)} value="Buy now">`
        : selector === "a"
          ? '<a href="#">Buy now</a>'
          : selector === "button"
            ? "<button>Buy now</button>"
            : '<div role="button">Buy now</div>';
      html(tag);
      expect(classifyClick(el(selector), SHOP)?.intent).toBe("buy_now");
    },
  );

  it.each(EXCLUDED_PHRASES)("look-alike %j is never a buy intent", (phrase) => {
    html(`<button>${phrase}</button><button aria-label="${phrase}">Add to cart</button>`);
    for (const b of document.querySelectorAll("button")) {
      const intent = classifyClick(b, SHOP)?.intent;
      if (intent !== undefined) expect(EDIT_INTENTS.has(intent), intent).toBe(true);
    }
  });

  it.each(["Add to wishlist", "Add to Wish List", "Add to list", "Add to registry", "Move to wishlist"])(
    "%j is neither a buy intent nor a cart edit",
    (text) => {
      html(`<button>${text}</button>`);
      expect(classifyClick(el("button"), SHOP)).toBeNull();
    },
  );

  it.each([
    ["Save for later", "save_for_later"],
    ["Remove from cart", "remove_item"],
    ["Remove", "remove_item"],
    ["Delete", "remove_item"],
    ["delete item", "remove_item"],
  ] as const)("%j is a cart edit (%s), never a buy intent", (text, intent) => {
    html(`<button>${text}</button>`);
    expect(classifyClick(el("button"), SHOP)).toEqual({ intent, source: "guess", label: text });
  });

  it("a control labeled both 'Add to cart' and 'Remove' is remove_item, not add_to_cart", () => {
    html('<button aria-label="Remove">Add to cart</button>');
    expect(classifyClick(el("button"), SHOP)?.intent).toBe("remove_item");
  });

  it("+/− and 'Increase/Decrease quantity' are not guessed (product pages use them for how many to add)", () => {
    html("<button>+</button><button>−</button><button>Increase quantity</button><button>Decrease quantity</button>");
    for (const b of document.querySelectorAll("button")) expect(classifyClick(b, SHOP)).toBeNull();
  });

  it("an edit phrase still needs the whole label", () => {
    html("<button>Remove filters</button><button>Delete account</button><button>Save for later reading</button>");
    for (const b of document.querySelectorAll("button")) expect(classifyClick(b, SHOP)).toBeNull();
  });

  it("a nav link whose only text is a number is not a guess", () => {
    html('<a href="/cart"><span class="count">3</span></a>');
    expect(classifyClick(el(".count"), SHOP)).toBeNull();
  });

  it("a number-only nav link is view_cart when its aria-label says cart", () => {
    html('<a href="/cart" aria-label="3 items in cart"><span class="count">3</span></a>');
    expect(classifyClick(el(".count"), SHOP)).toEqual({ intent: "view_cart", source: "guess", label: "3 items in cart" });
  });
});

describe("walking up to the control", () => {
  it("finds the button from an inner span", () => {
    html('<button><span class="icon"></span><span class="text">Add to bag</span></button>');
    expect(classifyClick(el(".text"), SHOP)).toEqual({ intent: "add_to_cart", source: "guess", label: "Add to bag" });
  });

  it("finds the link from an inner img", () => {
    html('<a href="/checkout" aria-label="Checkout"><img src="x.png"></a>');
    expect(classifyClick(el("img"), SHOP)?.intent).toBe("checkout");
  });

  it("finds the button from a text node", () => {
    html("<button>Buy it now</button>");
    expect(classifyClick(el("button").firstChild, SHOP)?.intent).toBe("buy_now");
  });

  it("stops at the nearest control, not an outer one", () => {
    html('<a href="/p/1"><span>Lamp</span><button class="inner">Details</button></a>');
    expect(classifyClick(el(".inner"), SHOP)).toBeNull();
  });

  it(`looks at most ${MAX_DEPTH} ancestors up`, () => {
    // n wrapper spans put the button n + 1 levels above the target.
    const deep = (n: number) => "<span>".repeat(n) + '<i class="t"></i>' + "</span>".repeat(n);
    html(`<button>Add to cart${deep(MAX_DEPTH - 1)}</button>`);
    expect(classifyClick(el(".t"), SHOP)?.intent).toBe("add_to_cart");
    html(`<button>Add to cart${deep(MAX_DEPTH)}</button>`);
    expect(classifyClick(el(".t"), SHOP)).toBeNull();
  });

  it("returns null for non-controls and empty targets", () => {
    html("<div><p>Add to cart</p></div>");
    expect(classifyClick(el("p"), SHOP)).toBeNull();
    expect(classifyClick(null, SHOP)).toBeNull();
    expect(classifyClick(window, SHOP)).toBeNull();
    expect(classifyClick(document, SHOP)).toBeNull();
  });

  it("returns null for a control with no buy-intent label", () => {
    html('<button>Next image</button><a href="/help">Help</a><input type="text" value="Add to cart">');
    for (const node of document.querySelectorAll("button, a, input")) expect(classifyClick(node, SHOP)).toBeNull();
  });

  it("returns the label that matched, not a longer one", () => {
    html(`<button aria-label="Add to cart">${"x".repeat(300)}</button>`);
    expect(classifyClick(el("button"), SHOP)).toEqual({ intent: "add_to_cart", source: "guess", label: "Add to cart" });
  });

  it(`caps the label at ${MAX_LABEL_LENGTH} characters`, () => {
    html(`<a id="nav-cart">${"Cart ".repeat(100)}</a>`);
    const result = classifyClick(el("a"), new URL("https://www.amazon.com/"));
    expect(result?.source).toBe("known");
    expect(result?.label?.length).toBeLessThanOrEqual(MAX_LABEL_LENGTH);
    expect(result?.label?.startsWith("Cart Cart")).toBe(true);
  });

  it("omits the label when the control has no text", () => {
    html('<a id="nav-cart"><span class="icon"></span></a>');
    expect(classifyClick(el(".icon"), new URL("https://www.amazon.com/"))).toEqual({
      intent: "view_cart",
      source: "known",
    });
  });
});

describe("classifySubmit", () => {
  it("guesses from the submitter's label", () => {
    html('<form action="/somewhere"><button type="submit">Place your order</button></form>');
    expect(classifySubmit(el("form") as HTMLFormElement, el("button"), SHOP)).toEqual({
      intent: "place_order",
      source: "guess",
      label: "Place your order",
    });
  });

  it.each([
    ["/cart/add", "add_to_cart"],
    ["/cart/add.js", "add_to_cart"],
    ["https://shop.example.com/cart/add?id=1", "add_to_cart"],
    ["/en-us/cart/add-to-cart/ref=x", "add_to_cart"],
    ["/checkout", "checkout"],
    ["/checkouts/abc", null],
    ["/checkout/start", "checkout"],
    ["/cart", null],
    ["/cart/change", null],
    ["/search", null],
  ] as const)("form action %s → %s", (action, intent) => {
    html(`<form action="${action}"><button type="submit">Go</button></form>`);
    const result = classifySubmit(el("form") as HTMLFormElement, el("button"), SHOP);
    expect(result?.intent ?? null).toBe(intent);
    if (result) expect(result.source).toBe("guess");
  });

  it("uses the submitter's formaction over the form's action", () => {
    html('<form action="/search"><button type="submit" formaction="/cart/add">Go</button></form>');
    expect(classifySubmit(el("form") as HTMLFormElement, el("button"), SHOP)).toEqual({
      intent: "add_to_cart",
      source: "guess",
      label: "Go",
    });
  });

  it("uses the form action when there is no submitter", () => {
    html('<form action="/cart/add"><input name="id" value="1"></form>');
    expect(classifySubmit(el("form") as HTMLFormElement, null, SHOP)).toEqual({ intent: "add_to_cart", source: "guess" });
  });

  it("an excluded submitter beats the form action", () => {
    html('<form action="/cart/add"><button type="submit">Add to wishlist</button></form>');
    expect(classifySubmit(el("form") as HTMLFormElement, el("button"), SHOP)).toBeNull();
  });

  it("a Remove / Save for later submitter is a cart edit, even in a /cart/add form", () => {
    html('<form action="/cart/add"><button type="submit" class="r">Remove</button><button type="submit" class="s">Save for later</button></form>');
    const form = el("form") as HTMLFormElement;
    expect(classifySubmit(form, el(".r"), SHOP)).toEqual({ intent: "remove_item", source: "guess", label: "Remove" });
    expect(classifySubmit(form, el(".s"), SHOP)).toEqual({
      intent: "save_for_later",
      source: "guess",
      label: "Save for later",
    });
  });

  it("returns null for an unrelated form", () => {
    html('<form action="/newsletter"><button type="submit">Subscribe</button></form>');
    expect(classifySubmit(el("form") as HTMLFormElement, el("button"), SHOP)).toBeNull();
    html("<form><button>Subscribe</button></form>");
    expect(classifySubmit(el("form") as HTMLFormElement, el("button"), SHOP)).toBeNull();
  });
});

describe("guess helpers", () => {
  it("normalize keeps letters only", () => {
    expect(normalize("  Cart (3) → ")).toBe("cart");
    expect(normalize("42")).toBe("");
  });

  it("guessFromAction is case-insensitive", () => {
    expect(guessFromAction("/CART/ADD")).toBe("add_to_cart");
  });
});
