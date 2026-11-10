import type { Budget } from "@auxo/shared";

// Repeating budgets. A budget is stored with the dates the user booked
// (period_start..period_end, both included) and `repeats`. A repeating budget
// runs the same number of days again right after each cycle ends, so a
// Nov 1-5 budget's cycles are Nov 1-5, Nov 6-10, Nov 11-15, and so on.
//
// spent_minor belongs to one cycle, the one starting on spent_period_start
// (null means the booked period_start). It's reset lazily: a purchase in a
// later cycle starts the count over, and reading a budget whose spending is
// from an earlier cycle shows 0. The SQL in record_decision_event
// (supabase/migrations/202611060001_repeating_budgets.sql) does the same.
// All dates are UTC YYYY-MM-DD, like the policy engine's.

export interface StoredBudget {
  id: string;
  currency: string;
  limit_minor: number;
  spent_minor: number;
  spent_period_start: string | null;
  period_start: string;
  period_end: string;
  repeats: boolean;
  created_at: string;
  updated_at: string;
}

type Period = Pick<StoredBudget, "period_start" | "period_end" | "repeats">;

const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00.000Z`) / DAY_MS);
}

function dateOf(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function utcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

// The number of days in one cycle, both ends included.
export function periodDays(period: Pick<Period, "period_start" | "period_end">): number {
  return dayNumber(period.period_end) - dayNumber(period.period_start) + 1;
}

// The first day of the cycle that contains `day`. That's the booked start for
// a budget that doesn't repeat, and for any day on or before its booked end.
export function cycleStart(period: Period, day: string): string {
  if (!period.repeats || day <= period.period_end) return period.period_start;
  const length = periodDays(period);
  const cycles = Math.floor((dayNumber(day) - dayNumber(period.period_start)) / length);
  return dateOf(dayNumber(period.period_start) + cycles * length);
}

// The cycle that contains `day` (the booked period if the budget doesn't
// repeat, or hasn't started yet).
export function currentWindow(period: Period, day: string): { period_start: string; period_end: string } {
  const start = cycleStart(period, day);
  return { period_start: start, period_end: dateOf(dayNumber(start) + periodDays(period) - 1) };
}

// The budget as the API returns it on `day`: its current cycle and what was
// spent in that cycle.
export function budgetOn(stored: StoredBudget, day: string): Budget {
  const window = currentWindow(stored, day);
  const spentCycle = stored.spent_period_start ?? stored.period_start;
  return {
    id: stored.id,
    currency: stored.currency,
    limit_minor: stored.limit_minor,
    spent_minor: spentCycle === window.period_start ? stored.spent_minor : 0,
    period_start: window.period_start,
    period_end: window.period_end,
    period_days: periodDays(stored),
    repeats: stored.repeats,
    created_at: stored.created_at,
    updated_at: stored.updated_at,
  };
}

// The budget after a purchase of `amountMinor` on `day`, or null when the
// purchase doesn't count toward it: before the budget starts, after a one-off
// budget ends, or in a cycle older than the one being counted (a late event).
export function chargeBudget(
  stored: StoredBudget,
  amountMinor: number,
  day: string,
): Pick<StoredBudget, "spent_minor" | "spent_period_start"> | null {
  if (day < stored.period_start || (!stored.repeats && day > stored.period_end)) return null;
  const cycle = cycleStart(stored, day);
  const counting = stored.spent_period_start ?? stored.period_start;
  if (cycle < counting) return null;
  return {
    spent_minor: cycle === counting ? stored.spent_minor + amountMinor : amountMinor,
    spent_period_start: cycle,
  };
}

// What to store when a repeating budget stops repeating on `day`: it becomes
// a one-off budget for its current cycle, keeping that cycle's spending.
export function stopRepeating(
  stored: StoredBudget,
  day: string,
): Pick<StoredBudget, "period_start" | "period_end" | "repeats" | "spent_minor" | "spent_period_start"> {
  const window = stored.repeats ? currentWindow(stored, day) : stored;
  const spentCycle = stored.spent_period_start ?? stored.period_start;
  const spentThisCycle = spentCycle === window.period_start;
  return {
    period_start: window.period_start,
    period_end: window.period_end,
    repeats: false,
    spent_minor: spentThisCycle ? stored.spent_minor : 0,
    spent_period_start: window.period_start,
  };
}
