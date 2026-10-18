import { describe, expect, it } from "vitest";

import type { DecisionEvent } from "@auxo/shared";

import { InMemoryDecisionRepository } from "./decision-repository.js";
import { InMemoryOutcomeRepository, utcDate } from "./outcome-repository.js";
import { InMemorySettingsRepository } from "./settings-repository.js";

const userId = "20000000-0000-4000-8000-000000000001";
const otherUserId = "30000000-0000-4000-8000-000000000001";
const decisionId = "10000000-0000-4000-8000-000000000001";

function bought(eventId: string, occurredAt = "2026-10-15T12:00:00.000Z"): DecisionEvent {
  return { event_id: eventId, decision_id: decisionId, action: "bought", occurred_at: occurredAt };
}

async function setup() {
  const decisions = new InMemoryDecisionRepository();
  await decisions.save({
    userId,
    cart: { merchant: "Example Store", items: [{ name: "Shoes", price_minor: 3_000, qty: 1 }], total_minor: 3_000, currency: "USD", url: "https://example.com/cart", cart_hash: "a".repeat(64) },
    verdict: { decision_id: decisionId, lane: "L0", action: "allow", template_id: "l0-pass", cooldown_seconds: 0 },
    context: { decision_id: decisionId, cart_summary: { merchant: "Example Store", total_minor: 3_000, currency: "USD", item_count: 1 }, budget: null, matched_rules: [], model_signal: null, decisive_factors: [{ code: "no_policy_match", source: "policy", lane: "L0" }], available_actions: ["continue"] },
    policyVersion: "test", modelProvider: "stub", modelVersion: "test", createdAt: "2026-10-15T11:00:00.000Z", expiresAt: "2026-10-16T11:00:00.000Z",
  });
  const settings = new InMemorySettingsRepository();
  const budget = await settings.createBudget(userId, { currency: "USD", limit_minor: 10_000, period_start: "2026-10-01", period_end: "2026-10-31" });
  return { decisions, settings, budget };
}

describe("InMemoryOutcomeRepository", () => {
  it("charges budgets once for the first bought event of a decision", async () => {
    const { decisions, settings, budget } = await setup();
    const repository = new InMemoryOutcomeRepository({ decisions, spend: settings });

    expect(await repository.saveEvent(userId, bought("40000000-0000-4000-8000-000000000001"))).toBe("created");
    expect(await repository.saveEvent(userId, bought("40000000-0000-4000-8000-000000000001"))).toBe("duplicate");
    expect(await repository.saveEvent(userId, bought("40000000-0000-4000-8000-000000000002"))).toBe("duplicate");

    expect((await settings.listBudgets(userId)).find((row) => row.id === budget.id)?.spent_minor).toBe(3_000);
  });

  it("records events without charging anything when spend tracking isn't wired", async () => {
    const { settings } = await setup();
    const repository = new InMemoryOutcomeRepository();

    expect(await repository.saveEvent(userId, bought("40000000-0000-4000-8000-000000000001"))).toBe("created");
    expect((await settings.listBudgets(userId))[0]?.spent_minor).toBe(0);
  });

  it("uses the UTC date of occurred_at", () => {
    expect(utcDate("2026-10-31T23:30:00-02:00")).toBe("2026-11-01");
    expect(utcDate("2026-11-01T00:30:00+02:00")).toBe("2026-10-31");
  });
});

describe("InMemorySettingsRepository.recordSpend", () => {
  it("charges only the user's budgets in that currency whose period contains the date", async () => {
    const settings = new InMemorySettingsRepository();
    const period = { period_start: "2026-10-01", period_end: "2026-10-31" };
    const matching = await settings.createBudget(userId, { currency: "USD", limit_minor: 1, ...period });
    const lastDay = await settings.createBudget(userId, { currency: "USD", limit_minor: 1, period_start: "2026-10-31", period_end: "2026-10-31" });
    const otherCurrency = await settings.createBudget(userId, { currency: "EUR", limit_minor: 1, ...period });
    const otherPeriod = await settings.createBudget(userId, { currency: "USD", limit_minor: 1, period_start: "2026-11-01", period_end: "2026-11-30" });
    const otherUser = await settings.createBudget(otherUserId, { currency: "USD", limit_minor: 1, ...period });

    await settings.recordSpend(userId, { currency: "USD", amountMinor: 700, occurredOn: "2026-10-31" });

    const rows = [...(await settings.listBudgets(userId)), ...(await settings.listBudgets(otherUserId))];
    const spent = new Map(rows.map((row) => [row.id, row.spent_minor]));
    expect(spent.get(matching.id)).toBe(700);
    expect(spent.get(lastDay.id)).toBe(700);
    expect(spent.get(otherCurrency.id)).toBe(0);
    expect(spent.get(otherPeriod.id)).toBe(0);
    expect(spent.get(otherUser.id)).toBe(0);
  });
});
