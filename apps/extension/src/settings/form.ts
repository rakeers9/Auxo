import {
  RULE_DESCRIPTION_MAX_LENGTH,
  RuleConfigurationSchemas,
  type Budget,
  type CreateBudget,
  type CreateRule,
  type Lane,
  type Rule,
} from "@auxo/shared";

import { formatMoney } from "../wishlist/view";
import { repeatPhrase, shortDate } from "./budget-calendar";

// What each lane does, in plain words. The cooldowns match LANE_POLICY in
// apps/api/src/services/policy-engine.ts; change both together.
export const LANE_LABELS: Record<Lane, string> = {
  L0: "Don't step in",
  L1: "Show a reminder",
  L2: "Pause for 1 minute",
  L3: "Block for 5 minutes",
  L4: "Block for 15 minutes",
};
export const LANES: readonly Lane[] = ["L0", "L1", "L2", "L3", "L4"];

// A free-text rule may leave the lane to Auxo (the decision model picks it).
export const AUTO_LANE = "auto";
export const AUTO_LANE_LABEL = "Let Auxo decide";
export type LaneChoice = Lane | typeof AUTO_LANE;

export function isLane(value: string): value is Lane {
  return (LANES as readonly string[]).includes(value);
}

// Rule names are stored with each rule and capped at 100 characters.
const NAME_MAX_LENGTH = 100;

function nameFrom(text: string): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length <= NAME_MAX_LENGTH ? clean : `${clean.slice(0, NAME_MAX_LENGTH - 1)}…`;
}

// "25", "25.5", "$1,250.00" → minor units (cents). Null for anything else.
export function parseDollars(text: string): number | null {
  const clean = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const [whole = "0", fraction = ""] = clean.split(".");
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(minor) ? minor : null;
}

export function descriptionRule(text: string, lane: LaneChoice): CreateRule | null {
  const description = text.trim();
  if (description === "" || description.length > RULE_DESCRIPTION_MAX_LENGTH) return null;
  return {
    name: nameFrom(description),
    rule_type: "description",
    configuration: lane === AUTO_LANE ? { description } : { description, lane },
    enabled: true,
  };
}

export function cartTotalRule(amount: string, lane: Lane): CreateRule | null {
  const threshold = parseDollars(amount);
  if (threshold === null) return null;
  return {
    name: `Carts of ${formatMoney(threshold, "USD")} or more`,
    rule_type: "cart_total",
    configuration: { threshold_minor: threshold, lane },
    enabled: true,
  };
}

// Stores are matched by the merchant the extension reports, e.g. amazon.com.
export function merchantRule(store: string, lane: Lane): CreateRule | null {
  const merchant = store.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(merchant)) return null;
  return {
    name: `Shopping at ${merchant}`,
    rule_type: "merchant",
    configuration: { merchants: [merchant], lane },
    enabled: true,
  };
}

// The configuration for a rule with a different lane. Null for a lane the
// rule's type can't take (only free-text rules can leave it to Auxo).
export function withLane(rule: Rule, lane: LaneChoice): Record<string, unknown> | null {
  if (rule.rule_type === "description") {
    const parsed = RuleConfigurationSchemas.description.safeParse(rule.configuration);
    if (!parsed.success) return null;
    return lane === AUTO_LANE ? { description: parsed.data.description } : { description: parsed.data.description, lane };
  }
  if (lane === AUTO_LANE) return null;
  return { ...rule.configuration, lane };
}

export function laneOf(rule: Rule): LaneChoice {
  const lane = rule.configuration.lane;
  return typeof lane === "string" && isLane(lane) ? lane : AUTO_LANE;
}

// One line describing what a rule matches.
export function ruleSummary(rule: Rule): string {
  const config = rule.configuration;
  switch (rule.rule_type) {
    case "description":
      return typeof config.description === "string" ? `“${config.description}”` : rule.name;
    case "cart_total":
      return typeof config.threshold_minor === "number"
        ? `Any cart of ${formatMoney(config.threshold_minor, "USD")} or more`
        : rule.name;
    case "merchant":
      return Array.isArray(config.merchants) ? `Any cart at ${config.merchants.join(", ")}` : rule.name;
    case "item_keyword":
      return Array.isArray(config.keywords) ? `Items named ${config.keywords.join(", ")}` : rule.name;
    default:
      return rule.name;
  }
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// The current calendar month in local time, as YYYY-MM-DD dates.
export function monthRange(now: Date): { start: string; end: string } {
  const year = now.getFullYear();
  const month = now.getMonth();
  const lastDay = new Date(year, month + 1, 0).getDate();
  return { start: isoDate(year, month, 1), end: isoDate(year, month, lastDay) };
}

// `repeats`: the same number of days starts again after `end`, with spending
// back at 0 (apps/api/src/services/budget-period.ts).
export function budgetFrom(amount: string, start: string, end: string | null, repeats = false): CreateBudget | null {
  const limit = parseDollars(amount);
  const date = /^\d{4}-\d{2}-\d{2}$/;
  if (limit === null || limit === 0 || end === null || !date.test(start) || !date.test(end) || end < start) return null;
  return { currency: "USD", limit_minor: limit, period_start: start, period_end: end, repeats };
}

// The API returns a repeating budget for its current cycle.
export function budgetSummary(budget: Budget, thisYear?: number): string {
  const spent = formatMoney(budget.spent_minor, budget.currency);
  const limit = formatMoney(budget.limit_minor, budget.currency);
  const dates = `${shortDate(budget.period_start, thisYear)} to ${shortDate(budget.period_end, thisYear)}`;
  return budget.repeats
    ? `${spent} of ${limit} spent this cycle, ${dates}, repeats ${repeatPhrase(budget.period_days)}`
    : `${spent} of ${limit} spent, ${dates}`;
}
