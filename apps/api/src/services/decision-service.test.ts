import { describe, expect, it, vi } from "vitest";

import type { Cart } from "@auxo/shared";

import { InMemoryDecisionRepository } from "../repositories/decision-repository.js";
import { InMemorySettingsRepository } from "../repositories/settings-repository.js";
import { DecisionService } from "./decision-service.js";
import type { DecisionModelProvider } from "./decision-model-provider.js";

const cart: Cart = {
  merchant: "Example Store",
  items: [{ name: "Example item", price_minor: 1_000, qty: 1 }],
  total_minor: 1_000,
  currency: "USD",
  url: "https://example.com/cart",
  cart_hash: `${"a".repeat(63)}2`,
};

describe("DecisionService", () => {
  it("analyzes the same cart again on every request", async () => {
    const repository = new InMemoryDecisionRepository();
    const service = new DecisionService({ repository, ttlSeconds: 60 });

    const first = await service.decide("user-1", cart);
    const second = await service.decide("user-1", cart);

    expect(second.decision_id).not.toBe(first.decision_id);
    expect(second.lane).toBe(first.lane);
    expect(second.context?.decision_id).toBe(second.decision_id);
    expect(repository.list()).toHaveLength(2);
    expect(await repository.belongsToUser("user-1", first.decision_id)).toBe(true);
    expect(await repository.belongsToUser("user-1", second.decision_id)).toBe(true);
  });

  it("creates user-specific decision ids", async () => {
    const repository = new InMemoryDecisionRepository();
    const service = new DecisionService({ repository, ttlSeconds: 60 });

    const first = await service.decide("user-1", cart);
    const second = await service.decide("user-2", cart);

    expect(second.decision_id).not.toBe(first.decision_id);
    expect(second.lane).toBe(first.lane);
  });

  it("uses the injected decision id", async () => {
    const service = new DecisionService({
      repository: new InMemoryDecisionRepository(),
      ttlSeconds: 60,
      newDecisionId: () => "6f1c2b9e-0d4a-4c1e-9b7a-1f2e3d4c5b6a",
    });

    expect((await service.decide("user-1", cart)).decision_id).toBe("6f1c2b9e-0d4a-4c1e-9b7a-1f2e3d4c5b6a");
  });

  it("does not let another user claim a decision", async () => {
    const repository = new InMemoryDecisionRepository();
    const service = new DecisionService({ repository, ttlSeconds: 60 });

    const verdict = await service.decide("user-1", cart);

    expect(await repository.belongsToUser("user-2", verdict.decision_id)).toBe(false);
    expect(await repository.findOwned("user-2", verdict.decision_id)).toBeNull();
    expect(await repository.findOwned("user-1", verdict.decision_id)).not.toBeNull();
  });

  it("uses configured rules and invalidates a decision when settings change", async () => {
    const repository = new InMemoryDecisionRepository();
    const settingsRepository = new InMemorySettingsRepository();
    const service = new DecisionService({ repository, settingsRepository, ttlSeconds: 60 });
    const rule = await settingsRepository.createRule("user-1", {
      name: "Large cart",
      rule_type: "cart_total",
      configuration: { threshold_minor: 500, lane: "L3" },
      enabled: true,
    });

    const blocked = await service.decide("user-1", cart);
    await settingsRepository.updateRule("user-1", rule.id, { enabled: false });
    const allowed = await service.decide("user-1", cart);

    expect(blocked.lane).toBe("L3");
    expect(allowed.lane).toBe("L0");
    expect(allowed.decision_id).not.toBe(blocked.decision_id);
  });

  it("uses the decision model to escalate but never weaken the deterministic policy", async () => {
    const repository = new InMemoryDecisionRepository();
    const settingsRepository = new InMemorySettingsRepository();
    await settingsRepository.createRule("user-1", {
      name: "Large cart",
      rule_type: "cart_total",
      configuration: { threshold_minor: 500, lane: "L3" },
      enabled: true,
    });
    const decisionModelProvider: DecisionModelProvider = {
      modelVersion: "clef-test",
      evaluate: async () => ({
        lane: "L1",
        confidence: 0.8,
        probabilities: { L0: 0.05, L1: 0.8, L2: 0.1, L3: 0.04, L4: 0.01 },
        model: "clef-test",
      }),
    };
    const service = new DecisionService({
      repository,
      settingsRepository,
      decisionModelProvider,
      ttlSeconds: 60,
    });

    expect((await service.decide("user-1", cart)).lane).toBe("L3");
  });

  it("falls back safely when the decision model fails", async () => {
    const onDecisionModelError = vi.fn();
    const service = new DecisionService({
      repository: new InMemoryDecisionRepository(),
      ttlSeconds: 60,
      onDecisionModelError,
      decisionModelProvider: {
        modelVersion: "clef-test",
        evaluate: async () => Promise.reject(new Error("timeout")),
      },
    });

    const verdict = await service.decide("user-1", cart);
    expect(verdict).toMatchObject({ lane: "L0", action: "allow" });
    expect(onDecisionModelError).toHaveBeenCalledOnce();
  });
});
