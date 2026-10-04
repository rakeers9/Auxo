import type { Cart, Verdict } from "@auxo/shared";

import type { DecisionRepository } from "../repositories/decision-repository.js";
import type { SettingsRepository } from "../repositories/settings-repository.js";
import type { JevDecisionProvider, JevSignal } from "./jev-provider.js";
import { createPolicyVerdict, evaluatePolicy, maxLane, policyVersion } from "./policy-engine.js";
import { createStubVerdict } from "./stub-decision.js";

export const STUB_POLICY_VERSION = "stub-v1";

export interface DecisionServiceOptions {
  repository: DecisionRepository;
  settingsRepository?: SettingsRepository;
  jevProvider?: JevDecisionProvider;
  onJevError?: (error: unknown) => void;
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
    const version = this.options.jevProvider
      ? `${baseVersion}:jev:${this.options.jevProvider.modelVersion}`
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
    let jevSignal: JevSignal | null = null;

    if (this.options.jevProvider) {
      try {
        jevSignal = await this.options.jevProvider.evaluate({
          cart,
          rules,
          budgets,
          deterministicLane: deterministicLane ?? "L0",
        });
      } catch (error) {
        this.options.onJevError?.(error);
      }
    }

    const policyLane = jevSignal
      ? maxLane(deterministicLane ?? "L0", jevSignal.lane)
      : deterministicLane ?? (this.options.jevProvider ? "L0" : null);
    const verdict = policyLane
      ? createPolicyVerdict(cart, userId, policyLane, version)
      : createStubVerdict(cart, userId);
    const expiresAt = new Date(now.getTime() + this.options.ttlSeconds * 1_000);

    await this.options.repository.save({
      userId,
      cart,
      verdict,
      policyVersion: version,
      modelProvider: jevSignal
        ? "typesafe-jev"
        : this.options.jevProvider
          ? "jev-fallback"
          : hasPolicyData
            ? "policy-engine"
            : "stub",
      modelVersion: jevSignal?.model ?? (hasPolicyData ? "v1" : "deterministic-v1"),
      ...(jevSignal ? { modelOutput: jevSignal } : {}),
      expiresAt: expiresAt.toISOString(),
    });

    return verdict;
  }
}
