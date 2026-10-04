import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { VerdictSchema } from "@auxo/shared";

import { buildApp } from "./app.js";
import type { AuthService } from "./auth/auth-service.js";

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
    expect(VerdictSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      lane,
      action,
      cooldown_seconds: cooldownSeconds,
    });
  });

  it("returns the same verdict for the same cart hash", async () => {
    const app = await buildApp();
    openApps.push(app);
    const payload = { cart: cartWithHashSuffix("2") };

    const first = await app.inject({ method: "POST", url: "/v1/decide", payload });
    const second = await app.inject({ method: "POST", url: "/v1/decide", payload });

    expect(second.json()).toEqual(first.json());
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
    expect(VerdictSchema.safeParse(response.json()).success).toBe(true);
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

    expect(response.json()).toMatchObject({ lane: "L3", action: "block" });
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

    expect(response.json()).toMatchObject({ lane: "L4", action: "block" });
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
