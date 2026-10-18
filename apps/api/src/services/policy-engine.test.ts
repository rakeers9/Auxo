import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import type { Budget, Cart, Rule } from "@auxo/shared";
import { createPolicyVerdict, evaluatePolicy, evaluatePolicyWithContext } from "./policy-engine.js";
import { createStubVerdict, stubLane } from "./stub-decision.js";

const now = new Date("2026-10-15T12:00:00.000Z");
const cart: Cart = {
  merchant: "Example Store",
  items: [{ name: "Limited edition sneakers", price_minor: 8_000, qty: 1 }],
  total_minor: 8_000,
  currency: "USD",
  url: "https://example.com/cart",
  cart_hash: "a".repeat(64),
};

function rule(rule_type: Rule["rule_type"], configuration: Record<string, unknown>): Rule {
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
    expect(evaluatePolicy({ cart, now, budgets: [], rules: [disabled, rule("future" as Rule["rule_type"], { lane: "L4" })] })).toBe("L0");
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

  it("reports each matched rule with its own reason code", () => {
    const evaluation = evaluatePolicyWithContext({
      cart,
      now,
      budgets: [],
      rules: [
        rule("cart_total", { threshold_minor: 5_000, lane: "L2" }),
        rule("merchant", { merchants: ["example store"], lane: "L3" }),
        rule("item_keyword", { keywords: ["SNEAKERS"], lane: "L1" }),
      ],
    });
    expect(evaluation.factors.map(({ code, lane }) => ({ code, lane }))).toEqual([
      { code: "rule.cart_total", lane: "L2" },
      { code: "rule.merchant", lane: "L3" },
      { code: "rule.item_keyword", lane: "L1" },
    ]);
  });

  // Configurations are read through RuleConfigurationSchemas: anything the
  // create endpoint would reject is ignored rather than half-applied.
  it.each([
    ["cart_total", { threshold_minor: 5_000, lane: "L4", unexpected: true }],
    ["cart_total", { threshold_minor: 5_000.5, lane: "L4" }],
    ["cart_total", { threshold_minor: -1, lane: "L4" }],
    ["cart_total", { threshold_minor: 5_000, lane: "L9" }],
    ["merchant", { merchants: ["Example Store", 42], lane: "L4" }],
    ["merchant", { merchants: "Example Store", lane: "L4" }],
    ["item_keyword", { keywords: ["sneakers", ""], lane: "L4" }],
    ["item_keyword", { keywords: ["sneakers"] }],
  ] as const)("ignores a %s rule with an invalid stored configuration %j", (ruleType, configuration) => {
    expect(evaluatePolicy({ cart, now, budgets: [], rules: [rule(ruleType, { ...configuration })] })).toBe("L0");
  });
});

describe("lane verdicts", () => {
  it("gives the stub the same verdict fields as the policy engine for every lane", () => {
    for (const suffix of ["0", "1", "2", "3", "4", "5", "a", "f"]) {
      const stubCart = { ...cart, cart_hash: `sha256:${"b".repeat(63)}${suffix}` };
      expect(createStubVerdict(stubCart, "id")).toEqual(createPolicyVerdict("id", stubLane(stubCart)));
    }
    expect(stubLane({ ...cart, cart_hash: `${"b".repeat(63)}7` })).toBe("L2");
    expect(createPolicyVerdict("id", "L3")).toEqual({
      decision_id: "id",
      lane: "L3",
      action: "block",
      template_id: "l3-block",
      cooldown_seconds: 300,
    });
  });
});
