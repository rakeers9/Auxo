import { randomUUID } from "node:crypto";

import type { Budget, Cart, DecideResponse, DecisionContext, Lane, Verdict } from "@auxo/shared";

import type { DecisionRepository } from "../repositories/decision-repository.js";
import type { SettingsRepository } from "../repositories/settings-repository.js";
import type { DecisionModelProvider, DecisionSignal } from "./decision-model-provider.js";
import { createPolicyVerdict, evaluatePolicyWithContext, maxLane, policyVersion, type PolicyEvaluation } from "./policy-engine.js";
import { createStubVerdict } from "./stub-decision.js";

export const STUB_POLICY_VERSION = "stub-v1";

export interface DecisionServiceOptions {
  repository: DecisionRepository;
  settingsRepository?: SettingsRepository;
  decisionModelProvider?: DecisionModelProvider;
  onDecisionModelError?: (error: unknown) => void;
  ttlSeconds: number;
  now?: () => Date;
  newDecisionId?: () => string;
}

export class DecisionService {
  private readonly now: () => Date;
  private readonly newDecisionId: () => string;

  public constructor(private readonly options: DecisionServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newDecisionId = options.newDecisionId ?? randomUUID;
  }

  // Every request is analyzed fresh and gets its own decision_id; past
  // decisions are never reused, so the same cart can get a different answer.
  public async decide(userId: string, cart: Cart): Promise<DecideResponse> {
    const now = this.now();
    const [rules, budgets] = this.options.settingsRepository
      ? await Promise.all([
          this.options.settingsRepository.listRules(userId),
          this.options.settingsRepository.listBudgets(userId),
        ])
      : [[], []];
    const hasPolicyData = rules.length > 0 || budgets.length > 0;
    const baseVersion = hasPolicyData ? policyVersion(rules, budgets) : STUB_POLICY_VERSION;
    const version = this.options.decisionModelProvider
      ? `${baseVersion}:model:${this.options.decisionModelProvider.modelVersion}`
      : baseVersion;
    const policyEvaluation = evaluatePolicyWithContext({ cart, rules, budgets, now });
    const deterministicLane = hasPolicyData ? policyEvaluation.lane : null;
    let modelSignal: DecisionSignal | null = null;

    if (this.options.decisionModelProvider) {
      try {
        modelSignal = await this.options.decisionModelProvider.evaluate({
          cart,
          rules,
          budgets,
          deterministicLane: deterministicLane ?? "L0",
        });
      } catch (error) {
        this.options.onDecisionModelError?.(error);
      }
    }

    const policyLane = modelSignal
      ? maxLane(deterministicLane ?? "L0", modelSignal.lane)
      : deterministicLane ?? (this.options.decisionModelProvider ? "L0" : null);
    const decisionId = this.newDecisionId();
    const verdict = policyLane
      ? createPolicyVerdict(decisionId, policyLane)
      : createStubVerdict(cart, decisionId);
    const expiresAt = new Date(now.getTime() + this.options.ttlSeconds * 1_000);
    const context = createDecisionContext(
      verdict,
      cart,
      budgets,
      now,
      policyEvaluation,
      modelSignal,
      deterministicLane,
    );

    await this.options.repository.save({
      userId,
      cart,
      verdict,
      policyVersion: version,
      modelProvider: modelSignal
        ? "cloudflare-clef"
        : this.options.decisionModelProvider
          ? "model-fallback"
          : hasPolicyData
            ? "policy-engine"
            : "stub",
      modelVersion: modelSignal?.model ?? (hasPolicyData ? "v1" : "deterministic-v1"),
      ...(modelSignal ? { modelOutput: modelSignal } : {}),
      context,
      expiresAt: expiresAt.toISOString(),
      createdAt: now.toISOString(),
    });

    return { ...verdict, context };
  }
}

function createDecisionContext(
  verdict: Verdict,
  cart: Cart,
  budgets: Budget[],
  now: Date,
  evaluation: PolicyEvaluation,
  modelSignal: DecisionSignal | null,
  deterministicLane: Lane | null,
): DecisionContext {
  const activeBudget = budgets
    .filter((budget) => budget.currency === cart.currency && budget.period_start <= dateOnly(now) && budget.period_end >= dateOnly(now))
    .sort((left, right) => (right.spent_minor + cart.total_minor) / Math.max(right.limit_minor, 1) - (left.spent_minor + cart.total_minor) / Math.max(left.limit_minor, 1))[0];
  const modelEscalated = modelSignal && deterministicLane !== null && maxLane(deterministicLane, modelSignal.lane) !== deterministicLane;
  const decisiveFactors: DecisionContext["decisive_factors"] = evaluation.factors.map(
    ({ code, source, lane }) => ({ code, source, lane }),
  );
  if (modelEscalated) decisiveFactors.push({ code: "model.escalation", source: "model", lane: modelSignal.lane });

  return {
    decision_id: verdict.decision_id,
    cart_summary: {
      merchant: cart.merchant,
      total_minor: cart.total_minor,
      currency: cart.currency,
      item_count: cart.items.reduce((total, item) => total + item.qty, 0),
    },
    budget: activeBudget
      ? {
          limit_minor: activeBudget.limit_minor,
          spent_minor: activeBudget.spent_minor,
          projected_minor: activeBudget.spent_minor + cart.total_minor,
          would_exceed: activeBudget.spent_minor + cart.total_minor > activeBudget.limit_minor,
        }
      : null,
    matched_rules: evaluation.factors.flatMap((factor) => factor.rule
      ? [{ rule_id: factor.rule.id, name: factor.rule.name, rule_type: factor.rule.rule_type, lane: factor.lane }]
      : []),
    model_signal: modelSignal
      ? { provider: "cloudflare-clef", model: modelSignal.model, suggested_lane: modelSignal.lane, confidence: modelSignal.confidence }
      : null,
    decisive_factors: decisiveFactors,
    available_actions: verdict.action === "allow"
      ? ["continue"]
      : verdict.action === "pause"
        ? ["leave", "save_for_later", "continue"]
        : ["leave", "save_for_later", "override_after_cooldown"],
  };
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}
