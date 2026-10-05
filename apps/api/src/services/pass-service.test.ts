import { describe, expect, it } from "vitest";

import { InMemoryDecisionRepository } from "../repositories/decision-repository.js";
import { InMemoryPassRepository } from "../repositories/pass-repository.js";
import { PassNotAvailableError, PassService } from "./pass-service.js";

const decisionId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";

async function setup(cooldownSeconds: number, createdAt: string) {
  const decisions = new InMemoryDecisionRepository();
  await decisions.save({
    userId,
    cart: { merchant: "Example Store", items: [{ name: "Shoes", price_minor: 10_000, qty: 1 }], total_minor: 10_000, currency: "USD", url: "https://example.com/cart", cart_hash: "a".repeat(64) },
    verdict: { decision_id: decisionId, lane: "L3", action: "block", template_id: "l3-block", cooldown_seconds: cooldownSeconds },
    context: { decision_id: decisionId, cart_summary: { merchant: "Example Store", total_minor: 10_000, currency: "USD", item_count: 1 }, budget: null, matched_rules: [], model_signal: null, decisive_factors: [{ code: "no_policy_match", source: "policy", lane: "L0" }], available_actions: ["leave"] },
    policyVersion: "test", modelProvider: "stub", modelVersion: "test", createdAt, expiresAt: "2030-01-02T00:00:00.000Z",
  });
  const passes = new InMemoryPassRepository();
  return { service: new PassService(decisions, passes, 600, () => new Date("2030-01-01T00:10:00.000Z")) };
}

describe("PassService", () => {
  it("issues and reuses a pass after cooldown", async () => {
    const { service } = await setup(300, "2030-01-01T00:00:00.000Z");
    const first = await service.issue(userId, decisionId);
    const second = await service.issue(userId, decisionId);
    expect(second.pass_id).toBe(first.pass_id);
    expect(await service.active(userId, "a".repeat(64))).toEqual(first);
  });

  it("rejects a pass while cooldown remains", async () => {
    const { service } = await setup(900, "2030-01-01T00:00:00.000Z");
    await expect(service.issue(userId, decisionId)).rejects.toBeInstanceOf(PassNotAvailableError);
  });

  it("does not expose another user's decision", async () => {
    const { service } = await setup(0, "2030-01-01T00:00:00.000Z");
    await expect(service.issue("30000000-0000-4000-8000-000000000001", decisionId)).rejects.toBeInstanceOf(PassNotAvailableError);
  });
});
