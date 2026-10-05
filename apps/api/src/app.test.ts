import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { DecideResponseSchema, StoreConfigSchema } from "@auxo/shared";

import { buildApp } from "./app.js";
import type { AuthService } from "./auth/auth-service.js";
import { InMemoryDecisionRepository } from "./repositories/decision-repository.js";
import { InMemoryStoreConfigRepository } from "./repositories/store-config-repository.js";

const openApps: Awaited<ReturnType<typeof buildApp>>[] = [];

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

describe("GET /health", () => {
  it("reports that the service is healthy", async () => {
    const app = await buildApp();
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});

describe("POST /v1/decide", () => {
  it.each([
    ["0", "L0", "allow", 0],
    ["1", "L1", "allow", 0],
    ["2", "L2", "pause", 60],
    ["3", "L3", "block", 300],
    ["4", "L4", "block", 900],
  ])("maps hash suffix %s to %s", async (suffix, lane, action, cooldownSeconds) => {
    const app = await buildApp();
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/decide",
      payload: { cart: cartWithHashSuffix(suffix) },
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(DecideResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      lane,
      action,
      cooldown_seconds: cooldownSeconds,
    });
  });

  it("analyzes the same cart again on every request", async () => {
    const app = await buildApp();
    openApps.push(app);
    const payload = { cart: cartWithHashSuffix("2") };

    const first = (await app.inject({ method: "POST", url: "/v1/decide", payload })).json();
    const second = (await app.inject({ method: "POST", url: "/v1/decide", payload })).json();

    expect(second.decision_id).not.toBe(first.decision_id);
    expect(second.lane).toBe(first.lane);

    for (const decision of [first, second]) {
      const event = await app.inject({
        method: "POST",
        url: "/v1/events",
        payload: {
          event_id: randomUUID(),
          decision_id: decision.decision_id,
          action: "left",
          occurred_at: "2026-10-04T16:00:00.000Z",
        },
      });
      expect(event.statusCode).toBe(201);
    }
  });

  it("accepts a trigger and stores it with the decision", async () => {
    const decisionRepository = new InMemoryDecisionRepository();
    const app = await buildApp({ decisionRepository });
    openApps.push(app);
    const trigger = {
      intent: "add_to_cart",
      source: "known",
      page_type: "product",
      occurred_at: "2026-10-04T20:00:00.000Z",
      label: "Add to Cart",
    };

    const response = await app.inject({
      method: "POST",
      url: "/v1/decide",
      payload: { cart: cartWithHashSuffix("4"), trigger },
    });

    expect(response.statusCode).toBe(200);
    expect(decisionRepository.list()[0]?.trigger).toEqual(trigger);
  });

  it.each(["increase_qty", "decrease_qty", "remove_item", "save_for_later"])("accepts a %s cart-edit trigger", async (intent) => {
    const decisionRepository = new InMemoryDecisionRepository();
    const app = await buildApp({ decisionRepository });
    openApps.push(app);
    const trigger = { intent, source: "known", page_type: "cart", occurred_at: "2026-10-05T18:00:00.000Z", label: "Delete" };

    const response = await app.inject({ method: "POST", url: "/v1/decide", payload: { cart: cartWithHashSuffix("1"), trigger } });

    expect(response.statusCode).toBe(200);
    expect(decisionRepository.list()[0]?.trigger).toEqual(trigger);
  });

  it("still accepts a decide request without a trigger", async () => {
    const decisionRepository = new InMemoryDecisionRepository();
    const app = await buildApp({ decisionRepository });
    openApps.push(app);

    const response = await app.inject({ method: "POST", url: "/v1/decide", payload: { cart: cartWithHashSuffix("1") } });

    expect(response.statusCode).toBe(200);
    expect(decisionRepository.list()[0]?.trigger).toBeUndefined();
  });

  it("rejects an invalid trigger", async () => {
    const app = await buildApp();
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/decide",
      payload: {
        cart: cartWithHashSuffix("1"),
        trigger: { intent: "wishlist", source: "known", page_type: "product", occurred_at: "2026-10-04T20:00:00.000Z" },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("rejects an invalid cart", async () => {
    const app = await buildApp();
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/decide",
      payload: { cart: { merchant: "Example Store" } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("requires a bearer token when authentication is enabled", async () => {
    const app = await buildApp({ authRequired: true });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/decide",
      payload: { cart: cartWithHashSuffix("0") },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("uses the authenticated user when creating a decision", async () => {
    const userId = "00000000-0000-4000-8000-000000000099";
    const authService: AuthService = {
      authenticate: async (accessToken) => (accessToken === "valid" ? { id: userId } : null),
    };
    const app = await buildApp({ authRequired: true, authService });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/decide",
      headers: { authorization: "Bearer valid" },
      payload: { cart: cartWithHashSuffix("1") },
    });

    expect(response.statusCode).toBe(200);
    expect(DecideResponseSchema.safeParse(response.json()).success).toBe(true);
  });

  it("rejects an invalid bearer token", async () => {
    const authService: AuthService = { authenticate: async () => null };
    const app = await buildApp({ authRequired: true, authService });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/decide",
      headers: { authorization: "Bearer invalid" },
      payload: { cart: cartWithHashSuffix("1") },
    });

    expect(response.statusCode).toBe(401);
  });

  it("evaluates stored rules when deciding", async () => {
    const app = await buildApp();
    openApps.push(app);
    await app.inject({
      method: "POST",
      url: "/v1/rules",
      payload: {
        name: "Pause purchases over $20",
        rule_type: "cart_total",
        configuration: { threshold_minor: 2_000, lane: "L3" },
        enabled: true,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/decide",
      payload: { cart: cartWithHashSuffix("0") },
    });

    expect(response.json()).toMatchObject({
      lane: "L3",
      action: "block",
      context: {
        matched_rules: [{ name: "Pause purchases over $20", lane: "L3" }],
        decisive_factors: [{ code: "rule.cart_total", source: "rule", lane: "L3" }],
      },
    });
  });

  it("evaluates the active budget when deciding", async () => {
    const app = await buildApp();
    openApps.push(app);
    await app.inject({
      method: "POST",
      url: "/v1/budgets",
      payload: {
        currency: "USD",
        limit_minor: 2_000,
        period_start: "2026-01-01",
        period_end: "2099-12-31",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/decide",
      payload: { cart: cartWithHashSuffix("0") },
    });

    expect(response.json()).toMatchObject({
      lane: "L4",
      action: "block",
      context: {
        budget: { limit_minor: 2_000, projected_minor: 2_500, would_exceed: true },
        decisive_factors: [{ code: "budget.exceeded", source: "budget", lane: "L4" }],
      },
    });
  });
});

describe("API safeguards", () => {
  it("rate limits repeated API requests while keeping health available", async () => {
    const app = await buildApp({ rateLimitMax: 1, rateLimitWindowMs: 60_000 });
    openApps.push(app);
    expect((await app.inject({ method: "POST", url: "/v1/decide", payload: { cart: cartWithHashSuffix("0") } })).statusCode).toBe(200);
    const limited = await app.inject({ method: "POST", url: "/v1/decide", payload: { cart: cartWithHashSuffix("1") } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
});

describe("POST /v1/events", () => {
  it("stores an event once and treats a replay as a duplicate", async () => {
    const app = await buildApp();
    openApps.push(app);
    const decisionResponse = await app.inject({
      method: "POST",
      url: "/v1/decide",
      payload: { cart: cartWithHashSuffix("2") },
    });
    const decisionId = decisionResponse.json().decision_id as string;
    const event = {
      event_id: randomUUID(),
      decision_id: decisionId,
      action: "saved",
      occurred_at: "2026-10-04T12:00:00.000Z",
      metadata: { source: "overlay" },
    };

    const first = await app.inject({ method: "POST", url: "/v1/events", payload: event });
    const second = await app.inject({ method: "POST", url: "/v1/events", payload: event });

    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ accepted: true, duplicate: false });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ accepted: true, duplicate: true });
  });

  it.each(["removed", "bought"])("accepts a %s event", async (action) => {
    const app = await buildApp();
    openApps.push(app);
    const decisionId = (await app.inject({ method: "POST", url: "/v1/decide", payload: { cart: cartWithHashSuffix("2") } })).json()
      .decision_id as string;

    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {
        event_id: randomUUID(),
        decision_id: decisionId,
        action,
        occurred_at: "2026-10-04T12:00:00.000Z",
        metadata: { items: [{ name: "Example item", price_minor: 2_500, qty: 1 }], total_minor: 2_500 },
      },
    });

    expect(response.statusCode).toBe(201);
  });

  it("does not expose another user's decision", async () => {
    const authService: AuthService = {
      authenticate: async (accessToken) => ({ id: accessToken }),
    };
    const app = await buildApp({ authRequired: true, authService });
    openApps.push(app);
    const decisionResponse = await app.inject({
      method: "POST",
      url: "/v1/decide",
      headers: { authorization: "Bearer user-a" },
      payload: { cart: cartWithHashSuffix("3") },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: "Bearer user-b" },
      payload: {
        event_id: randomUUID(),
        decision_id: decisionResponse.json().decision_id,
        action: "left",
        occurred_at: "2026-10-04T12:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "DECISION_NOT_FOUND" } });
  });

  it("rejects an invalid event", async () => {
    const app = await buildApp();
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: { action: "unknown" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });
});

describe("POST /v1/check-ins", () => {
  it("stores one check-in per decision and handles retries", async () => {
    const app = await buildApp();
    openApps.push(app);
    const decisionResponse = await app.inject({
      method: "POST",
      url: "/v1/decide",
      payload: { cart: cartWithHashSuffix("4") },
    });
    const checkIn = {
      decision_id: decisionResponse.json().decision_id,
      worth_it: "yes",
      note: "Used it immediately.",
      answered_at: "2026-10-04T13:00:00.000Z",
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/check-ins",
      payload: checkIn,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/check-ins",
      payload: checkIn,
    });

    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ accepted: true, duplicate: false });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ accepted: true, duplicate: true });
  });

  it("rejects a check-in for an unknown decision", async () => {
    const app = await buildApp();
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/check-ins",
      payload: {
        decision_id: randomUUID(),
        worth_it: "regret",
        answered_at: "2026-10-04T13:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "DECISION_NOT_FOUND" } });
  });
});

describe("rule settings", () => {
  it("creates, lists, updates, and deletes a rule", async () => {
    const app = await buildApp();
    openApps.push(app);

    const created = await app.inject({
      method: "POST",
      url: "/v1/rules",
      payload: {
        name: "Pause large purchases",
        rule_type: "cart_total",
        configuration: { threshold_minor: 10000 },
        enabled: true,
      },
    });
    expect(created.statusCode).toBe(201);
    const ruleId = created.json().id as string;

    const listed = await app.inject({ method: "GET", url: "/v1/rules" });
    expect(listed.json().rules).toHaveLength(1);

    const updated = await app.inject({
      method: "PATCH",
      url: `/v1/rules/${ruleId}`,
      payload: { enabled: false },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ id: ruleId, enabled: false });

    expect((await app.inject({ method: "DELETE", url: `/v1/rules/${ruleId}` })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/v1/rules" })).json().rules).toEqual([]);
  });

  it("hides another user's rule", async () => {
    const authService: AuthService = { authenticate: async (token) => ({ id: token }) };
    const app = await buildApp({ authRequired: true, authService });
    openApps.push(app);
    const created = await app.inject({
      method: "POST",
      url: "/v1/rules",
      headers: { authorization: "Bearer user-a" },
      payload: { name: "Rule", rule_type: "merchant", configuration: {}, enabled: true },
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/rules/${created.json().id}`,
      headers: { authorization: "Bearer user-b" },
      payload: { enabled: false },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "SETTING_NOT_FOUND" } });
  });

  it("rejects empty rule updates", async () => {
    const app = await buildApp();
    openApps.push(app);
    const response = await app.inject({ method: "PATCH", url: `/v1/rules/${randomUUID()}`, payload: {} });
    expect(response.statusCode).toBe(400);
  });
});

describe("budget settings", () => {
  it("creates, lists, updates, and deletes a budget", async () => {
    const app = await buildApp();
    openApps.push(app);
    const created = await app.inject({
      method: "POST",
      url: "/v1/budgets",
      payload: {
        currency: "USD",
        limit_minor: 50000,
        period_start: "2026-10-01",
        period_end: "2026-10-31",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().spent_minor).toBe(0);
    const budgetId = created.json().id as string;

    expect((await app.inject({ method: "GET", url: "/v1/budgets" })).json().budgets).toHaveLength(1);
    const updated = await app.inject({
      method: "PATCH",
      url: `/v1/budgets/${budgetId}`,
      payload: { limit_minor: 60000 },
    });
    expect(updated.json()).toMatchObject({ id: budgetId, limit_minor: 60000, spent_minor: 0 });

    expect((await app.inject({ method: "DELETE", url: `/v1/budgets/${budgetId}` })).statusCode).toBe(204);
  });

  it("rejects an invalid budget period", async () => {
    const app = await buildApp();
    openApps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/budgets",
      payload: { currency: "USD", limit_minor: 1000, period_start: "2026-11-01", period_end: "2026-10-01" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("requires authentication for settings endpoints", async () => {
    const app = await buildApp({ authRequired: true });
    openApps.push(app);
    expect((await app.inject({ method: "GET", url: "/v1/rules" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/budgets" })).statusCode).toBe(401);
  });
});

describe("GET /v1/config", () => {
  const amazon = { id: randomUUID(), domain: "www.amazon.com", enabled: true };
  const ebay = { id: randomUUID(), domain: "www.ebay.com", enabled: true };
  const v1 = { buttons: { add_to_cart: ["#add-to-cart-button"] } };
  const v2 = { buttons: { add_to_cart: ["#add-to-cart-button-v2"] }, selectors: { cart_subtotal: "#sc-subtotal" } };

  async function getConfig(repository: InMemoryStoreConfigRepository, options: Parameters<typeof buildApp>[0] = {}) {
    const app = await buildApp({ storeConfigRepository: repository, ...options });
    openApps.push(app);
    const response = await app.inject({ method: "GET", url: "/v1/config" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(StoreConfigSchema.safeParse(body).success).toBe(true);
    return body;
  }

  it("serves an empty default config when no stores are configured", async () => {
    const app = await buildApp();
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/v1/config" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ version: "default", stores: {} });
  });

  it("serves a store's overrides from its recipe", async () => {
    const repository = new InMemoryStoreConfigRepository({
      merchants: [amazon],
      recipes: [{ merchant_id: amazon.id, version: 1, enabled: true, selectors: v2 }],
    });

    const body = await getConfig(repository);

    expect(body.stores).toEqual({ "www.amazon.com": { enabled: true, ...v2 } });
    expect(body.version).toMatch(/^[0-9a-f]{64}$/);
  });

  it("serves a store with no enabled recipe as just its switch", async () => {
    const repository = new InMemoryStoreConfigRepository({
      merchants: [amazon],
      recipes: [{ merchant_id: amazon.id, version: 1, enabled: false, selectors: v1 }],
    });

    expect((await getConfig(repository)).stores).toEqual({ "www.amazon.com": { enabled: true } });
  });

  it("uses the latest enabled recipe version", async () => {
    const repository = new InMemoryStoreConfigRepository({
      merchants: [amazon],
      recipes: [
        { merchant_id: amazon.id, version: 2, enabled: true, selectors: v2 },
        { merchant_id: amazon.id, version: 1, enabled: true, selectors: v1 },
      ],
    });

    expect((await getConfig(repository)).stores["www.amazon.com"]).toEqual({ enabled: true, ...v2 });
  });

  it("rolls back to the previous version when the latest recipe is disabled", async () => {
    const repository = new InMemoryStoreConfigRepository({
      merchants: [amazon],
      recipes: [
        { merchant_id: amazon.id, version: 1, enabled: true, selectors: v1 },
        { merchant_id: amazon.id, version: 2, enabled: false, selectors: v2 },
      ],
    });

    expect((await getConfig(repository)).stores["www.amazon.com"]).toEqual({ enabled: true, ...v1 });
  });

  it("turns a store off with the merchant switch, even with recipes", async () => {
    const repository = new InMemoryStoreConfigRepository({
      merchants: [{ ...amazon, enabled: false }],
      recipes: [{ merchant_id: amazon.id, version: 1, enabled: true, selectors: v1 }],
    });

    expect((await getConfig(repository)).stores).toEqual({ "www.amazon.com": { enabled: false } });
  });

  it("skips an invalid recipe without falling back or breaking other stores", async () => {
    const repository = new InMemoryStoreConfigRepository({
      merchants: [amazon, ebay],
      recipes: [
        { merchant_id: amazon.id, version: 1, enabled: true, selectors: v1 },
        // page_view isn't a button intent, and enabled belongs to the merchant.
        { merchant_id: amazon.id, version: 2, enabled: true, selectors: { buttons: { page_view: ["#x"] } } },
        { merchant_id: ebay.id, version: 1, enabled: true, selectors: v1 },
      ],
    });

    expect((await getConfig(repository)).stores).toEqual({
      "www.amazon.com": { enabled: true },
      "www.ebay.com": { enabled: true, ...v1 },
    });
  });

  it.each([
    ["null", null],
    ["a string", "#add-to-cart"],
    ["an enabled key", { enabled: false, ...v1 }],
    ["an empty selector list", { buttons: { add_to_cart: [] } }],
  ])("skips a recipe that is %s", async (_label, selectors) => {
    const repository = new InMemoryStoreConfigRepository({
      merchants: [amazon],
      recipes: [{ merchant_id: amazon.id, version: 1, enabled: true, selectors }],
    });

    expect((await getConfig(repository)).stores).toEqual({ "www.amazon.com": { enabled: true } });
  });

  it("skips a merchant whose domain can't be a store key", async () => {
    const repository = new InMemoryStoreConfigRepository({
      merchants: [{ id: randomUUID(), domain: "  ", enabled: true }, ebay],
    });

    expect((await getConfig(repository)).stores).toEqual({ "www.ebay.com": { enabled: true } });
  });

  it("keys stores by lowercase hostname", async () => {
    const repository = new InMemoryStoreConfigRepository({
      merchants: [{ ...amazon, domain: "WWW.Amazon.com" }],
    });

    expect(Object.keys((await getConfig(repository)).stores)).toEqual(["www.amazon.com"]);
  });

  it("changes the version when an override changes, including a delete", async () => {
    const repository = new InMemoryStoreConfigRepository({
      merchants: [amazon],
      recipes: [{ merchant_id: amazon.id, version: 1, enabled: true, selectors: v1 }],
    });
    const app = await buildApp({ storeConfigRepository: repository });
    openApps.push(app);
    const version = async () => (await app.inject({ method: "GET", url: "/v1/config" })).json().version;

    const first = await version();
    expect(await version()).toBe(first);

    repository.upsertRecipe({ merchant_id: amazon.id, version: 2, enabled: true, selectors: v2 });
    const second = await version();
    expect(second).not.toBe(first);

    // Deleting the newest recipe goes back to exactly the first config.
    repository.deleteRecipe(amazon.id, 2);
    expect(await version()).toBe(first);

    repository.deleteRecipe(amazon.id, 1);
    expect(await version()).not.toBe(first);
  });

  it("keeps the version when the same config is stored in a different order", async () => {
    const a = new InMemoryStoreConfigRepository({
      merchants: [amazon, ebay],
      recipes: [{ merchant_id: amazon.id, version: 1, enabled: true, selectors: { selectors: { a: "#a", b: "#b" }, buttons: v1.buttons } }],
    });
    const b = new InMemoryStoreConfigRepository({
      merchants: [ebay, amazon],
      recipes: [{ merchant_id: amazon.id, version: 1, enabled: true, selectors: { buttons: v1.buttons, selectors: { b: "#b", a: "#a" } } }],
    });

    expect((await getConfig(a)).version).toBe((await getConfig(b)).version);
  });

  it("requires authentication like the other routes", async () => {
    const app = await buildApp({ authRequired: true, storeConfigRepository: new InMemoryStoreConfigRepository() });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/v1/config" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });
});
