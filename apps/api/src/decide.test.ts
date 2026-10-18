import { afterEach, describe, expect, it, vi } from "vitest";

import { DecideResponseSchema } from "@auxo/shared";

import { buildApp } from "./application.js";
import { InMemoryDecisionRepository } from "./repositories/decision-repository.js";
import { InMemorySettingsRepository } from "./repositories/settings-repository.js";
import type { DecisionModelProvider } from "./services/decision-model-provider.js";

const DEVELOPMENT_USER_ID = "00000000-0000-4000-8000-000000000001";
const openApps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function cartWithHashSuffix(suffix: string) {
  return {
    merchant: "Example Store",
    items: [{ name: "Example item", price_minor: 2_500, qty: 1 }],
    total_minor: 2_500,
    currency: "USD",
    url: "https://example.com/cart",
    cart_hash: `${"0".repeat(63)}${suffix}`,
  };
}

function trigger(intent: string) {
  return { intent, source: "known", page_type: "cart", occurred_at: "2026-10-15T12:00:00.000Z" };
}

async function strictApp() {
  const decisionRepository = new InMemoryDecisionRepository();
  const settingsRepository = new InMemorySettingsRepository();
  await settingsRepository.createRule(DEVELOPMENT_USER_ID, {
    name: "Any cart",
    rule_type: "cart_total",
    configuration: { threshold_minor: 0, lane: "L3" },
    enabled: true,
  });
  const evaluate = vi.fn<DecisionModelProvider["evaluate"]>(async () => ({
    lane: "L4",
    confidence: 0.9,
    probabilities: { L0: 0, L1: 0, L2: 0.05, L3: 0.05, L4: 0.9 },
    model: "clef-test",
  }));
  const app = buildApp({
    decisionRepository,
    settingsRepository,
    decisionModelProvider: { modelVersion: "clef-test", evaluate },
  });
  openApps.push(app);
  return { app, decisionRepository, evaluate };
}

describe("POST /v1/decide with a trigger", () => {
  it.each(["decrease_qty", "remove_item", "save_for_later"])(
    "returns L0 for a %s cart edit without asking the model",
    async (intent) => {
      const { app, decisionRepository, evaluate } = await strictApp();

      const response = await app.inject({
        method: "POST",
        url: "/v1/decide",
        payload: { cart: cartWithHashSuffix("4"), trigger: trigger(intent) },
      });
      const body = response.json();

      expect(response.statusCode).toBe(200);
      expect(DecideResponseSchema.safeParse(body).success).toBe(true);
      expect(body).toMatchObject({ lane: "L0", action: "allow", cooldown_seconds: 0 });
      expect(body.context.decisive_factors).toEqual([{ code: "trigger.reducing", source: "policy", lane: "L0" }]);
      expect(body.context.matched_rules).toHaveLength(1);
      expect(evaluate).not.toHaveBeenCalled();
      expect(decisionRepository.list()[0]?.trigger).toEqual(trigger(intent));
    },
  );

  it("still blocks an add_to_cart click", async () => {
    const { app, evaluate } = await strictApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/decide",
      payload: { cart: cartWithHashSuffix("0"), trigger: trigger("add_to_cart") },
    });

    expect(response.json()).toMatchObject({ lane: "L4", action: "block" });
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it("explains a stub decision with the stub hash", async () => {
    const app = buildApp();
    openApps.push(app);

    const body = (await app.inject({ method: "POST", url: "/v1/decide", payload: { cart: cartWithHashSuffix("3") } })).json();

    expect(DecideResponseSchema.safeParse(body).success).toBe(true);
    expect(body.lane).toBe("L3");
    expect(body.context.decisive_factors).toEqual([{ code: "stub.hash", source: "policy", lane: "L3" }]);
  });
});
