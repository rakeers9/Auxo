import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActivePassResponseSchema, PassSchema } from "@auxo/shared";

import { buildApp, type BuildAppOptions } from "./application.js";
import type { AuthService } from "./auth/auth-service.js";

const openApps: ReturnType<typeof buildApp>[] = [];
const START = new Date("2026-10-18T12:00:00.000Z");

const users: Record<string, string> = {
  "user-a": "a0000000-0000-4000-8000-000000000001",
  "user-b": "b0000000-0000-4000-8000-000000000002",
};
const authService: AuthService = { authenticate: async (token) => (users[token] ? { id: users[token] } : null) };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function app(options: BuildAppOptions = {}) {
  const instance = buildApp({ authRequired: true, authService, ...options });
  openApps.push(instance);
  return instance;
}

function advance(seconds: number) {
  vi.setSystemTime(new Date(Date.now() + seconds * 1_000));
}

// The stub picks the lane from the hash's last hex digit: 0-1 allow, 3 is L3
// (block, 300 s cooldown).
function cart(cartHash: string) {
  return {
    merchant: "Example Store",
    items: [{ name: "Example item", price_minor: 2_500, qty: 1 }],
    total_minor: 2_500,
    currency: "USD",
    url: "https://example.com/cart",
    cart_hash: cartHash,
  };
}

const L3_HASH = `${"0".repeat(63)}3`;

async function decide(instance: ReturnType<typeof buildApp>, cartHash = L3_HASH, user = "user-a"): Promise<string> {
  const response = await instance.inject({
    method: "POST",
    url: "/v1/decide",
    headers: { authorization: `Bearer ${user}` },
    payload: { cart: cart(cartHash) },
  });
  expect(response.statusCode).toBe(200);
  return response.json().decision_id as string;
}

function issue(instance: ReturnType<typeof buildApp>, decisionId: string, user = "user-a") {
  return instance.inject({
    method: "POST",
    url: "/v1/passes",
    headers: { authorization: `Bearer ${user}` },
    payload: { decision_id: decisionId },
  });
}

function active(instance: ReturnType<typeof buildApp>, cartHash: string, user = "user-a") {
  return instance.inject({
    method: "GET",
    url: `/v1/passes/active?cart_hash=${encodeURIComponent(cartHash)}`,
    headers: { authorization: `Bearer ${user}` },
  });
}

describe("POST /v1/passes", () => {
  it("refuses a pass while the cooldown is still running", async () => {
    const instance = app();
    const decisionId = await decide(instance);
    advance(299);

    const response = await issue(instance, decisionId);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "PASS_NOT_AVAILABLE",
        message: "The decision cooldown is still active.",
        details: { reason: "cooldown_active" },
      },
    });
  });

  it("issues a pass once the cooldown has elapsed and reuses it while it's active", async () => {
    const instance = app({ passTtlSeconds: 600 });
    const decisionId = await decide(instance);
    advance(300);

    const first = await issue(instance, decisionId);
    expect(first.statusCode).toBe(201);
    const pass = PassSchema.parse(first.json());
    expect(pass).toMatchObject({ decision_id: decisionId, cart_hash: L3_HASH, merchant: "Example Store" });
    expect(pass.expires_at).toBe(new Date(START.getTime() + 900_000).toISOString());

    advance(599);
    const second = await issue(instance, decisionId);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(pass);
  });

  it("issues a new pass after the previous one expired", async () => {
    const instance = app({ passTtlSeconds: 600 });
    const decisionId = await decide(instance);
    advance(300);
    const first = PassSchema.parse((await issue(instance, decisionId)).json());

    advance(600);
    expect(ActivePassResponseSchema.parse((await active(instance, L3_HASH)).json())).toEqual({ pass: null });

    const reissued = await issue(instance, decisionId);
    expect(reissued.statusCode).toBe(201);
    const second = PassSchema.parse(reissued.json());
    expect(second.pass_id).not.toBe(first.pass_id);
    expect(second.expires_at).toBe(new Date(Date.now() + 600_000).toISOString());
    expect((await active(instance, L3_HASH)).json()).toEqual({ pass: second });
  });

  it("refuses a pass for an expired decision", async () => {
    const instance = app({ decisionTtlSeconds: 1_000 });
    const decisionId = await decide(instance);
    advance(1_000);

    const response = await issue(instance, decisionId);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "PASS_NOT_AVAILABLE",
        message: "The decision has expired. Request a new decision.",
        details: { reason: "decision_expired" },
      },
    });
  });

  it("refuses a pass for a decision that never blocked", async () => {
    const instance = app();
    const decisionId = await decide(instance, `${"0".repeat(63)}0`);

    const response = await issue(instance, decisionId);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "PASS_NOT_AVAILABLE", details: { reason: "not_required" } } });
  });

  it("returns 404 for an unknown decision, like events and check-ins", async () => {
    const instance = app();

    const response = await issue(instance, randomUUID());

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "DECISION_NOT_FOUND", message: "The decision does not exist for the authenticated user." },
    });
  });

  it("returns 404 for another user's decision", async () => {
    const instance = app();
    const decisionId = await decide(instance, L3_HASH, "user-a");
    advance(300);

    const response = await issue(instance, decisionId, "user-b");

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "DECISION_NOT_FOUND" } });
  });

  it("rejects an invalid request and a missing token", async () => {
    const instance = app();

    expect((await instance.inject({ method: "POST", url: "/v1/passes", headers: { authorization: "Bearer user-a" }, payload: { decision_id: "nope" } })).statusCode).toBe(400);
    expect((await instance.inject({ method: "POST", url: "/v1/passes", payload: { decision_id: randomUUID() } })).statusCode).toBe(401);
  });
});

describe("GET /v1/passes/active", () => {
  it("finds the pass whatever the case of the hash", async () => {
    const instance = app();
    const mixedCase = `sha256:${"Ab".repeat(31)}C3`;
    const decisionId = await decide(instance, mixedCase);
    advance(300);
    const pass = PassSchema.parse((await issue(instance, decisionId)).json());
    expect(pass.cart_hash).toBe(mixedCase.toLowerCase());

    for (const query of [mixedCase, mixedCase.toLowerCase(), mixedCase.toUpperCase()]) {
      const response = await active(instance, query);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ pass });
    }
  });

  it("does not show another user's pass", async () => {
    const instance = app();
    const decisionId = await decide(instance);
    advance(300);
    expect((await issue(instance, decisionId)).statusCode).toBe(201);

    expect((await active(instance, L3_HASH, "user-b")).json()).toEqual({ pass: null });
  });

  it("returns null when there is no pass and rejects a bad hash", async () => {
    const instance = app();

    expect((await active(instance, L3_HASH)).json()).toEqual({ pass: null });
    expect((await active(instance, "not-a-hash")).statusCode).toBe(400);
  });
});
