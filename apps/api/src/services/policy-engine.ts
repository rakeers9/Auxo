import { createHash } from "node:crypto";

import {
  RuleConfigurationSchemas,
  type Budget,
  type Cart,
  type DecisionReasonCode,
  type Lane,
  type Rule,
  type RuleType,
  type Verdict,
  type VerdictAction,
} from "@auxo/shared";

const LANE_RANK: Record<Lane, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };

// The one place a lane maps to its verdict fields (the stub uses it through
// createPolicyVerdict).
const LANE_POLICY: Readonly<Record<
  Lane,
  { action: VerdictAction; cooldownSeconds: number; templateId: string }
>> = {
  L0: { action: "allow", cooldownSeconds: 0, templateId: "l0-pass" },
  L1: { action: "allow", cooldownSeconds: 0, templateId: "l1-banner" },
  L2: { action: "pause", cooldownSeconds: 60, templateId: "l2-pause" },
  L3: { action: "block", cooldownSeconds: 300, templateId: "l3-block" },
  L4: { action: "block", cooldownSeconds: 900, templateId: "l4-block" },
};

const RULE_REASON_CODES: Record<RuleType, DecisionReasonCode> = {
  cart_total: "rule.cart_total",
  merchant: "rule.merchant",
  item_keyword: "rule.item_keyword",
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
      factors.push({ code: RULE_REASON_CODES[rule.rule_type], source: "rule", lane: matchedLane, rule });
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

// A rule whose stored configuration doesn't match its type's schema (or whose
// type is unknown) is ignored rather than failing the decision.
function evaluateRule(rule: Rule, cart: Cart): Lane | null {
  switch (rule.rule_type) {
    case "cart_total": {
      const parsed = RuleConfigurationSchemas.cart_total.safeParse(rule.configuration);
      if (!parsed.success) return null;
      return cart.total_minor >= parsed.data.threshold_minor ? parsed.data.lane : null;
    }
    case "merchant": {
      const parsed = RuleConfigurationSchemas.merchant.safeParse(rule.configuration);
      if (!parsed.success) return null;
      const merchant = cart.merchant.toLowerCase();
      return parsed.data.merchants.some((candidate) => candidate.toLowerCase() === merchant) ? parsed.data.lane : null;
    }
    case "item_keyword": {
      const parsed = RuleConfigurationSchemas.item_keyword.safeParse(rule.configuration);
      if (!parsed.success) return null;
      const keywords = parsed.data.keywords.map((keyword) => keyword.toLowerCase());
      return cart.items.some((item) => keywords.some((keyword) => item.name.toLowerCase().includes(keyword)))
        ? parsed.data.lane
        : null;
    }
    default:
      return null;
  }
}

export function maxLane(left: Lane, right: Lane): Lane {
  return LANE_RANK[left] >= LANE_RANK[right] ? left : right;
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}
