import { randomUUID } from "node:crypto";

import {
  REDUCING_INTENTS,
  type Budget,
  type Cart,
  type DecideResponse,
  type DecisionContext,
  type DecisionHistory,
  type Rule,
  type Trigger,
  type TriggerIntent,
  type Verdict,
} from "@auxo/shared";

import type { DecisionRecord, DecisionRepository } from "../repositories/decision-repository.js";
import { HISTORY_WINDOW_DAYS, type HistoryRepository } from "../repositories/history-repository.js";
import type { SettingsRepository } from "../repositories/settings-repository.js";
import type { DecisionModelProvider, DecisionSignal } from "./decision-model-provider.js";
import { createPolicyVerdict, evaluatePolicyWithContext, maxLane, policyVersion, type PolicyEvaluation } from "./policy-engine.js";
import { stubLane } from "./stub-decision.js";

export const STUB_POLICY_VERSION = "stub-v1";
export const DEFAULT_HISTORY_TIMEOUT_MS = 300;

export class HistoryTimeoutError extends Error {
  public constructor(timeoutMs: number) {
    super(`Merchant history took longer than ${timeoutMs}ms; deciding without it.`);
    this.name = "HistoryTimeoutError";
  }
}

type DecisiveFactor = DecisionContext["decisive_factors"][number];

const REDUCING = new Set<TriggerIntent>(REDUCING_INTENTS);

export function isReducingTrigger(trigger: Trigger | undefined): boolean {
  return trigger !== undefined && REDUCING.has(trigger.intent);
}

export interface DecisionServiceOptions {
  repository: DecisionRepository;
  settingsRepository?: SettingsRepository;
  decisionModelProvider?: DecisionModelProvider;
  onDecisionModelError?: (error: unknown) => void;
  // AUX-34: the user's recent history at the cart's merchant. Optional and
  // best effort: on error or after historyTimeoutMs the decision goes ahead
  // without it and onHistoryError is told why.
  historyRepository?: HistoryRepository;
  historyTimeoutMs?: number;
  onHistoryError?: (error: unknown) => void;
  ttlSeconds: number;
  now?: () => Date;
  newDecisionId?: () => string;
}

interface Outcome {
  verdict: Verdict;
  decisiveFactors: DecisiveFactor[];
  modelSignal: DecisionSignal | null;
  policyVersion: string;
  modelProvider: DecisionRecord["modelProvider"];
  modelVersion: string;
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
  public async decide(userId: string, cart: Cart, trigger?: Trigger): Promise<DecideResponse> {
    const now = this.now();
    const reducing = isReducingTrigger(trigger);
    // Started before the settings are read so the two run concurrently. A
    // reducing trigger always gets L0, so its history isn't needed.
    const historyPromise = reducing ? Promise.resolve(null) : this.loadHistory(userId, cart, now);
    const [rules, budgets] = this.options.settingsRepository
      ? await Promise.all([
          this.options.settingsRepository.listRules(userId),
          this.options.settingsRepository.listBudgets(userId),
        ])
      : [[], []];
    const hasPolicyData = rules.length > 0 || budgets.length > 0;
    const baseVersion = hasPolicyData ? policyVersion(rules, budgets) : STUB_POLICY_VERSION;
    // Evaluated even for a reducing trigger, so matched rules and the budget
    // still show up in the context for information.
    const policyEvaluation = evaluatePolicyWithContext({ cart, rules, budgets, now });
    const decisionId = this.newDecisionId();
    let outcome: Outcome;

    if (reducing) {
      // AUX-30: lowering the cart (decrease qty, remove, save for later) is
      // always allowed. No rule, budget, or model can raise the lane, so the
      // model isn't asked. The decision is still recorded fresh.
      outcome = {
        verdict: createPolicyVerdict(decisionId, "L0"),
        decisiveFactors: [{ code: "trigger.reducing", source: "policy", lane: "L0" }],
        modelSignal: null,
        policyVersion: baseVersion,
        modelProvider: "policy-engine",
        modelVersion: "v1",
      };
    } else if (hasPolicyData || this.options.decisionModelProvider) {
      const history = await historyPromise;
      outcome = await this.decideWithPolicyAndModel(decisionId, cart, rules, budgets, history, hasPolicyData, baseVersion, policyEvaluation);
    } else {
      // No rules, no budgets, no model: the stub picks the lane from cart_hash,
      // so it is the decisive factor whatever lane it picked (L0 included).
      // `no_policy_match` is kept for when the policy engine ran and matched
      // nothing.
      const lane = stubLane(cart);
      outcome = {
        verdict: createPolicyVerdict(decisionId, lane),
        decisiveFactors: [{ code: "stub.hash", source: "policy", lane }],
        modelSignal: null,
        policyVersion: baseVersion,
        modelProvider: "stub",
        modelVersion: "deterministic-v1",
      };
    }

    const expiresAt = new Date(now.getTime() + this.options.ttlSeconds * 1_000);
    const history = await historyPromise;
    const context = createDecisionContext(outcome, cart, budgets, now, policyEvaluation, history);

    await this.options.repository.save({
      userId,
      cart,
      verdict: outcome.verdict,
      policyVersion: outcome.policyVersion,
      modelProvider: outcome.modelProvider,
      modelVersion: outcome.modelVersion,
      ...(outcome.modelSignal ? { modelOutput: outcome.modelSignal } : {}),
      context,
      expiresAt: expiresAt.toISOString(),
      createdAt: now.toISOString(),
      ...(trigger ? { trigger } : {}),
    });

    return { ...outcome.verdict, context };
  }

