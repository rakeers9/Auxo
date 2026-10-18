import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DecideResponseSchema, type Lane } from "@auxo/shared";

import { buildApp, type BuildAppOptions } from "./application.js";
import type { AuthService } from "./auth/auth-service.js";

// AUX-34: /v1/decide reads the user's last 30 days at the cart's merchant
// (purchases, spend, regret rate, override rate) into context.history.

const openApps: ReturnType<typeof buildApp>[] = [];

const users: Record<string, string> = {
  "user-a": "a0000000-0000-4000-8000-000000000001",
  "user-b": "b0000000-0000-4000-8000-000000000002",
};
const authService: AuthService = { authenticate: async (token) => (users[token] ? { id: users[token] } : null) };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"));
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

// buildApp's default wiring: in-memory decisions and outcomes, read by the
// in-memory history repository.
function app(options: BuildAppOptions = {}) {
  const instance = buildApp({ authRequired: true, authService, ...options });
  openApps.push(instance);
  return instance;
}

type App = ReturnType<typeof app>;

function auth(user: string) {
  return { authorization: `Bearer ${user}` };
}

// With no rules or model the stub picks the lane from the hash's last digit
// (0 → L0 allow, 2 → L2 pause, 3 → L3 block).
function hashFor(lane: Lane): string {
  return `${randomUUID().replaceAll("-", "").padEnd(63, "0")}${lane.slice(1)}`;
}

async function decide(
  instance: App,
  { merchant = "Example Store", total = 2_000, currency = "USD", lane = "L0" as Lane, user = "user-a" } = {},
) {
  const response = await instance.inject({
    method: "POST",
    url: "/v1/decide",
    headers: auth(user),
    payload: {
      cart: {
        merchant,
        items: [{ name: "Headphones", price_minor: total, qty: 1 }],
        total_minor: total,
        currency,
        url: "https://example.com/cart",
        cart_hash: hashFor(lane),
      },
    },
  });
  expect(response.statusCode).toBe(200);
  const verdict = DecideResponseSchema.parse(response.json());
  expect(verdict.lane).toBe(lane);
  return verdict;
}

async function sendEvent(instance: App, decisionId: string, action: string, occurredAt = new Date().toISOString(), user = "user-a") {
  const response = await instance.inject({
    method: "POST",
    url: "/v1/events",
    headers: auth(user),
    payload: { event_id: randomUUID(), decision_id: decisionId, action, occurred_at: occurredAt },
  });
  expect(response.statusCode).toBe(201);
}

async function checkIn(instance: App, decisionId: string, worthIt: string, answeredAt = new Date().toISOString(), user = "user-a") {
  const response = await instance.inject({
    method: "POST",
    url: "/v1/check-ins",
    headers: auth(user),
    payload: { decision_id: decisionId, worth_it: worthIt, answered_at: answeredAt },
  });
  expect(response.statusCode).toBe(201);
}

describe("merchant history in /v1/decide (AUX-34)", () => {
  it("starts empty with null rates", async () => {
    const verdict = await decide(app());
    expect(verdict.context.history).toEqual({
      merchant: "Example Store",
      window_days: 30,
      purchases: 0,
      spent_minor: 0,
      check_ins: 0,
      regret_rate: null,
      override_rate: null,
    });
  });

  it("reflects bought, check-in, and overrode events in the next decision", async () => {
    const instance = app();

    const first = await decide(instance, { total: 2_000 });
    await sendEvent(instance, first.decision_id, "bought");
    await checkIn(instance, first.decision_id, "regret");

    const second = await decide(instance, { merchant: "example STORE", total: 3_000 });
    await sendEvent(instance, second.decision_id, "bought");
    await checkIn(instance, second.decision_id, "yes");

    const paused = await decide(instance, { lane: "L2" });
    await sendEvent(instance, paused.decision_id, "overrode");
    const blocked = await decide(instance, { lane: "L3" });
    await sendEvent(instance, blocked.decision_id, "left");

    // Another merchant, another currency, another user: none count here.
    const elsewhere = await decide(instance, { merchant: "Other Store", total: 9_000 });
    await sendEvent(instance, elsewhere.decision_id, "bought");
    const euros = await decide(instance, { total: 5_000, currency: "EUR" });
    await sendEvent(instance, euros.decision_id, "bought");
    const theirs = await decide(instance, { user: "user-b", lane: "L3" });
    await sendEvent(instance, theirs.decision_id, "overrode", undefined, "user-b");
    await checkIn(instance, theirs.decision_id, "regret", undefined, "user-b");

    const next = await decide(instance, { merchant: "Example Store" });
    expect(next.context.history).toEqual({
      merchant: "Example Store",
      window_days: 30,
      // Both USD purchases and the EUR one; only USD carts are summed.
      purchases: 3,
      spent_minor: 5_000,
      check_ins: 2,
      regret_rate: 0.5,
      // One of the two guarded (paused or blocked) decisions was overridden.
      override_rate: 0.5,
    });

    const inEuros = await decide(instance, { currency: "EUR" });
    expect(inEuros.context.history).toMatchObject({ purchases: 3, spent_minor: 5_000 });
  });

  it("drops activity older than 30 days", async () => {
    const instance = app();
    const old = await decide(instance);
    await sendEvent(instance, old.decision_id, "bought", "2026-09-15T11:59:59.000Z");
    await checkIn(instance, old.decision_id, "regret", "2026-09-15T11:59:59.000Z");
    const recent = await decide(instance);
    await sendEvent(instance, recent.decision_id, "bought", "2026-09-15T12:00:00.000Z");

    const next = await decide(instance);
    expect(next.context.history).toMatchObject({ purchases: 1, spent_minor: 2_000, check_ins: 0, regret_rate: null });
  });

  it("still decides, without history, when the history lookup fails", async () => {
    const instance = app({
      historyRepository: { merchantHistory: async () => Promise.reject(new Error("database down")) },
    });
    const verdict = await decide(instance, { lane: "L3" });
    expect(verdict.context).not.toHaveProperty("history");
  });

  it("still decides, without history, when the history lookup times out", async () => {
    const instance = app({
      historyRepository: { merchantHistory: () => new Promise(() => undefined) },
      historyTimeoutMs: 10,
    });
    const verdict = await decide(instance, { lane: "L2" });
    expect(verdict.context).not.toHaveProperty("history");
  });

  it("has no history when the outcome repository isn't in memory and none is given", async () => {
    const instance = app({
      outcomeRepository: { saveEvent: async () => "created", saveCheckIn: async () => "created" },
    });
    const verdict = await decide(instance);
    expect(verdict.context).not.toHaveProperty("history");
  });
});
