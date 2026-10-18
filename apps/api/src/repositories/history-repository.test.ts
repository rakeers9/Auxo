import { describe, expect, it } from "vitest";

import { DecisionHistorySchema, type CheckIn, type DecisionEvent, type WorthIt } from "@auxo/shared";

import { computeMerchantHistory, type HistoryDecision, type HistoryInput, type HistoryQuery } from "./history-repository.js";

const USER = "user-a";
const OTHER = "user-b";
const now = new Date("2026-10-18T12:00:00.000Z");
const query: HistoryQuery = { merchant: "Example Store", currency: "USD", now, windowDays: 30 };
// The window is [2026-09-18T12:00:00Z, 2026-10-18T12:00:00Z].
const WINDOW_START = "2026-09-18T12:00:00.000Z";
const INSIDE = "2026-10-10T09:00:00.000Z";

let counter = 0;
function id(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
}

function decision(overrides: Partial<HistoryDecision> & { merchant?: string; currency?: string; total?: number } = {}): HistoryDecision {
  return {
    id: overrides.id ?? id(),
    userId: overrides.userId ?? USER,
    cart: { merchant: overrides.merchant ?? "Example Store", currency: overrides.currency ?? "USD", total_minor: overrides.total ?? 1_000 },
    action: overrides.action ?? "allow",
    createdAt: overrides.createdAt ?? INSIDE,
  };
}

function event(decisionId: string, action: DecisionEvent["action"], occurredAt = INSIDE, userId = USER) {
  return { userId, event: { event_id: id(), decision_id: decisionId, action, occurred_at: occurredAt } };
}

function checkIn(decisionId: string, worthIt: WorthIt, answeredAt = INSIDE, userId = USER) {
  const value: CheckIn = { decision_id: decisionId, worth_it: worthIt, answered_at: answeredAt };
  return { userId, checkIn: value };
}

function history(input: Partial<HistoryInput>, overrides: Partial<HistoryQuery> = {}) {
  const result = computeMerchantHistory(USER, { ...query, ...overrides }, { decisions: [], events: [], checkIns: [], ...input });
  expect(DecisionHistorySchema.parse(result)).toEqual(result);
  return result;
}

describe("computeMerchantHistory", () => {
  it("is empty with null rates when there is no history", () => {
    expect(history({})).toEqual({
      merchant: "Example Store",
      window_days: 30,
      purchases: 0,
      spent_minor: 0,
      check_ins: 0,
      regret_rate: null,
      override_rate: null,
    });
  });

  it("counts purchases and spend at the merchant, case-insensitively", () => {
    const upper = decision({ merchant: "EXAMPLE STORE", total: 2_500 });
    const lower = decision({ merchant: "example store", total: 1_500 });
    const elsewhere = decision({ merchant: "Other Store", total: 9_999 });
    const result = history({
      decisions: [upper, lower, elsewhere],
      events: [event(upper.id, "bought"), event(lower.id, "bought"), event(elsewhere.id, "bought")],
    });
    expect(result).toMatchObject({ purchases: 2, spent_minor: 4_000 });
  });

  it("sums spend in the current cart's currency only, but counts every purchase", () => {
    const usd = decision({ total: 2_000 });
    const eur = decision({ currency: "EUR", total: 7_000 });
    const result = history({ decisions: [usd, eur], events: [event(usd.id, "bought"), event(eur.id, "bought")] });
    expect(result).toMatchObject({ purchases: 2, spent_minor: 2_000 });
    expect(history({ decisions: [usd, eur], events: [event(usd.id, "bought"), event(eur.id, "bought")] }, { currency: "EUR" }))
      .toMatchObject({ purchases: 2, spent_minor: 7_000 });
  });

  it("includes both ends of the 30-day window and nothing outside it", () => {
    const atStart = decision();
    const atNow = decision();
    const beforeStart = decision();
    const future = decision();
    const result = history({
      decisions: [atStart, atNow, beforeStart, future],
      events: [
        event(atStart.id, "bought", WINDOW_START),
        // Same instant as now, written with an offset.
        event(atNow.id, "bought", "2026-10-18T14:00:00.000+02:00"),
        event(beforeStart.id, "bought", "2026-09-18T11:59:59.999Z"),
        event(future.id, "bought", "2026-10-18T12:00:00.001Z"),
      ],
      checkIns: [
        checkIn(atStart.id, "regret", WINDOW_START),
        checkIn(beforeStart.id, "regret", "2026-09-18T11:59:59.999Z"),
      ],
    });
    expect(result).toMatchObject({ purchases: 2, spent_minor: 2_000, check_ins: 1, regret_rate: 1 });
  });

  it("computes the regret rate from check-ins at the merchant answered in the window", () => {
    const decisions = [decision(), decision(), decision(), decision(), decision({ merchant: "Other Store" })];
    const [a, b, c, d, other] = decisions.map((row) => row.id) as [string, string, string, string, string];
    const result = history({
      decisions,
      checkIns: [
        checkIn(a, "regret"),
        checkIn(b, "yes"),
        checkIn(c, "meh"),
        checkIn(d, "regret"),
        checkIn(other, "regret"),
      ],
    });
    expect(result).toMatchObject({ check_ins: 4, regret_rate: 0.5 });
  });

  it("computes the override rate over paused and blocked decisions created in the window", () => {
    const paused = decision({ action: "pause" });
    const blocked = decision({ action: "block" });
    const blockedKept = decision({ action: "block" });
    const allowed = decision({ action: "allow" });
    const oldBlock = decision({ action: "block", createdAt: "2026-09-01T00:00:00.000Z" });
    const result = history({
      decisions: [paused, blocked, blockedKept, allowed, oldBlock],
      events: [
        event(paused.id, "overrode"),
        event(blocked.id, "overrode"),
        // A second override of the same decision counts once.
        event(blocked.id, "overrode"),
        event(blockedKept.id, "left"),
        // Overriding an allowed decision isn't counted.
        event(allowed.id, "overrode"),
        event(oldBlock.id, "overrode"),
      ],
    });
    expect(result.override_rate).toBeCloseTo(2 / 3);
    // Only allowed decisions: no paused or blocked ones, so no rate.
    expect(history({ decisions: [allowed], events: [event(allowed.id, "overrode")] }).override_rate).toBeNull();
  });

  it("ignores other users' decisions, events, and check-ins", () => {
    const theirs = decision({ userId: OTHER, action: "block" });
    const mine = decision({ action: "pause" });
    const result = history({
      decisions: [theirs, mine],
      events: [
        event(theirs.id, "bought", INSIDE, OTHER),
        event(theirs.id, "overrode", INSIDE, OTHER),
        // An event row filed under the wrong user is ignored too.
        event(mine.id, "bought", INSIDE, OTHER),
      ],
      checkIns: [checkIn(theirs.id, "regret", INSIDE, OTHER)],
    });
    expect(result).toEqual({
      merchant: "Example Store",
      window_days: 30,
      purchases: 0,
      spent_minor: 0,
      check_ins: 0,
      regret_rate: null,
      override_rate: 0,
    });
  });
});