  // Never throws and never waits longer than historyTimeoutMs: history only
  // informs the model and the context, so a decision must not depend on it.
  private async loadHistory(userId: string, cart: Cart, now: Date): Promise<DecisionHistory | null> {
    const repository = this.options.historyRepository;
    if (!repository) return null;
    const timeoutMs = this.options.historyTimeoutMs ?? DEFAULT_HISTORY_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new HistoryTimeoutError(timeoutMs)), timeoutMs);
      });
      // Called synchronously so the query starts before the settings reads;
      // a synchronous throw lands in the catch below.
      const lookup = repository.merchantHistory(userId, { merchant: cart.merchant, currency: cart.currency, now, windowDays: HISTORY_WINDOW_DAYS });
      // A lookup that fails after the timeout has nobody waiting on it.
      lookup.catch(() => undefined);
      return await Promise.race([lookup, timeout]);
    } catch (error) {
      this.options.onHistoryError?.(error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async decideWithPolicyAndModel(
    decisionId: string,
    cart: Cart,
    rules: Rule[],
    budgets: Budget[],
    history: DecisionHistory | null,
    hasPolicyData: boolean,
    baseVersion: string,
    evaluation: PolicyEvaluation,
  ): Promise<Outcome> {
    // With no rules or budgets the engine matches nothing, so its lane is L0.
    const deterministicLane = evaluation.lane;
    const provider = this.options.decisionModelProvider;
    let modelSignal: DecisionSignal | null = null;

    if (provider) {
      try {
        modelSignal = await provider.evaluate({ cart, rules, budgets, deterministicLane, ...(history ? { history } : {}) });
      } catch (error) {
        this.options.onDecisionModelError?.(error);
      }
    }

    const lane = modelSignal ? maxLane(deterministicLane, modelSignal.lane) : deterministicLane;
    const decisiveFactors: DecisiveFactor[] = evaluation.factors.map(({ code, source, lane: factorLane }) => ({
      code,
      source,
      lane: factorLane,
    }));
    // Whenever the model is stricter than the policy, say so, with or without rules.
    if (modelSignal && lane !== deterministicLane) {
      decisiveFactors.push({ code: "model.escalation", source: "model", lane: modelSignal.lane });
    }

    return {
      verdict: createPolicyVerdict(decisionId, lane),
      decisiveFactors,
      modelSignal,
      policyVersion: provider ? `${baseVersion}:model:${provider.modelVersion}` : baseVersion,
      modelProvider: modelSignal ? "cloudflare-clef" : provider ? "model-fallback" : "policy-engine",
      modelVersion: modelSignal?.model ?? (hasPolicyData ? "v1" : "deterministic-v1"),
    };
  }
}

function createDecisionContext(
  outcome: Outcome,
  cart: Cart,
  budgets: Budget[],
  now: Date,
  evaluation: PolicyEvaluation,
  history: DecisionHistory | null,
): DecisionContext {
  const { verdict, modelSignal } = outcome;
  const activeBudget = budgets
    .filter((budget) => budget.currency === cart.currency && budget.period_start <= dateOnly(now) && budget.period_end >= dateOnly(now))
    .sort((left, right) => (right.spent_minor + cart.total_minor) / Math.max(right.limit_minor, 1) - (left.spent_minor + cart.total_minor) / Math.max(left.limit_minor, 1))[0];

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
    decisive_factors: outcome.decisiveFactors,
    available_actions: verdict.action === "allow"
      ? ["continue"]
      : verdict.action === "pause"
        ? ["leave", "save_for_later", "continue"]
        : ["leave", "save_for_later", "override_after_cooldown"],
    ...(history ? { history } : {}),
  };
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}
