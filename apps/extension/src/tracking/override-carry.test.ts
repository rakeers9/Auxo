import type { Trigger } from "@auxo/shared";
import { beforeEach, describe, expect, it } from "vitest";

import { CARRY_FALLBACK_MS, createOverrideCarry } from "./override-carry";

const T0 = Date.parse("2026-11-06T12:00:00Z");
const PASS_EXPIRY = T0 + 10 * 60_000;

const CART = { merchant: "amazon.com", cartHash: "a".repeat(64) };
const OTHER_CART = { merchant: "amazon.com", cartHash: "b".repeat(64) };

const ID = {
  cart: "11111111-1111-4111-8111-111111111111",
  checkout: "22222222-2222-4222-8222-222222222222",
  other: "33333333-3333-4333-8333-333333333333",
};

function trigger(intent: Trigger["intent"], page_type: Trigger["page_type"] = "cart"): Trigger {
  return { intent, source: intent === "page_view" ? "page" : "known", page_type, occurred_at: new Date(T0).toISOString() };
}

let clock = T0;
const now = () => clock;

beforeEach(() => {
  sessionStorage.clear();
  clock = T0;
});

// Each "page" makes its own carry, the way each content script load does.
const page = (storage: Storage | null = sessionStorage) => createOverrideCarry(storage, now);

describe("createOverrideCarry", () => {
  it("an override on the cart page covers the same cart's new decision on the checkout page", () => {
    const cartPage = page();
    expect(cartPage.decided(ID.cart, CART, trigger("page_view"))).toBeUndefined();
    cartPage.overrode(ID.cart, PASS_EXPIRY);

    const checkoutPage = page();
    expect(checkoutPage.decided(ID.checkout, CART, trigger("checkout", "checkout"))).toBe(PASS_EXPIRY);
    expect(checkoutPage.covers(ID.checkout)).toBe(true);
  });

  it("covers a same-cart re-check on the same page", () => {
    const p = page();
    p.decided(ID.cart, CART, trigger("page_view"));
    p.overrode(ID.cart, PASS_EXPIRY);

    expect(p.decided(ID.checkout, CART, trigger("checkout"))).toBe(PASS_EXPIRY);
    expect(p.covers(ID.checkout)).toBe(true);
  });

  it("doesn't cover a different cart", () => {
    const cartPage = page();
    cartPage.decided(ID.cart, CART, trigger("page_view"));
    cartPage.overrode(ID.cart, PASS_EXPIRY);

    const next = page();
    expect(next.decided(ID.other, OTHER_CART, trigger("add_to_cart", "product"))).toBeUndefined();
    expect(next.covers(ID.other)).toBe(false);
  });

  it("doesn't cover the same items at another store", () => {
    const p = page();
    p.decided(ID.cart, CART, trigger("page_view"));
    p.overrode(ID.cart, PASS_EXPIRY);

    expect(page().decided(ID.other, { ...CART, merchant: "example.com" }, trigger("page_view"))).toBeUndefined();
  });

  it("stops covering when the pass expires", () => {
    const p = page();
    p.decided(ID.cart, CART, trigger("page_view"));
    p.overrode(ID.cart, PASS_EXPIRY);

    clock = PASS_EXPIRY;
    const later = page();
    expect(later.decided(ID.checkout, CART, trigger("checkout", "checkout"))).toBeUndefined();
    expect(later.covers(ID.checkout)).toBe(false);
  });

  it("an override with no pass (failed open) carries for the fallback window", () => {
    const p = page();
    p.decided(ID.cart, CART, trigger("page_view"));
    p.overrode(ID.cart);

    clock = T0 + CARRY_FALLBACK_MS - 1;
    expect(page().decided(ID.checkout, CART, trigger("checkout", "checkout"))).toBe(T0 + CARRY_FALLBACK_MS);
    clock = T0 + CARRY_FALLBACK_MS;
    expect(page().decided(ID.other, CART, trigger("checkout", "checkout"))).toBeUndefined();
  });

  it("removing items from an overridden cart keeps it covered", () => {
    const p = page();
    p.decided(ID.cart, CART, trigger("page_view"));
    p.overrode(ID.cart, PASS_EXPIRY);

    // The removal's decision is about the smaller cart.
    expect(p.decided(ID.other, OTHER_CART, trigger("remove_item"))).toBe(PASS_EXPIRY);
    expect(p.covers(ID.other)).toBe(true);

    // And the smaller cart stays covered on the next page.
    expect(page().decided(ID.checkout, OTHER_CART, trigger("checkout", "checkout"))).toBe(PASS_EXPIRY);
  });

  it("adding items to an overridden cart is decided again", () => {
    const p = page();
    p.decided(ID.cart, CART, trigger("page_view"));
    p.overrode(ID.cart, PASS_EXPIRY);

    expect(p.decided(ID.other, OTHER_CART, trigger("increase_qty"))).toBeUndefined();
    expect(p.covers(ID.other)).toBe(false);
  });

  it("removing items from a cart nobody overrode is decided again", () => {
    const p = page();
    p.decided(ID.cart, CART, trigger("page_view"));

    expect(p.decided(ID.other, OTHER_CART, trigger("remove_item"))).toBeUndefined();
  });

  it("a later override of the same cart extends it; an earlier one doesn't shorten it", () => {
    const first = page();
    first.decided(ID.cart, CART, trigger("page_view"));
    first.overrode(ID.cart, PASS_EXPIRY);

    const second = page();
    second.decided(ID.checkout, CART, trigger("checkout", "checkout"));
    second.overrode(ID.checkout, PASS_EXPIRY + 60_000);
    expect(page().decided(ID.other, CART, trigger("page_view"))).toBe(PASS_EXPIRY + 60_000);

    const third = page();
    third.decided(ID.other, CART, trigger("page_view"));
    third.overrode(ID.other, T0 + 60_000);
    expect(page().decided(ID.cart, CART, trigger("page_view"))).toBe(PASS_EXPIRY + 60_000);
  });

  it("an override of a decision it never saw is ignored", () => {
    const p = page();
    p.overrode(ID.cart, PASS_EXPIRY);

    expect(page().decided(ID.checkout, CART, trigger("checkout", "checkout"))).toBeUndefined();
  });

  it("without sessionStorage, still covers re-checks on the same page", () => {
    const p = page(null);
    p.decided(ID.cart, CART, trigger("page_view"));
    p.overrode(ID.cart, PASS_EXPIRY);

    expect(p.decided(ID.checkout, CART, trigger("checkout"))).toBe(PASS_EXPIRY);
    expect(page(null).decided(ID.other, CART, trigger("checkout", "checkout"))).toBeUndefined();
  });

  it("ignores unreadable saved data and storage that throws", () => {
    sessionStorage.setItem("auxo:overrides", "not json");
    expect(page().decided(ID.cart, CART, trigger("page_view"))).toBeUndefined();

    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    } as unknown as Storage;
    const p = page(throwing);
    p.decided(ID.cart, CART, trigger("page_view"));
    expect(() => p.overrode(ID.cart, PASS_EXPIRY)).not.toThrow();
    expect(p.decided(ID.checkout, CART, trigger("checkout"))).toBe(PASS_EXPIRY);
  });
});
