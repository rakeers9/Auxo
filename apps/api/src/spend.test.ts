import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BudgetSchema, DecideResponseSchema, type Budget } from "@auxo/shared";

import { buildApp } from "./application.js";
import type { AuthService } from "./auth/auth-service.js";
import { InMemoryDecisionRepository } from "./repositories/decision-repository.js";
import { InMemoryOutcomeRepository } from "./repositories/outcome-repository.js";
import { InMemorySettingsRepository } from "./repositories/settings-repository.js";

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

// The same wiring as runtime.ts uses without Supabase: the outcome repository
// shares the decision and settings repositories so `bought` charges budgets.
function app() {
  const decisionRepository = new InMemoryDecisionRepository();
  const settingsRepository = new InMemorySettingsRepository();
  const instance = buildApp({
    authRequired: true,
    authService,
    decisionRepository,
    settingsRepository,
    outcomeRepository: new InMemoryOutcomeRepository({ decisions: decisionRepository, spend: settingsRepository }),
  });
  openApps.push(instance);
  return instance;
}

type App = ReturnType<typeof app>;

function auth(user: string) {
  return { authorization: `Bearer ${user}` };
}

async function createBudget(instance: App, body: Record<string, unknown>, user = "user-a"): Promise<Budget> {
  const response = await instance.inject({ method: "POST", url: "/v1/budgets", headers: auth(user), payload: body });
  expect(response.statusCode).toBe(201);
  return BudgetSchema.parse(response.json());
}

async function budgets(instance: App, user = "user-a"): Promise<Map<string, number>> {
  const response = await instance.inject({ method: "GET", url: "/v1/budgets", headers: auth(user) });
  const list = (response.json() as { budgets: Budget[] }).budgets;
  return new Map(list.map((budget) => [budget.id, budget.spent_minor]));
}

async function decide(instance: App, totalMinor: number, currency = "USD", user = "user-a") {
  const response = await instance.inject({
    method: "POST",
    url: "/v1/decide",
    headers: auth(user),
    payload: {
      cart: {
        merchant: "Example Store",
        items: [{ name: "Headphones", price_minor: totalMinor, qty: 1 }],
        total_minor: totalMinor,
        currency,
        url: "https://example.com/cart",
        cart_hash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      },
    },
  });
  expect(response.statusCode).toBe(200);
  return DecideResponseSchema.parse(response.json());
}

async function sendEvent(
  instance: App,
  decisionId: string,
  action: string,
  occurredAt = "2026-10-15T12:05:00.000Z",
  eventId: string = randomUUID(),
  user = "user-a",
) {
  return instance.inject({
    method: "POST",
    url: "/v1/events",
    headers: auth(user),
    payload: { event_id: eventId, decision_id: decisionId, action, occurred_at: occurredAt },
  });
}

