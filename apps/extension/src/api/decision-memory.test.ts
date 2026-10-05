import { describe, expect, it } from "vitest";

import { createDecisionMemory, type KeyValueArea } from "./decision-memory";

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

const mug = { name: "Mug", price_minor: 999 };
const lamp = { name: "Lamp", price_minor: 3399 };

describe("createDecisionMemory", () => {
  it("finds the decision that covered an item", async () => {
    const m = createDecisionMemory(memoryArea());
    await m.remember("a", [mug]);
    await m.remember("b", [lamp]);

    expect(await m.decisionFor([mug])).toBe("a");
    expect(await m.decisionFor([lamp])).toBe("b");
  });

  it("prefers the most recent decision that included the item", async () => {
    const m = createDecisionMemory(memoryArea());
    await m.remember("a", [mug]);
    await m.remember("b", [mug, lamp]);

    expect(await m.decisionFor([mug])).toBe("b");
  });

  it("matches on name and unit price", async () => {
    const m = createDecisionMemory(memoryArea());
    await m.remember("a", [mug]);

    expect(await m.decisionFor([{ name: "Mug", price_minor: 899 }])).toBeNull();
    expect(await m.decisionFor([{ name: "Cup", price_minor: 999 }])).toBeNull();
  });

  it("survives a worker restart (a new memory on the same storage)", async () => {
    const area = memoryArea();
    await createDecisionMemory(area).remember("a", [mug]);

    expect(await createDecisionMemory(area).decisionFor([mug])).toBe("a");
  });

  it("keeps only the newest entries", async () => {
    const m = createDecisionMemory(memoryArea(), 2);
    await m.remember("a", [mug]);
    await m.remember("b", [lamp]);
    await m.remember("c", [{ name: "Pen", price_minor: 100 }]);

    expect(await m.decisionFor([mug])).toBeNull();
    expect(await m.decisionFor([lamp])).toBe("b");
  });

  it("doesn't lose writes made back to back", async () => {
    const m = createDecisionMemory(memoryArea());
    void m.remember("a", [mug]);
    void m.remember("b", [lamp]);

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
    await expect(m.remember("a", [mug])).resolves.toBeUndefined();
    expect(await m.decisionFor([mug])).toBeNull();

    const area = memoryArea();
    area.data["auxo:decision-memory"] = [{ decisionId: 1 }, "junk", { decisionId: "ok", items: [["Mug", 999]] }];
    expect(await createDecisionMemory(area).decisionFor([mug])).toBe("ok");
  });
});
