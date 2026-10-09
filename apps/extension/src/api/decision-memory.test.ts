import { describe, expect, it } from "vitest";

import { createDecisionMemory, type KeyValueArea, type RememberedCart } from "./decision-memory";

function memoryArea(): KeyValueArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
    set: async (items) => {
      Object.assign(data, structuredClone(items));
    },
  };
}

const mug = { name: "Mug", price_minor: 999, qty: 2 };
const lamp = { name: "Lamp", price_minor: 3399, qty: 1 };
const cart = (items: RememberedCart["items"]): RememberedCart => ({
  merchant: "amazon.com",
  currency: "USD",
  url: "https://www.amazon.com/gp/cart/view.html",
  items,
});

describe("createDecisionMemory", () => {
  it("finds the decision that covered an item", async () => {
    const m = createDecisionMemory(memoryArea());
    await m.remember("a", cart([mug]));
    await m.remember("b", cart([lamp]));

    expect(await m.decisionFor([mug])).toBe("a");
    expect(await m.decisionFor([lamp])).toBe("b");
  });

  it("prefers the most recent decision that included the item", async () => {
    const m = createDecisionMemory(memoryArea());
    await m.remember("a", cart([mug]));
    await m.remember("b", cart([mug, lamp]));

    expect(await m.decisionFor([mug])).toBe("b");
  });

  it("returns the cart a decision was about", async () => {
    const m = createDecisionMemory(memoryArea());
    await m.remember("a", cart([mug, lamp]));

    expect(await m.cartFor("a")).toEqual(cart([mug, lamp]));
    expect(await m.cartFor("nope")).toBeNull();
  });

  it("matches on name and unit price", async () => {
    const m = createDecisionMemory(memoryArea());
    await m.remember("a", cart([mug]));

    expect(await m.decisionFor([{ name: "Mug", price_minor: 899 }])).toBeNull();
    expect(await m.decisionFor([{ name: "Cup", price_minor: 999 }])).toBeNull();
  });

  it("survives a worker restart (a new memory on the same storage)", async () => {
    const area = memoryArea();
    await createDecisionMemory(area).remember("a", cart([mug]));

    expect(await createDecisionMemory(area).decisionFor([mug])).toBe("a");
  });

  it("keeps only the newest entries", async () => {
    const m = createDecisionMemory(memoryArea(), 2);
    await m.remember("a", cart([mug]));
    await m.remember("b", cart([lamp]));
    await m.remember("c", cart([{ name: "Pen", price_minor: 100, qty: 1 }]));

    expect(await m.decisionFor([mug])).toBeNull();
    expect(await m.decisionFor([lamp])).toBe("b");
  });

  it("doesn't lose writes made back to back", async () => {
    const m = createDecisionMemory(memoryArea());
    void m.remember("a", cart([mug]));
    void m.remember("b", cart([lamp]));

    expect(await m.decisionFor([mug])).toBe("a");
    expect(await m.decisionFor([lamp])).toBe("b");
  });

  it("treats broken storage or bad data as empty, without throwing", async () => {
    const broken: KeyValueArea = {
      get: async () => {
        throw new Error("nope");
      },
      set: async () => {
        throw new Error("nope");
      },
    };
    const m = createDecisionMemory(broken);
    await expect(m.remember("a", cart([mug]))).resolves.toBeUndefined();
    expect(await m.decisionFor([mug])).toBeNull();

    const area = memoryArea();
    area.data["auxo:decision-memory"] = [{ decisionId: 1 }, "junk", { decisionId: "old-format", items: [["Mug", 999]] }, { decisionId: "ok", cart: cart([mug]) }];
    expect(await createDecisionMemory(area).decisionFor([mug])).toBe("ok");
  });
});
