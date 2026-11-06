import { describe, expect, it } from "vitest";

import {
  budgetOn,
  chargeBudget,
  currentWindow,
  cycleStart,
  periodDays,
  stopRepeating,
  type StoredBudget,
} from "./budget-period.js";

function stored(overrides: Partial<StoredBudget> = {}): StoredBudget {
  return {
    id: "50000000-0000-4000-8000-000000000001",
    currency: "USD",
    limit_minor: 30_000,
    spent_minor: 0,
    spent_period_start: null,
    period_start: "2026-11-01",
    period_end: "2026-11-05",
    repeats: true,
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("periodDays", () => {
  it("counts both ends", () => {
    expect(periodDays({ period_start: "2026-11-01", period_end: "2026-11-05" })).toBe(5);
    expect(periodDays({ period_start: "2026-11-01", period_end: "2026-11-01" })).toBe(1);
  });

  it("counts across month, year and leap-day boundaries", () => {
    expect(periodDays({ period_start: "2026-12-30", period_end: "2027-01-02" })).toBe(4);
    expect(periodDays({ period_start: "2028-02-28", period_end: "2028-03-01" })).toBe(3);
  });
});

describe("cycleStart", () => {
  it("repeats the booked length back to back", () => {
    const budget = stored();
    expect(cycleStart(budget, "2026-11-01")).toBe("2026-11-01");
    expect(cycleStart(budget, "2026-11-05")).toBe("2026-11-01");
    expect(cycleStart(budget, "2026-11-06")).toBe("2026-11-06");
    expect(cycleStart(budget, "2026-11-10")).toBe("2026-11-06");
    expect(cycleStart(budget, "2026-11-11")).toBe("2026-11-11");
    expect(cycleStart(budget, "2027-01-01")).toBe("2026-12-31");
  });

  it("is the booked start for a one-off budget, or before the budget starts", () => {
    expect(cycleStart(stored({ repeats: false }), "2026-12-25")).toBe("2026-11-01");
    expect(cycleStart(stored(), "2026-10-15")).toBe("2026-11-01");
  });

  it("repeats a one-day budget every day", () => {
    const daily = stored({ period_end: "2026-11-01" });
    expect(currentWindow(daily, "2026-11-20")).toEqual({ period_start: "2026-11-20", period_end: "2026-11-20" });
  });
});

describe("budgetOn", () => {
  it("returns the current cycle and its length", () => {
    expect(budgetOn(stored(), "2026-11-12")).toMatchObject({
      period_start: "2026-11-11",
      period_end: "2026-11-15",
      period_days: 5,
      repeats: true,
    });
  });

  it("keeps a one-off budget on its booked dates after it ends", () => {
    expect(budgetOn(stored({ repeats: false, spent_minor: 900 }), "2026-11-20")).toMatchObject({
      period_start: "2026-11-01",
      period_end: "2026-11-05",
      spent_minor: 900,
    });
  });

  it("shows spending from an earlier cycle as 0", () => {
    const budget = stored({ spent_minor: 12_000, spent_period_start: "2026-11-01" });
    expect(budgetOn(budget, "2026-11-03").spent_minor).toBe(12_000);
    expect(budgetOn(budget, "2026-11-06").spent_minor).toBe(0);
  });

  it("returns no stored-only fields", () => {
    expect(Object.keys(budgetOn(stored(), "2026-11-01"))).not.toContain("spent_period_start");
  });
});

describe("chargeBudget", () => {
  it("adds to the cycle being counted", () => {
    expect(chargeBudget(stored({ spent_minor: 100 }), 250, "2026-11-04")).toEqual({
      spent_minor: 350,
      spent_period_start: "2026-11-01",
    });
  });

  it("starts the count over in a new cycle", () => {
    expect(chargeBudget(stored({ spent_minor: 29_000, spent_period_start: "2026-11-01" }), 250, "2026-11-07")).toEqual({
      spent_minor: 250,
      spent_period_start: "2026-11-06",
    });
  });

  it("skips a late purchase from an older cycle", () => {
    expect(chargeBudget(stored({ spent_minor: 500, spent_period_start: "2026-11-06" }), 250, "2026-11-02")).toBeNull();
  });

  it("skips a purchase before the budget starts, or after a one-off budget ends", () => {
    expect(chargeBudget(stored(), 250, "2026-10-31")).toBeNull();
    expect(chargeBudget(stored({ repeats: false }), 250, "2026-11-06")).toBeNull();
    expect(chargeBudget(stored({ repeats: false }), 250, "2026-11-05")).toEqual({
      spent_minor: 250,
      spent_period_start: "2026-11-01",
    });
  });
});

describe("stopRepeating", () => {
  it("keeps the current cycle as a one-off budget, with its spending", () => {
    expect(stopRepeating(stored({ spent_minor: 700, spent_period_start: "2026-11-11" }), "2026-11-13")).toEqual({
      period_start: "2026-11-11",
      period_end: "2026-11-15",
      repeats: false,
      spent_minor: 700,
      spent_period_start: "2026-11-11",
    });
  });

  it("drops spending from an earlier cycle", () => {
    expect(stopRepeating(stored({ spent_minor: 700, spent_period_start: "2026-11-01" }), "2026-11-13")).toMatchObject({
      period_start: "2026-11-11",
      spent_minor: 0,
    });
  });

  it("leaves a one-off budget's dates and spending alone", () => {
    expect(stopRepeating(stored({ repeats: false, spent_minor: 40 }), "2026-11-20")).toMatchObject({
      period_start: "2026-11-01",
      period_end: "2026-11-05",
      spent_minor: 40,
    });
  });
});
