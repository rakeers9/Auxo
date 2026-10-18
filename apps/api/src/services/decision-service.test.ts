import { describe, expect, it, vi } from "vitest";

import { DecisionContextSchema, type Cart, type DecisionHistory, type Trigger, type TriggerIntent } from "@auxo/shared";

import { InMemoryDecisionRepository } from "../repositories/decision-repository.js";
import { InMemorySettingsRepository } from "../repositories/settings-repository.js";
import type { HistoryRepository } from "../repositories/history-repository.js";
import { DecisionService, HistoryTimeoutError } from "./decision-service.js";
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

  describe("reducing triggers (AUX-30)", () => {
    const now = new Date("2026-10-15T12:00:00.000Z");

    function trigger(intent: TriggerIntent): Trigger {
      return { intent, source: "known", page_type: "cart", occurred_at: "2026-10-15T11:59:00.000Z" };
    }

    async function strictSetup() {
      const repository = new InMemoryDecisionRepository();
      const settingsRepository = new InMemorySettingsRepository();
      const rule = await settingsRepository.createRule("user-1", {
        name: "Large cart",
        rule_type: "cart_total",
        configuration: { threshold_minor: 500, lane: "L3" },
        enabled: true,
      });
      await settingsRepository.createBudget("user-1", {
        currency: "USD",
        limit_minor: 500,
        period_start: "2026-10-01",
        period_end: "2026-10-31",
      });
      const evaluate = vi.fn<DecisionModelProvider["evaluate"]>(async () => ({
        lane: "L4",
        confidence: 0.9,
        probabilities: { L0: 0, L1: 0, L2: 0.05, L3: 0.05, L4: 0.9 },
        model: "clef-test",
      }));
      const service = new DecisionService({
        repository,
        settingsRepository,
        decisionModelProvider: { modelVersion: "clef-test", evaluate },
        ttlSeconds: 60,
        now: () => now,
      });
      return { repository, rule, evaluate, service };
    }

    it.each(["decrease_qty", "remove_item", "save_for_later"] as const)(
      "allows %s at L0 even when a rule, the budget, and the model would block",
      async (intent) => {
        const { repository, rule, evaluate, service } = await strictSetup();

        const first = await service.decide("user-1", cart, trigger(intent));
        const second = await service.decide("user-1", cart, trigger(intent));

        expect(first).toMatchObject({ lane: "L0", action: "allow", cooldown_seconds: 0, template_id: "l0-pass" });
        expect(first.context?.decisive_factors).toEqual([{ code: "trigger.reducing", source: "policy", lane: "L0" }]);
        expect(first.context?.matched_rules).toEqual([
          { rule_id: rule.id, name: "Large cart", rule_type: "cart_total", lane: "L3" },
        ]);
        expect(first.context?.budget).toMatchObject({ would_exceed: true });
        expect(first.context?.model_signal).toBeNull();
        expect(first.context?.available_actions).toEqual(["continue"]);
        expect(DecisionContextSchema.safeParse(first.context).success).toBe(true);
        expect(evaluate).not.toHaveBeenCalled();
        expect(second.decision_id).not.toBe(first.decision_id);
        const records = repository.list();
        expect(records).toHaveLength(2);
        expect(records[0]).toMatchObject({ trigger: trigger(intent), modelProvider: "policy-engine" });
        expect(records[0]?.modelOutput).toBeUndefined();
      },
    );

    it.each(["add_to_cart", "buy_now", "checkout", "increase_qty", "page_view"] as const)(
      "still applies rules, budget, and model for %s",
      async (intent) => {
        const { evaluate, service } = await strictSetup();

        const verdict = await service.decide("user-1", cart, trigger(intent));

        expect(verdict).toMatchObject({ lane: "L4", action: "block" });
        expect(evaluate).toHaveBeenCalledOnce();
        expect(verdict.context?.decisive_factors.map((factor) => factor.code)).not.toContain("trigger.reducing");
      },
    );

    it("treats a reducing trigger as L0 for a user with no rules (no stub lane)", async () => {
      const service = new DecisionService({ repository: new InMemoryDecisionRepository(), ttlSeconds: 60 });
      const verdict = await service.decide("user-1", { ...cart, cart_hash: `${"a".repeat(63)}4` }, trigger("remove_item"));

      expect(verdict.lane).toBe("L0");
      expect(verdict.context?.decisive_factors).toEqual([{ code: "trigger.reducing", source: "policy", lane: "L0" }]);
    });
  });

  describe("decision context (AUX-32)", () => {
    it.each([
      ["0", "L0"],
      ["1", "L1"],
      ["2", "L2"],
      ["3", "L3"],
      ["4", "L4"],
    ] as const)("credits the stub hash for a stub decision ending in %s", async (suffix, lane) => {
      const service = new DecisionService({ repository: new InMemoryDecisionRepository(), ttlSeconds: 60 });

      const verdict = await service.decide("user-1", { ...cart, cart_hash: `${"a".repeat(63)}${suffix}` });

      expect(verdict.lane).toBe(lane);
      expect(verdict.context?.decisive_factors).toEqual([{ code: "stub.hash", source: "policy", lane }]);
      expect(verdict.context?.matched_rules).toEqual([]);
    });

    it("keeps no_policy_match when the policy engine ran and matched nothing", async () => {
      const settingsRepository = new InMemorySettingsRepository();
      await settingsRepository.createRule("user-1", {
        name: "Huge cart",
        rule_type: "cart_total",
        configuration: { threshold_minor: 1_000_000, lane: "L3" },
        enabled: true,
      });
      const service = new DecisionService({ repository: new InMemoryDecisionRepository(), settingsRepository, ttlSeconds: 60 });

      const verdict = await service.decide("user-1", { ...cart, cart_hash: `${"a".repeat(63)}4` });

      expect(verdict.lane).toBe("L0");
      expect(verdict.context?.decisive_factors).toEqual([{ code: "no_policy_match", source: "policy", lane: "L0" }]);
    });

    it("reports a model escalation even when the user has no rules or budgets", async () => {
      const service = new DecisionService({
        repository: new InMemoryDecisionRepository(),
        ttlSeconds: 60,
        decisionModelProvider: {
          modelVersion: "clef-test",
          evaluate: async () => ({
            lane: "L2",
            confidence: 0.7,
            probabilities: { L0: 0.1, L1: 0.1, L2: 0.7, L3: 0.05, L4: 0.05 },
            model: "clef-test",
          }),
        },
      });

      const verdict = await service.decide("user-1", cart);

      expect(verdict.lane).toBe("L2");
      expect(verdict.context?.decisive_factors).toContainEqual({ code: "model.escalation", source: "model", lane: "L2" });
    });

    it("does not report an escalation when the model agrees with the policy", async () => {
      const service = new DecisionService({
        repository: new InMemoryDecisionRepository(),
        ttlSeconds: 60,
        decisionModelProvider: {
          modelVersion: "clef-test",
          evaluate: async () => ({
            lane: "L0",
            confidence: 0.9,
            probabilities: { L0: 0.9, L1: 0.1, L2: 0, L3: 0, L4: 0 },
            model: "clef-test",
          }),
        },
      });

      const verdict = await service.decide("user-1", cart);

      expect(verdict.lane).toBe("L0");
      expect(verdict.context?.decisive_factors).toEqual([{ code: "no_policy_match", source: "policy", lane: "L0" }]);
    });
  });

  describe("merchant history (AUX-34)", () => {
    const history: DecisionHistory = {
      merchant: "Example Store",
      window_days: 30,
      purchases: 4,
      spent_minor: 12_000,
      check_ins: 2,
      regret_rate: 0.5,
      override_rate: 1,
    };
    const signal = {
      lane: "L1" as const,
      confidence: 0.7,
      probabilities: { L0: 0.1, L1: 0.7, L2: 0.1, L3: 0.05, L4: 0.05 },
      model: "clef-test",
    };

    function historyRepository(merchantHistory: HistoryRepository["merchantHistory"]) {
      return { merchantHistory: vi.fn(merchantHistory) };
    }

    it("reads the last 30 days at the cart's merchant into the context and the model state", async () => {
      const now = new Date("2026-10-18T12:00:00.000Z");
      const repository = historyRepository(async () => history);
      const evaluate = vi.fn<DecisionModelProvider["evaluate"]>(async () => signal);
      const decisions = new InMemoryDecisionRepository();
      const service = new DecisionService({
        repository: decisions,
        historyRepository: repository,
        decisionModelProvider: { modelVersion: "clef-test", evaluate },
        ttlSeconds: 60,
        now: () => now,
      });

      const verdict = await service.decide("user-1", cart);

      expect(repository.merchantHistory).toHaveBeenCalledWith("user-1", { merchant: "Example Store", currency: "USD", now, windowDays: 30 });
      expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ history }));
      expect(verdict.context?.history).toEqual(history);
      expect(DecisionContextSchema.parse(verdict.context)).toEqual(verdict.context);
      // The model's lane (L1) still decides; history only informs it.
      expect(verdict.lane).toBe("L1");
      expect(decisions.list()[0]?.context.history).toEqual(history);
    });

    it("includes history in the context on the stub path too", async () => {
      const service = new DecisionService({
        repository: new InMemoryDecisionRepository(),
        historyRepository: historyRepository(async () => history),
        ttlSeconds: 60,
      });

      const verdict = await service.decide("user-1", cart);

      expect(verdict.context?.decisive_factors).toEqual([{ code: "stub.hash", source: "policy", lane: verdict.lane }]);
      expect(verdict.context?.history).toEqual(history);
    });

    it("decides without history when the lookup fails, and reports the error", async () => {
      const onHistoryError = vi.fn();
      const evaluate = vi.fn<DecisionModelProvider["evaluate"]>(async () => signal);
      const failure = new Error("database down");
      const service = new DecisionService({
        repository: new InMemoryDecisionRepository(),
        historyRepository: historyRepository(async () => Promise.reject(failure)),
        decisionModelProvider: { modelVersion: "clef-test", evaluate },
        onHistoryError,
        ttlSeconds: 60,
      });

      const verdict = await service.decide("user-1", cart);

      expect(verdict.lane).toBe("L1");
      expect(verdict.context).not.toHaveProperty("history");
      expect(evaluate.mock.calls[0]?.[0]).not.toHaveProperty("history");
      expect(onHistoryError).toHaveBeenCalledWith(failure);
    });

    it("also survives a lookup that throws synchronously", async () => {
      const onHistoryError = vi.fn();
      const service = new DecisionService({
        repository: new InMemoryDecisionRepository(),
        historyRepository: {
          merchantHistory: () => {
            throw new Error("bad client");
          },
        },
        onHistoryError,
        ttlSeconds: 60,
      });

      const verdict = await service.decide("user-1", cart);

      expect(verdict.context).not.toHaveProperty("history");
      expect(onHistoryError).toHaveBeenCalledOnce();
    });

    it("gives up on a slow lookup after historyTimeoutMs", async () => {
      const onHistoryError = vi.fn();
      const service = new DecisionService({
        repository: new InMemoryDecisionRepository(),
        // Never settles.
        historyRepository: historyRepository(() => new Promise<DecisionHistory>(() => undefined)),
        historyTimeoutMs: 20,
        onHistoryError,
        ttlSeconds: 60,
      });

      const started = Date.now();
      const verdict = await service.decide("user-1", cart);

      expect(Date.now() - started).toBeLessThan(1_000);
      expect(verdict.context).not.toHaveProperty("history");
      expect(onHistoryError).toHaveBeenCalledWith(expect.any(HistoryTimeoutError));
    });

    it("defaults to a 300ms timeout", async () => {
      vi.useFakeTimers();
      try {
        const onHistoryError = vi.fn();
        const service = new DecisionService({
          repository: new InMemoryDecisionRepository(),
          historyRepository: historyRepository(() => new Promise<DecisionHistory>(() => undefined)),
          onHistoryError,
          ttlSeconds: 60,
        });

        let done = false;
        const pending = service.decide("user-1", cart).then((verdict) => {
          done = true;
          return verdict;
        });
        await vi.advanceTimersByTimeAsync(299);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        const verdict = await pending;
        expect(verdict.context).not.toHaveProperty("history");
        expect(onHistoryError).toHaveBeenCalledWith(expect.any(HistoryTimeoutError));
      } finally {
        vi.useRealTimers();
      }
    });

    it("runs the history lookup concurrently with the settings reads", async () => {
      const order: string[] = [];
      let releaseHistory: (value: DecisionHistory) => void = () => undefined;
      const settingsRepository = new InMemorySettingsRepository();
      const listRules = settingsRepository.listRules.bind(settingsRepository);
      settingsRepository.listRules = async (userId) => {
        order.push("rules");
        // History was already requested and is still pending.
        releaseHistory(history);
        return listRules(userId);
      };
      const service = new DecisionService({
        repository: new InMemoryDecisionRepository(),
        settingsRepository,
        historyRepository: historyRepository(() => {
          order.push("history");
          return new Promise<DecisionHistory>((resolve) => {
            releaseHistory = resolve;
          });
        }),
        ttlSeconds: 60,
      });

      const verdict = await service.decide("user-1", cart);

      expect(order).toEqual(["history", "rules"]);
      expect(verdict.context?.history).toEqual(history);
    });

    it("skips the lookup for a reducing trigger", async () => {
      const repository = historyRepository(async () => history);
      const service = new DecisionService({ repository: new InMemoryDecisionRepository(), historyRepository: repository, ttlSeconds: 60 });

      const verdict = await service.decide("user-1", cart, {
        intent: "remove_item",
        source: "known",
        page_type: "cart",
        occurred_at: "2026-10-15T11:59:00.000Z",
      });

      expect(verdict.lane).toBe("L0");
      expect(repository.merchantHistory).not.toHaveBeenCalled();
      expect(verdict.context).not.toHaveProperty("history");
    });
  });
});