describe("spend tracking from bought events", () => {
  it("adds the cart total to the matching budget, and the next decision sees it", async () => {
    const instance = app();
    const october = await createBudget(instance, { currency: "USD", limit_minor: 10_000, period_start: "2026-10-01", period_end: "2026-10-31" });

    const first = await decide(instance, 4_000);
    expect(first.lane).toBe("L0");
    expect(first.context.budget).toEqual({ limit_minor: 10_000, spent_minor: 0, projected_minor: 4_000, would_exceed: false });

    const bought = await sendEvent(instance, first.decision_id, "bought");
    expect(bought.statusCode).toBe(201);
    expect(bought.json()).toEqual({ accepted: true, duplicate: false });
    expect((await budgets(instance)).get(october.id)).toBe(4_000);

    // 4,000 spent + 4,000 in the cart = 80% of the limit: budget warning (L2).
    const second = await decide(instance, 4_000);
    expect(second.context.budget).toEqual({ limit_minor: 10_000, spent_minor: 4_000, projected_minor: 8_000, would_exceed: false });
    expect(second.lane).toBe("L2");
    expect(second.context.decisive_factors).toContainEqual({ code: "budget.warning", source: "budget", lane: "L2" });

    expect((await sendEvent(instance, second.decision_id, "bought")).statusCode).toBe(201);

    // 8,000 spent + 4,000 = over the limit: L4.
    const third = await decide(instance, 4_000);
    expect(third.context.budget).toMatchObject({ spent_minor: 8_000, projected_minor: 12_000, would_exceed: true });
    expect(third.lane).toBe("L4");
  });

  it("tracks spend with buildApp's default in-memory repositories", async () => {
    const instance = buildApp({ authRequired: true, authService });
    openApps.push(instance);
    const budget = await createBudget(instance, { currency: "USD", limit_minor: 10_000, period_start: "2026-10-01", period_end: "2026-10-31" });
    const decision = await decide(instance, 3_000);

    expect((await sendEvent(instance, decision.decision_id, "bought")).statusCode).toBe(201);
    expect((await budgets(instance)).get(budget.id)).toBe(3_000);
  });

  it("counts one purchase per decision however often bought is sent", async () => {
    const instance = app();
    const budget = await createBudget(instance, { currency: "USD", limit_minor: 10_000, period_start: "2026-10-01", period_end: "2026-10-31" });
    const decision = await decide(instance, 2_500);
    const eventId = randomUUID();

    expect((await sendEvent(instance, decision.decision_id, "bought", undefined, eventId)).statusCode).toBe(201);
    const replay = await sendEvent(instance, decision.decision_id, "bought", undefined, eventId);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ accepted: true, duplicate: true });
    const secondBought = await sendEvent(instance, decision.decision_id, "bought");
    expect(secondBought.statusCode).toBe(200);
    expect(secondBought.json()).toEqual({ accepted: true, duplicate: true });

    expect((await budgets(instance)).get(budget.id)).toBe(2_500);
  });

  it("leaves other currencies, other periods, other users, and other events alone", async () => {
    const instance = app();
    const usdOctober = await createBudget(instance, { currency: "USD", limit_minor: 10_000, period_start: "2026-10-01", period_end: "2026-10-31" });
    const usdNovember = await createBudget(instance, { currency: "USD", limit_minor: 10_000, period_start: "2026-11-01", period_end: "2026-11-30" });
    const eurOctober = await createBudget(instance, { currency: "EUR", limit_minor: 10_000, period_start: "2026-10-01", period_end: "2026-10-31" });
    const otherUser = await createBudget(instance, { currency: "USD", limit_minor: 10_000, period_start: "2026-10-01", period_end: "2026-10-31" }, "user-b");

    const left = await decide(instance, 1_000);
    expect((await sendEvent(instance, left.decision_id, "left")).statusCode).toBe(201);
    const saved = await decide(instance, 1_000);
    expect((await sendEvent(instance, saved.decision_id, "saved")).statusCode).toBe(201);

    const purchase = await decide(instance, 3_000);
    expect((await sendEvent(instance, purchase.decision_id, "bought")).statusCode).toBe(201);

    expect(Object.fromEntries(await budgets(instance))).toEqual({
      [usdOctober.id]: 3_000,
      [usdNovember.id]: 0,
      [eurOctober.id]: 0,
    });
    expect((await budgets(instance, "user-b")).get(otherUser.id)).toBe(0);
  });

  it("charges the budget whose period contains occurred_at (as a UTC date)", async () => {
    const instance = app();
    const october = await createBudget(instance, { currency: "USD", limit_minor: 10_000, period_start: "2026-10-01", period_end: "2026-10-31" });
    const november = await createBudget(instance, { currency: "USD", limit_minor: 10_000, period_start: "2026-11-01", period_end: "2026-11-30" });
    const decision = await decide(instance, 1_500);

    // 23:30 on Oct 31 at UTC-2 is 01:30 on Nov 1 UTC.
    expect((await sendEvent(instance, decision.decision_id, "bought", "2026-10-31T23:30:00-02:00")).statusCode).toBe(201);

    const spent = await budgets(instance);
    expect(spent.get(october.id)).toBe(0);
    expect(spent.get(november.id)).toBe(1_500);
  });

  it("charges an EUR purchase to the EUR budget only", async () => {
    const instance = app();
    const usd = await createBudget(instance, { currency: "USD", limit_minor: 10_000, period_start: "2026-10-01", period_end: "2026-10-31" });
    const eur = await createBudget(instance, { currency: "EUR", limit_minor: 10_000, period_start: "2026-10-01", period_end: "2026-10-31" });
    const decision = await decide(instance, 2_000, "EUR");

    expect((await sendEvent(instance, decision.decision_id, "bought")).statusCode).toBe(201);

    const spent = await budgets(instance);
    expect(spent.get(usd.id)).toBe(0);
    expect(spent.get(eur.id)).toBe(2_000);
  });

  it("does not let another user's bought event charge anything", async () => {
    const instance = app();
    const budget = await createBudget(instance, { currency: "USD", limit_minor: 10_000, period_start: "2026-10-01", period_end: "2026-10-31" });
    const decision = await decide(instance, 2_000);

    const response = await sendEvent(instance, decision.decision_id, "bought", undefined, randomUUID(), "user-b");

    expect(response.statusCode).toBe(404);
    expect((await budgets(instance)).get(budget.id)).toBe(0);
  });
});

