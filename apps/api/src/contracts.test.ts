import {
  ActivePassQuerySchema,
  CreateRuleSchema,
  DecisionContextSchema,
  ReadFailureCodeSchema,
  ReadFailureReportSchema,
  UpdateRuleSchema,
  VerdictSchema,
} from "@auxo/shared";
import { describe, expect, it } from "vitest";

const HASH = "AB".repeat(32);

describe("rule contracts", () => {
  it("accepts each rule type with its own configuration", () => {
    expect(CreateRuleSchema.safeParse({
      name: "Big carts", rule_type: "cart_total", enabled: true,
      configuration: { lane: "L3", threshold_minor: 20000 },
    }).success).toBe(true);
    expect(CreateRuleSchema.safeParse({
      name: "No Temu", rule_type: "merchant", enabled: true,
      configuration: { lane: "L4", merchants: ["temu.com"] },
    }).success).toBe(true);
    expect(CreateRuleSchema.safeParse({
      name: "Sneakers", rule_type: "item_keyword", enabled: true,
      configuration: { lane: "L2", keywords: ["sneakers"] },
    }).success).toBe(true);
  });

  it("rejects unknown rule types and configurations that don't fit the type", () => {
    expect(CreateRuleSchema.safeParse({
      name: "Mystery", rule_type: "vibes", enabled: true, configuration: { lane: "L2" },
    }).success).toBe(false);

    const parsed = CreateRuleSchema.safeParse({
      name: "Broken", rule_type: "cart_total", enabled: true, configuration: { lane: "L9" },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.every((issue) => issue.path[0] === "configuration")).toBe(true);
  });

  it("doesn't let an update change a rule's type", () => {
    expect(UpdateRuleSchema.safeParse({ rule_type: "merchant" }).success).toBe(false);
    expect(UpdateRuleSchema.safeParse({ enabled: false }).success).toBe(true);
  });
});

describe("pass contracts", () => {
  it("lowercases the cart hash in active pass lookups, like carts", () => {
    expect(ActivePassQuerySchema.parse({ cart_hash: `sha256:${HASH}` }).cart_hash).toBe(
      `sha256:${HASH.toLowerCase()}`,
    );
  });
});

describe("decision context contracts", () => {
  const context = {
    decision_id: "00000000-0000-4000-8000-000000000001",
    cart_summary: { merchant: "amazon.com", total_minor: 1000, currency: "USD", item_count: 1 },
    budget: null,
    matched_rules: [],
    model_signal: null,
    decisive_factors: [{ code: "trigger.reducing", source: "policy", lane: "L0" }],
    available_actions: ["continue"],
  };

  it("accepts the new reason codes and an optional history", () => {
    expect(DecisionContextSchema.safeParse(context).success).toBe(true);
    expect(DecisionContextSchema.safeParse({
      ...context,
      decisive_factors: [{ code: "stub.hash", source: "policy", lane: "L3" }],
      history: {
        merchant: "amazon.com", window_days: 30, purchases: 2, spent_minor: 5000,
        check_ins: 2, regret_rate: 0.5, override_rate: null,
      },
    }).success).toBe(true);
  });

  it("still parses verdicts without a context", () => {
    expect(VerdictSchema.safeParse({
      decision_id: context.decision_id, lane: "L0", action: "allow", template_id: "l0-pass", cooldown_seconds: 0,
    }).success).toBe(true);
  });
});

describe("read failure contracts", () => {
  const report = {
    reader: "amazon_product",
    page_type: "product",
    store_host: "www.amazon.com",
    extension_version: "1.2.3",
    codes: ["price.no_layer_found", "qty.no_dropdown"],
    day: "2026-10-26",
  };

  it("accepts codes only", () => {
    expect(ReadFailureReportSchema.parse(report)).toEqual(report);
  });

  it("has a fallback code for problems without a mapping", () => {
    expect(ReadFailureCodeSchema.options).toContain("unknown");
  });

  it.each([
    ["an uppercase host", { store_host: "WWW.AMAZON.COM" }],
    ["a host with a path", { store_host: "www.amazon.com/dp/B0TEST0001" }],
    ["a host with a port", { store_host: "127.0.0.1:3001" }],
    ["21 codes", { codes: ReadFailureCodeSchema.options.slice(0, 21) }],
    ["a version with text", { extension_version: "1.2.3-beta" }],
    ["a malformed day", { day: "26-10-2026" }],
  ])("rejects %s", (_label, change) => {
    expect(ReadFailureReportSchema.safeParse({ ...report, ...change }).success).toBe(false);
  });
});
