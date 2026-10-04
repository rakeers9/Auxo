import type { Cart, Verdict } from "@auxo/shared";

import type { DecisionRepository } from "../repositories/decision-repository.js";
import type { SettingsRepository } from "../repositories/settings-repository.js";
import type { DecisionModelProvider, DecisionSignal } from "./decision-model-provider.js";
import { createPolicyVerdict, evaluatePolicy, maxLane, policyVersion } from "./policy-engine.js";
import { createStubVerdict } from "./stub-decision.js";

export const STUB_POLICY_VERSION = "stub-v1";

export interface DecisionServiceOptions {
  repository: DecisionRepository;
  settingsRepository?: SettingsRepository;
  decisionModelProvider?: DecisionModelProvider;
  onDecisionModelError?: (error: unknown) => void;
  ttlSeconds: number;
  now?: () => Date;
}

export class DecisionService {
  private readonly now: () => Date;

  public constructor(private readonly options: DecisionServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  public async decide(userId: string, cart: Cart): Promise<Verdict> {
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
    const existing = await this.options.repository.findActive(
      userId,
      cart.cart_hash,
      version,
      now,
    );

    if (existing) {
      return existing;
    }

    const deterministicLane = hasPolicyData
      ? evaluatePolicy({ cart, rules, budgets, now })
      : null;
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
    const verdict = policyLane
      ? createPolicyVerdict(cart, userId, policyLane, version)
      : createStubVerdict(cart, userId);
    const expiresAt = new Date(now.getTime() + this.options.ttlSeconds * 1_000);

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
      expiresAt: expiresAt.toISOString(),
    });

    return verdict;
  }
}