describe("repeating budgets", () => {
  // The clock is 2026-10-15. The booked period Oct 11-15 repeats every 5 days.
  const booked = { currency: "USD", limit_minor: 10_000, period_start: "2026-10-11", period_end: "2026-10-15", repeats: true };

  async function listed(instance: App): Promise<Budget[]> {
    const response = await instance.inject({ method: "GET", url: "/v1/budgets", headers: auth("user-a") });
    return (response.json() as { budgets: Budget[] }).budgets.map((budget) => BudgetSchema.parse(budget));
  }

  it("returns the cycle length and the current cycle", async () => {
    const instance = app();
    const created = await createBudget(instance, booked);
    expect(created).toMatchObject({ period_start: "2026-10-11", period_end: "2026-10-15", period_days: 5, repeats: true });

    vi.setSystemTime(new Date("2026-10-23T12:00:00.000Z"));
    expect(await listed(instance)).toEqual([
      expect.objectContaining({ period_start: "2026-10-21", period_end: "2026-10-25", period_days: 5, spent_minor: 0 }),
    ]);
  });

  it("defaults to not repeating", async () => {
    const instance = app();
    const created = await createBudget(instance, { ...booked, repeats: undefined });
    expect(created.repeats).toBe(false);

    vi.setSystemTime(new Date("2026-10-23T12:00:00.000Z"));
    expect((await listed(instance))[0]).toMatchObject({ period_start: "2026-10-11", period_end: "2026-10-15" });
  });

  it("resets spending at the start of each cycle, and the decision sees the reset", async () => {
    const instance = app();
    const budget = await createBudget(instance, booked);

    const first = await decide(instance, 8_000);
    expect((await sendEvent(instance, first.decision_id, "bought")).statusCode).toBe(201);
    expect((await budgets(instance)).get(budget.id)).toBe(8_000);
    // 8,000 spent + 4,000 = over the limit in this cycle.
    expect((await decide(instance, 4_000)).lane).toBe("L4");

    // The next cycle (Oct 16-20) starts with nothing spent.
    vi.setSystemTime(new Date("2026-10-16T09:00:00.000Z"));
    expect((await budgets(instance)).get(budget.id)).toBe(0);
    const next = await decide(instance, 4_000);
    expect(next.lane).toBe("L0");
    expect(next.context.budget).toEqual({ limit_minor: 10_000, spent_minor: 0, projected_minor: 4_000, would_exceed: false });

    expect((await sendEvent(instance, next.decision_id, "bought", "2026-10-16T09:05:00.000Z")).statusCode).toBe(201);
    expect((await budgets(instance)).get(budget.id)).toBe(4_000);
  });

  it("doesn't count a late bought event toward the new cycle", async () => {
    const instance = app();
    const budget = await createBudget(instance, booked);
    const early = await decide(instance, 2_000);
    vi.setSystemTime(new Date("2026-10-17T12:00:00.000Z"));
    const late = await decide(instance, 3_000);

    expect((await sendEvent(instance, late.decision_id, "bought", "2026-10-17T12:05:00.000Z")).statusCode).toBe(201);
    // Placed on Oct 15 (the previous cycle), reported after Oct 17's purchase.
    expect((await sendEvent(instance, early.decision_id, "bought", "2026-10-15T12:05:00.000Z")).statusCode).toBe(201);

    expect((await budgets(instance)).get(budget.id)).toBe(3_000);
  });

  it("turns repeating on and off, ending after the current cycle", async () => {
    const instance = app();
    const budget = await createBudget(instance, { ...booked, repeats: false });
    const decision = await decide(instance, 1_000);
    expect((await sendEvent(instance, decision.decision_id, "bought")).statusCode).toBe(201);

    const on = await instance.inject({ method: "PATCH", url: `/v1/budgets/${budget.id}`, headers: auth("user-a"), payload: { repeats: true } });
    expect(BudgetSchema.parse(on.json())).toMatchObject({ repeats: true, spent_minor: 1_000 });

    vi.setSystemTime(new Date("2026-10-27T12:00:00.000Z"));
    const off = await instance.inject({ method: "PATCH", url: `/v1/budgets/${budget.id}`, headers: auth("user-a"), payload: { repeats: false } });
    expect(BudgetSchema.parse(off.json())).toMatchObject({ repeats: false, period_start: "2026-10-26", period_end: "2026-10-30", spent_minor: 0 });

    // It stays on its last cycle once that has passed.
    vi.setSystemTime(new Date("2026-11-04T12:00:00.000Z"));
    expect((await listed(instance))[0]).toMatchObject({ period_start: "2026-10-26", period_end: "2026-10-30" });
  });
});
