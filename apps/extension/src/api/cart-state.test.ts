import { describe, expect, it } from "vitest";

import type { CartDraft } from "../messages";
import { CART_STATE_KEY, createCartState, diffCarts } from "./cart-state";
import type { KeyValueArea } from "./decision-memory";

function memoryArea(initial: Record<string, unknown> = {}): KeyValueArea & { data: Record<string, unknown> } {
  const data = { ...initial };
  return {
    data,
    get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
    set: async (items) => {
      Object.assign(data, structuredClone(items));
    },
  };
}

function cart(items: CartDraft["items"], merchant = "amazon.com"): CartDraft {
  return {
    merchant,
    items,
    total_minor: items.reduce((sum, item) => sum + item.price_minor * item.qty, 0),
    currency: "USD",
    url: "https://www.amazon.com/gp/cart/view.html",
  };
}

const mug = { name: "Mug", price_minor: 999, qty: 3 };
const lamp = { name: "Lamp", price_minor: 3399, qty: 1 };

describe("createCartState", () => {
  it("stores the first load and reports nothing", async () => {
    const area = memoryArea();
    const state = createCartState(area);

    expect(await state.compareAtLoad("amazon.com", cart([mug, lamp]))).toBeNull();
    expect((area.data[CART_STATE_KEY] as Record<string, CartDraft>)["amazon.com"]).toEqual(cart([mug, lamp]));
  });

  it("reports an item removed elsewhere on the next load, and stores the new cart", async () => {
    const state = createCartState(memoryArea());
    await state.compareAtLoad("amazon.com", cart([mug, lamp]));

    const change = await state.compareAtLoad("amazon.com", cart([mug]));

    expect(change).toEqual({
      before: cart([mug, lamp]),
      after: cart([mug]),
      diff: { removed: [lamp], added: [], repriced: [] },
    });
    expect(await state.compareAtLoad("amazon.com", cart([mug]))).toBeNull();
  });

  it("reports items added and quantities changed elsewhere", async () => {
    const state = createCartState(memoryArea());
    await state.compareAtLoad("amazon.com", cart([mug]));

    const change = await state.compareAtLoad("amazon.com", cart([{ ...mug, qty: 1 }, lamp]));

    expect(change?.diff).toEqual({ removed: [{ ...mug, qty: 2 }], added: [lamp], repriced: [] });
  });

  it("doesn't report a change this tab already reported", async () => {
    const state = createCartState(memoryArea());
    await state.compareAtLoad("amazon.com", cart([mug, lamp]));

    // The sidebar watcher reported the lamp's removal, then recorded the cart.
    await state.record("amazon.com", cart([mug]));

    expect(await state.compareAtLoad("amazon.com", cart([mug]))).toBeNull();
  });

  it("reports everything removed when the cart was emptied elsewhere", async () => {
    const state = createCartState(memoryArea());
    await state.compareAtLoad("amazon.com", cart([mug, lamp]));

    const change = await state.compareAtLoad("amazon.com", cart([]));

    expect(change?.diff).toEqual({ removed: [mug, lamp], added: [], repriced: [] });
    expect(change?.after.items).toEqual([]);
  });

  it("keeps each merchant's cart separate", async () => {
    const state = createCartState(memoryArea());
    await state.compareAtLoad("amazon.com", cart([mug, lamp]));
    await state.compareAtLoad("ebay.com", cart([lamp], "ebay.com"));

    expect(await state.compareAtLoad("ebay.com", cart([lamp], "ebay.com"))).toBeNull();
    expect((await state.compareAtLoad("amazon.com", cart([lamp])))?.diff.removed).toEqual([mug]);
  });

  it("survives a worker restart (a new state on the same storage)", async () => {
    const area = memoryArea();
    await createCartState(area).compareAtLoad("amazon.com", cart([mug, lamp]));

    expect((await createCartState(area).compareAtLoad("amazon.com", cart([mug])))?.diff.removed).toEqual([lamp]);
  });

  it("compares two tabs loading at once one after the other", async () => {
    const state = createCartState(memoryArea());
    await state.compareAtLoad("amazon.com", cart([mug, lamp]));

    const [first, second] = await Promise.all([
      state.compareAtLoad("amazon.com", cart([mug])),
      state.compareAtLoad("amazon.com", cart([mug])),
    ]);

    expect(first?.diff.removed).toEqual([lamp]);
    expect(second).toBeNull();
  });

  it("returns null and never throws on broken storage", async () => {
    const broken: KeyValueArea = {
      get: async () => {
        throw new Error("storage gone");
      },
      set: async () => {
        throw new Error("storage gone");
      },
    };
    const state = createCartState(broken);

    await expect(state.compareAtLoad("amazon.com", cart([mug]))).resolves.toBeNull();
    await expect(state.record("amazon.com", cart([mug]))).resolves.toBeUndefined();
    await expect(state.compareAtLoad("amazon.com", cart([]))).resolves.toBeNull();
  });

  it("treats bad stored data as nothing known, per merchant", async () => {
    const area = memoryArea({ [CART_STATE_KEY]: { "amazon.com": { items: "nope" }, "ebay.com": cart([lamp], "ebay.com") } });
    const state = createCartState(area);

    expect(await state.compareAtLoad("amazon.com", cart([mug]))).toBeNull();
    expect((await state.compareAtLoad("ebay.com", cart([], "ebay.com")))?.diff.removed).toEqual([lamp]);
    expect(await createCartState(memoryArea({ [CART_STATE_KEY]: ["not", "a", "map"] })).compareAtLoad("amazon.com", cart([mug]))).toBeNull();
  });

  it("ignores an invalid cart or merchant without storing it", async () => {
    const area = memoryArea();
    const state = createCartState(area);
    await state.compareAtLoad("amazon.com", cart([mug]));

    const bad = { ...cart([mug]), items: [{ name: "Mug", price_minor: 9.99, qty: 3 }] };
    expect(await state.compareAtLoad("amazon.com", bad)).toBeNull();
    await state.record("", cart([lamp]));

    expect(area.data[CART_STATE_KEY]).toEqual({ "amazon.com": cart([mug]) });
  });

  it("reports a price-only change as repriced, not as a removal and an add", async () => {
    const state = createCartState(memoryArea());
    await state.compareAtLoad("amazon.com", cart([mug, lamp]));

    const change = await state.compareAtLoad("amazon.com", cart([{ ...mug, price_minor: 849 }, lamp]));

    expect(change?.diff).toEqual({
      removed: [],
      added: [],
      repriced: [{ name: "Mug", before_minor: 999, after_minor: 849 }],
    });
  });
});

