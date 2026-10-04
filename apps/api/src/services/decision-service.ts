import type { Cart, Verdict } from "@auxo/shared";

import type { DecisionRepository } from "../repositories/decision-repository.js";
import type { SettingsRepository } from "../repositories/settings-repository.js";
import { createPolicyVerdict, evaluatePolicy, policyVersion } from "./policy-engine.js";
import { createStubVerdict } from "./stub-decision.js";

export const STUB_POLICY_VERSION = "stub-v1";

export interface DecisionServiceOptions {
  repository: DecisionRepository;
  settingsRepository?: SettingsRepository;
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
    const version = hasPolicyData ? policyVersion(rules, budgets) : STUB_POLICY_VERSION;
    const existing = await this.options.repository.findActive(
      userId,
      cart.cart_hash,
      version,
      now,
    );

    if (existing) {
      return existing;
    }

    const verdict = hasPolicyData
      ? createPolicyVerdict(cart, userId, evaluatePolicy({ cart, rules, budgets, now }), version)
      : createStubVerdict(cart, userId);
    const expiresAt = new Date(now.getTime() + this.options.ttlSeconds * 1_000);

    await this.options.repository.save({
      userId,
      cart,
      verdict,
      policyVersion: version,
      modelProvider: hasPolicyData ? "policy-engine" : "stub",
      modelVersion: hasPolicyData ? "v1" : "deterministic-v1",
      expiresAt: expiresAt.toISOString(),
    });

    return verdict;
  }
}
