import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import type { Budget, Cart, Rule } from "@auxo/shared";
import { evaluatePolicy } from "./policy-engine.js";

const now = new Date("2026-10-15T12:00:00.000Z");
const cart: Cart = {
  merchant: "Example Store",
  items: [{ name: "Limited edition sneakers", price_minor: 8_000, qty: 1 }],
  total_minor: 8_000,
  currency: "USD",
  url: "https://example.com/cart",
  cart_hash: "a".repeat(64),
};

function rule(rule_type: string, configuration: Record<string, unknown>): Rule {
  return {
    id: randomUUID(),
    name: "Test rule",
    rule_type,
    configuration,
    enabled: true,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

function budget(overrides: Partial<Budget> = {}): Budget {
  return {
    id: randomUUID(),
    currency: "USD",
    limit_minor: 10_000,
    spent_minor: 0,
    period_start: "2026-10-01",
    period_end: "2026-10-31",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    ...overrides,
  };
}

describe("evaluatePolicy", () => {
  it("uses the highest lane from matching rules", () => {
    expect(
      evaluatePolicy({
        cart,
        now,
        budgets: [],
        rules: [
          rule("cart_total", { threshold_minor: 5_000, lane: "L2" }),
          rule("merchant", { merchants: ["Example Store"], lane: "L3" }),
          rule("item_keyword", { keywords: ["sneakers"], lane: "L1" }),
        ],
      }),
    ).toBe("L3");
  });

  it("ignores disabled and unknown rules", () => {
    const disabled = { ...rule("merchant", { merchants: ["Example Store"], lane: "L4" }), enabled: false };
    expect(evaluatePolicy({ cart, now, budgets: [], rules: [disabled, rule("future", { lane: "L4" })] })).toBe("L0");
  });

  it.each([
    [0, "L2"],
    [1_000, "L3"],
    [3_000, "L4"],
  ])("maps projected budget pressure to a lane", (spentMinor, lane) => {
    expect(evaluatePolicy({ cart, now, rules: [], budgets: [budget({ spent_minor: spentMinor })] })).toBe(lane);
  });

  it("ignores budgets outside the active period or cart currency", () => {
    expect(
      evaluatePolicy({
        cart,
        now,
        rules: [],
        budgets: [budget({ currency: "EUR" }), budget({ period_end: "2026-10-14" })],
      }),
    ).toBe("L0");
  });
});
