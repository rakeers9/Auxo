import { describe, expect, it } from "vitest";

import type { KeyValueArea } from "../api/decision-memory";
import { createWishlist, WISHLIST_KEY, type NewWishlistEntry } from "./store";

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

function item(name: string, price_minor: number, overrides: Partial<NewWishlistEntry> = {}): NewWishlistEntry {
  return {
    name,
    price_minor,
    qty: 1,
    currency: "USD",
    merchant: "amazon.com",
    url: "https://www.amazon.com/gp/cart/view.html",
    ...overrides,
  };
}

// A clock that moves one minute per call, and predictable ids.
function deps() {
  let minute = 0;
  let id = 0;
  return {
    now: () => new Date(Date.UTC(2026, 9, 4, 12, minute++)),
    newId: () => `id-${++id}`,
  };
}

const mug = item("Mug", 999);
const lamp = item("Lamp", 3399);

describe("createWishlist", () => {
  it("lists saved items newest first", async () => {
    const wishlist = createWishlist(memoryArea(), deps());

    await wishlist.add([mug]);
    await wishlist.add([lamp]);

    expect((await wishlist.list()).map((entry) => entry.name)).toEqual(["Lamp", "Mug"]);
  });

  it("keeps the given order within one save, first on top", async () => {
    const wishlist = createWishlist(memoryArea(), deps());

    await wishlist.add([mug, lamp]);

    expect((await wishlist.list()).map((entry) => entry.name)).toEqual(["Mug", "Lamp"]);
  });

  it("stores every field, with an id and the save time", async () => {
    const wishlist = createWishlist(memoryArea(), deps());

    const list = await wishlist.add([{ ...mug, qty: 2, decision_id: "6f1c2b8e-3d4a-4c5b-9e7f-0a1b2c3d4e5f" }]);

    expect(list).toEqual([
      {
        id: "id-1",
        name: "Mug",
        price_minor: 999,
        qty: 2,
        currency: "USD",
        merchant: "amazon.com",
        url: "https://www.amazon.com/gp/cart/view.html",
        decision_id: "6f1c2b8e-3d4a-4c5b-9e7f-0a1b2c3d4e5f",
        saved_at: "2026-10-04T12:00:00.000Z",
      },
    ]);
  });

  it("moves an item saved again to the top with the new quantity and time", async () => {
    const wishlist = createWishlist(memoryArea(), deps());
    await wishlist.add([mug]);
    await wishlist.add([lamp]);

    const list = await wishlist.add([{ ...mug, qty: 3 }]);

    expect(list.map((entry) => [entry.id, entry.name, entry.qty, entry.saved_at])).toEqual([
      ["id-1", "Mug", 3, "2026-10-04T12:02:00.000Z"],
      ["id-2", "Lamp", 1, "2026-10-04T12:01:00.000Z"],
    ]);
  });

  it("keeps the old decision link when an item is saved again without one", async () => {
    const wishlist = createWishlist(memoryArea(), deps());
    await wishlist.add([{ ...mug, decision_id: "first" }]);

    expect((await wishlist.add([mug]))[0]?.decision_id).toBe("first");
    expect((await wishlist.add([{ ...mug, decision_id: "second" }]))[0]?.decision_id).toBe("second");
  });

  it("treats the same name at another price or store as a different item", async () => {
    const wishlist = createWishlist(memoryArea(), deps());

    await wishlist.add([mug, { ...mug, price_minor: 899 }, { ...mug, merchant: "ebay.com" }]);

    expect(await wishlist.list()).toHaveLength(3);
  });

  it("keeps at most the limit, dropping the oldest", async () => {
    const wishlist = createWishlist(memoryArea(), { ...deps(), limit: 3 });

    for (const name of ["a", "b", "c", "d"]) await wishlist.add([item(name, 100)]);

    expect((await wishlist.list()).map((entry) => entry.name)).toEqual(["d", "c", "b"]);
  });

  it("caps at 200 by default", async () => {
    const wishlist = createWishlist(memoryArea(), deps());

    await wishlist.add(Array.from({ length: 205 }, (_, i) => item(`item ${i}`, 100)));

    const list = await wishlist.list();
    expect(list).toHaveLength(200);
    expect(list[0]?.name).toBe("item 0");
  });

  it("removes one item by id and clears all", async () => {
    const wishlist = createWishlist(memoryArea(), deps());
    const [first] = await wishlist.add([mug, lamp]);

    expect((await wishlist.remove(first!.id)).map((entry) => entry.name)).toEqual(["Lamp"]);
    await wishlist.clear();
    expect(await wishlist.list()).toEqual([]);
  });

  it("serializes quick saves so none is lost", async () => {
    const wishlist = createWishlist(memoryArea(), deps());

    await Promise.all([wishlist.add([mug]), wishlist.add([lamp]), wishlist.add([item("Pen", 150)])]);

    expect((await wishlist.list()).map((entry) => entry.name)).toEqual(["Pen", "Lamp", "Mug"]);
  });

  it("survives on the same storage (a new popup or worker)", async () => {
    const area = memoryArea();
    await createWishlist(area, deps()).add([mug]);

    expect((await createWishlist(area).list()).map((entry) => entry.name)).toEqual(["Mug"]);
  });

  it("drops invalid entries, not the whole list", async () => {
    const wishlist = createWishlist(memoryArea(), deps());

    const list = await wishlist.add([mug, item("", 100), item("Half", 9.5), item("None", 100, { qty: 0 })]);

    expect(list.map((entry) => entry.name)).toEqual(["Mug"]);
  });

  it("treats broken storage or bad data as empty, without throwing", async () => {
    const throwing: KeyValueArea = {
      get: async () => {
        throw new Error("storage gone");
      },
      set: async () => {
        throw new Error("storage gone");
      },
    };
    const broken = createWishlist(throwing, deps());
    await expect(broken.add([mug])).resolves.toEqual([]);
    await expect(broken.remove("x")).resolves.toEqual([]);
    await expect(broken.list()).resolves.toEqual([]);
    await expect(broken.clear()).resolves.toBeUndefined();

    const garbage = createWishlist(memoryArea({ [WISHLIST_KEY]: "not a list" }), deps());
    expect(await garbage.list()).toEqual([]);

    const mixed = createWishlist(memoryArea({ [WISHLIST_KEY]: [{ id: "x" }, null, 7] }), deps());
    expect(await mixed.list()).toEqual([]);
    expect((await mixed.add([mug])).map((entry) => entry.name)).toEqual(["Mug"]);
  });

  it("keeps the list as it was when a write fails", async () => {
    const area = memoryArea();
    const wishlist = createWishlist(area, deps());
    await wishlist.add([mug]);
    area.set = async () => {
      throw new Error("quota exceeded");
    };

    expect((await wishlist.add([lamp])).map((entry) => entry.name)).toEqual(["Mug"]);
    expect((await wishlist.list()).map((entry) => entry.name)).toEqual(["Mug"]);
  });
});
