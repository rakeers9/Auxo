import { createHash } from "node:crypto";

import type { Budget, Cart, DecisionReasonCode, Lane, Rule, Verdict, VerdictAction } from "@auxo/shared";

const LANE_RANK: Record<Lane, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
const LANE_POLICY: Record<
  Lane,
  { action: VerdictAction; cooldownSeconds: number; templateId: string }
> = {
  L0: { action: "allow", cooldownSeconds: 0, templateId: "l0-pass" },
  L1: { action: "allow", cooldownSeconds: 0, templateId: "l1-banner" },
  L2: { action: "pause", cooldownSeconds: 60, templateId: "l2-pause" },
  L3: { action: "block", cooldownSeconds: 300, templateId: "l3-block" },
  L4: { action: "block", cooldownSeconds: 900, templateId: "l4-block" },
};

export interface PolicyState {
  cart: Cart;
  rules: Rule[];
  budgets: Budget[];
  now: Date;
}

export interface PolicyFactor {
  code: DecisionReasonCode;
  source: "rule" | "budget" | "policy";
  lane: Lane;
  rule?: Rule;
  budget?: Budget;
}

export interface PolicyEvaluation {
  lane: Lane;
  factors: PolicyFactor[];
}

export function evaluatePolicy(state: PolicyState): Lane {
  return evaluatePolicyWithContext(state).lane;
}

export function evaluatePolicyWithContext(state: PolicyState): PolicyEvaluation {
  let lane: Lane = "L0";
  const factors: PolicyFactor[] = [];

  for (const rule of state.rules.filter((candidate) => candidate.enabled)) {
    const matchedLane = evaluateRule(rule, state.cart);
    if (matchedLane) {
      lane = maxLane(lane, matchedLane);
      factors.push({ code: `rule.${rule.rule_type}` as DecisionReasonCode, source: "rule", lane: matchedLane, rule });
    }
  }

  const budgets = state.budgets.filter(
    (candidate) =>
      candidate.currency === state.cart.currency &&
      candidate.period_start <= dateOnly(state.now) &&
      candidate.period_end >= dateOnly(state.now),
  );

  for (const budget of budgets) {
    const projected = budget.spent_minor + state.cart.total_minor;
    if (projected > budget.limit_minor) {
      lane = maxLane(lane, "L4");
      factors.push({ code: "budget.exceeded", source: "budget", lane: "L4", budget });
    }
    else if (budget.limit_minor > 0 && projected >= budget.limit_minor * 0.9) {
      lane = maxLane(lane, "L3");
      factors.push({ code: "budget.critical", source: "budget", lane: "L3", budget });
    } else if (budget.limit_minor > 0 && projected >= budget.limit_minor * 0.75) {
      lane = maxLane(lane, "L2");
      factors.push({ code: "budget.warning", source: "budget", lane: "L2", budget });
    }
  }

  if (factors.length === 0) factors.push({ code: "no_policy_match", source: "policy", lane: "L0" });
  return { lane, factors };
}

export function createPolicyVerdict(decisionId: string, lane: Lane): Verdict {
  const policy = LANE_POLICY[lane];
  return {
    decision_id: decisionId,
    lane,
    action: policy.action,
    template_id: policy.templateId,
    cooldown_seconds: policy.cooldownSeconds,
  };
}

export function policyVersion(rules: Rule[], budgets: Budget[]): string {
  const fingerprint = JSON.stringify({
    rules: rules
      .map(({ id, rule_type, configuration, enabled }) => ({ id, rule_type, configuration, enabled }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    budgets: budgets
      .map(({ id, currency, limit_minor, spent_minor, period_start, period_end }) => ({
        id,
        currency,
        limit_minor,
        spent_minor,
        period_start,
        period_end,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  });
  return `policy-v1:${createHash("sha256").update(fingerprint).digest("hex").slice(0, 16)}`;
}

function evaluateRule(rule: Rule, cart: Cart): Lane | null {
  const lane = configuredLane(rule.configuration);
  if (!lane) return null;

  if (rule.rule_type === "cart_total") {
    const threshold = rule.configuration.threshold_minor;
    return typeof threshold === "number" && Number.isSafeInteger(threshold) && cart.total_minor >= threshold
      ? lane
      : null;
  }

  if (rule.rule_type === "merchant") {
    const merchants = stringArray(rule.configuration.merchants);
    return merchants.some((merchant) => merchant.toLowerCase() === cart.merchant.toLowerCase())
      ? lane
      : null;
  }

  if (rule.rule_type === "item_keyword") {
    const keywords = stringArray(rule.configuration.keywords).map((keyword) => keyword.toLowerCase());
    return cart.items.some((item) => keywords.some((keyword) => item.name.toLowerCase().includes(keyword)))
      ? lane
      : null;
  }

  return null;
}

function configuredLane(configuration: Record<string, unknown>): Lane | null {
  const value = configuration.lane;
  return typeof value === "string" && value in LANE_RANK ? (value as Lane) : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

export function maxLane(left: Lane, right: Lane): Lane {
  return LANE_RANK[left] >= LANE_RANK[right] ? left : right;
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}