describe("diffCarts", () => {
  it("counts quantity changes on a repriced item, removed at the old price and added at the new", () => {
    expect(diffCarts(cart([mug]), cart([{ ...mug, price_minor: 849, qty: 1 }]))).toEqual({
      removed: [{ name: "Mug", price_minor: 999, qty: 2 }],
      added: [],
      repriced: [{ name: "Mug", before_minor: 999, after_minor: 849 }],
    });
    expect(diffCarts(cart([mug]), cart([{ ...mug, price_minor: 1099, qty: 5 }]))).toEqual({
      removed: [],
      added: [{ name: "Mug", price_minor: 1099, qty: 2 }],
      repriced: [{ name: "Mug", before_minor: 999, after_minor: 1099 }],
    });
  });

  it("treats a price change to or from zero as a reprice", () => {
    expect(diffCarts(cart([{ ...mug, price_minor: 0 }]), cart([mug])).repriced).toEqual([
      { name: "Mug", before_minor: 0, after_minor: 999 },
    ]);
  });

  it("falls back to name and price when a name is listed twice", () => {
    const small = { name: "Shirt", price_minor: 1500, qty: 1 };
    const large = { name: "Shirt", price_minor: 1800, qty: 1 };

    // Two lines named "Shirt" before: which one changed price can't be known.
    expect(diffCarts(cart([small, large]), cart([{ ...small, price_minor: 1400 }]))).toEqual({
      removed: [small, large],
      added: [{ ...small, price_minor: 1400 }],
      repriced: [],
    });
  });

  it("finds nothing when only the order differs", () => {
    expect(diffCarts(cart([mug, lamp]), cart([lamp, mug]))).toEqual({ removed: [], added: [], repriced: [] });
  });
});
