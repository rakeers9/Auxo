import { describe, expect, it } from "vitest";

import type { Verdict } from "@auxo/shared";

import { InMemoryDecisionRepository } from "../repositories/decision-repository.js";
import { InMemoryPassRepository } from "../repositories/pass-repository.js";
import { DecisionNotFoundError } from "./outcome-service.js";
import { PassNotAvailableError, PassService } from "./pass-service.js";

const decisionId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";
const cartHash = "a".repeat(64);

async function setup(options: {
  cooldownSeconds?: number;
  action?: Verdict["action"];
  createdAt?: string;
  expiresAt?: string;
} = {}) {
  const decisions = new InMemoryDecisionRepository();
  await decisions.save({
    userId,
    cart: { merchant: "Example Store", items: [{ name: "Shoes", price_minor: 10_000, qty: 1 }], total_minor: 10_000, currency: "USD", url: "https://example.com/cart", cart_hash: cartHash },
    verdict: { decision_id: decisionId, lane: "L3", action: options.action ?? "block", template_id: "l3-block", cooldown_seconds: options.cooldownSeconds ?? 300 },
    context: { decision_id: decisionId, cart_summary: { merchant: "Example Store", total_minor: 10_000, currency: "USD", item_count: 1 }, budget: null, matched_rules: [], model_signal: null, decisive_factors: [{ code: "no_policy_match", source: "policy", lane: "L0" }], available_actions: ["leave"] },
    policyVersion: "test", modelProvider: "stub", modelVersion: "test",
    createdAt: options.createdAt ?? "2030-01-01T00:00:00.000Z",
    expiresAt: options.expiresAt ?? "2030-01-02T00:00:00.000Z",
  });
  const passes = new InMemoryPassRepository();
  const clock = { now: new Date("2030-01-01T00:10:00.000Z") };
  return { service: new PassService(decisions, passes, 600, () => clock.now), passes, clock };
}

async function reason(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(PassNotAvailableError);
  return (error as PassNotAvailableError).reason;
}

describe("PassService", () => {
  it("issues and reuses a pass after cooldown", async () => {
    const { service } = await setup();
    const first = await service.issue(userId, decisionId);
    const second = await service.issue(userId, decisionId);
    expect(second.pass_id).toBe(first.pass_id);
    expect(first.expires_at).toBe("2030-01-01T00:20:00.000Z");
    expect(await service.active(userId, cartHash)).toEqual(first);
  });

  it("issues a new pass once the previous one expired and retires the old one", async () => {
    const { service, passes, clock } = await setup();
    const first = await service.issue(userId, decisionId);
    clock.now = new Date("2030-01-01T00:20:00.000Z");
    expect(await service.active(userId, cartHash)).toBeNull();

    const second = await service.issue(userId, decisionId);

    expect(second.pass_id).not.toBe(first.pass_id);
    expect(second.expires_at).toBe("2030-01-01T00:30:00.000Z");
    expect(await service.active(userId, cartHash)).toEqual(second);
    expect(passes.listForDecision(decisionId)).toEqual([
      { pass: first, revokedAt: "2030-01-01T00:20:00.000Z" },
      { pass: second, revokedAt: null },
    ]);
  });

  it("rejects a pass while cooldown remains", async () => {
    const { service } = await setup({ cooldownSeconds: 900 });
    expect(await reason(service.issue(userId, decisionId))).toBe("cooldown_active");
  });

  it("rejects a pass for a decision that allowed the purchase", async () => {
    const { service } = await setup({ action: "allow", cooldownSeconds: 0 });
    expect(await reason(service.issue(userId, decisionId))).toBe("not_required");
  });

  it("rejects a pass for an expired decision, from the moment it expires", async () => {
    const { service } = await setup({ expiresAt: "2030-01-01T00:10:00.000Z" });
    expect(await reason(service.issue(userId, decisionId))).toBe("decision_expired");
  });

  it("treats another user's decision as not found", async () => {
    const { service } = await setup({ cooldownSeconds: 0 });
    await expect(service.issue("30000000-0000-4000-8000-000000000001", decisionId)).rejects.toBeInstanceOf(DecisionNotFoundError);
  });

  it("treats an unknown decision as not found", async () => {
    const { service } = await setup();
    await expect(service.issue(userId, "10000000-0000-4000-8000-000000000999")).rejects.toBeInstanceOf(DecisionNotFoundError);
  });

  it("looks up active passes case-insensitively", async () => {
    const { service } = await setup();
    const pass = await service.issue(userId, decisionId);
    expect(await service.active(userId, cartHash.toUpperCase())).toEqual(pass);
  });
});
