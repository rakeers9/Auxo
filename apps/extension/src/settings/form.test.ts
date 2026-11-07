import { CreateBudgetSchema, CreateRuleSchema, RULE_DESCRIPTION_MAX_LENGTH, RuleConfigurationSchemas, type Rule } from "@auxo/shared";
import { describe, expect, it } from "vitest";

import {
  AUTO_LANE,
  budgetFrom,
  budgetSummary,
  cartTotalRule,
  descriptionRule,
  LANE_LABELS,
  laneOf,
  merchantRule,
  monthRange,
  parseDollars,
  ruleSummary,
  withLane,
} from "./form";

function stored(rule_type: Rule["rule_type"], configuration: Record<string, unknown>): Rule {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Stored",
    rule_type,
    configuration,
    enabled: true,
    created_at: "2026-11-06T12:00:00.000Z",
    updated_at: "2026-11-06T12:00:00.000Z",
  };
}

describe("parseDollars", () => {
  it.each([
    ["25", 2_500],
    ["25.5", 2_550],
    ["$1,250.00", 125_000],
    [" 0.99 ", 99],
    ["0", 0],
  ])("reads %s as %i cents", (text, minor) => {
    expect(parseDollars(text)).toBe(minor);
  });

  it.each(["", "abc", "1.234", "-5", "1e3", "12.", "$"])("rejects %j", (text) => {
    expect(parseDollars(text)).toBeNull();
  });
});

describe("rule builders", () => {
  it("builds a free-text rule the API accepts, with or without a lane", () => {
    const withChoice = descriptionRule("  I don't want to buy clothes ", "L2");
    expect(withChoice).toEqual({
      name: "I don't want to buy clothes",
      rule_type: "description",
      configuration: { description: "I don't want to buy clothes", lane: "L2" },
      enabled: true,
    });
    expect(CreateRuleSchema.safeParse(withChoice).success).toBe(true);

    const auto = descriptionRule("No gadgets", AUTO_LANE);
    expect(auto?.configuration).toEqual({ description: "No gadgets" });
    expect(CreateRuleSchema.safeParse(auto).success).toBe(true);
  });

  it("shortens a long description into a valid name", () => {
    const text = "x".repeat(RULE_DESCRIPTION_MAX_LENGTH);
    const rule = descriptionRule(text, "L1");
    expect(rule?.name).toHaveLength(100);
    expect(CreateRuleSchema.safeParse(rule).success).toBe(true);
  });

  it("refuses an empty or too long description", () => {
    expect(descriptionRule("   ", "L1")).toBeNull();
    expect(descriptionRule("x".repeat(RULE_DESCRIPTION_MAX_LENGTH + 1), "L1")).toBeNull();
  });

  it("builds cart total and store rules the API accepts", () => {
    const total = cartTotalRule("$100", "L3");
    expect(total?.configuration).toEqual({ threshold_minor: 10_000, lane: "L3" });
    expect(CreateRuleSchema.safeParse(total).success).toBe(true);
    expect(cartTotalRule("lots", "L3")).toBeNull();

    const store = merchantRule("https://www.Amazon.com/gp/cart", "L1");
    expect(store?.configuration).toEqual({ merchants: ["amazon.com"], lane: "L1" });
    expect(CreateRuleSchema.safeParse(store).success).toBe(true);
    expect(merchantRule("amazon", "L1")).toBeNull();
  });
});

describe("withLane and laneOf", () => {
  it("lets a free-text rule switch between its own lane and Auxo's choice", () => {
    const rule = stored("description", { description: "Clothes", lane: "L2" });
    expect(laneOf(rule)).toBe("L2");
    expect(withLane(rule, AUTO_LANE)).toEqual({ description: "Clothes" });
    expect(withLane(rule, "L0")).toEqual({ description: "Clothes", lane: "L0" });
    expect(laneOf(stored("description", { description: "Clothes" }))).toBe(AUTO_LANE);
    expect(RuleConfigurationSchemas.description.safeParse(withLane(rule, AUTO_LANE)).success).toBe(true);
  });

  it("keeps the rest of another rule's configuration and never leaves its lane to Auxo", () => {
    const rule = stored("cart_total", { threshold_minor: 5_000, lane: "L2" });
    expect(withLane(rule, "L4")).toEqual({ threshold_minor: 5_000, lane: "L4" });
    expect(withLane(rule, AUTO_LANE)).toBeNull();
  });
});

describe("summaries", () => {
  it("describes each rule type in plain words", () => {
    expect(ruleSummary(stored("description", { description: "No clothes" }))).toBe("“No clothes”");
    expect(ruleSummary(stored("cart_total", { threshold_minor: 10_000, lane: "L2" }))).toBe("Any cart of $100.00 or more");
    expect(ruleSummary(stored("merchant", { merchants: ["amazon.com"], lane: "L2" }))).toBe("Any cart at amazon.com");
    expect(ruleSummary(stored("item_keyword", { keywords: ["sneakers"], lane: "L2" }))).toBe("Items named sneakers");
  });

  it("names every lane", () => {
    expect(Object.keys(LANE_LABELS)).toEqual(["L0", "L1", "L2", "L3", "L4"]);
  });
});

describe("budgets", () => {
  it("defaults to the current month", () => {
    expect(monthRange(new Date(2026, 10, 6))).toEqual({ start: "2026-11-01", end: "2026-11-30" });
    expect(monthRange(new Date(2028, 1, 10))).toEqual({ start: "2028-02-01", end: "2028-02-29" });
  });

  it("builds a budget the API accepts and refuses bad input", () => {
    const budget = budgetFrom("300", "2026-11-01", "2026-11-30");
    expect(budget).toEqual({ currency: "USD", limit_minor: 30_000, period_start: "2026-11-01", period_end: "2026-11-30" });
    expect(CreateBudgetSchema.safeParse(budget).success).toBe(true);
    expect(budgetFrom("0", "2026-11-01", "2026-11-30")).toBeNull();
    expect(budgetFrom("300", "2026-11-30", "2026-11-01")).toBeNull();
    expect(budgetFrom("300", "", "2026-11-30")).toBeNull();
  });

  it("summarizes spending against the limit", () => {
    expect(
      budgetSummary({
        id: "22222222-2222-4222-8222-222222222222",
        currency: "USD",
        limit_minor: 30_000,
        spent_minor: 12_050,
        period_start: "2026-11-01",
        period_end: "2026-11-30",
        created_at: "2026-11-06T12:00:00.000Z",
        updated_at: "2026-11-06T12:00:00.000Z",
      }),
    ).toBe("$120.50 of $300.00 spent, 2026-11-01 to 2026-11-30");
  });
});
