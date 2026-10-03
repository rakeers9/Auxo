import type { Cart, Verdict } from "@auxo/shared";

import type { DecisionRepository } from "../repositories/decision-repository.js";
import { createStubVerdict } from "./stub-decision.js";

export const STUB_POLICY_VERSION = "stub-v1";

export interface DecisionServiceOptions {
  repository: DecisionRepository;
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
    const existing = await this.options.repository.findActive(
      userId,
      cart.cart_hash,
      STUB_POLICY_VERSION,
      now,
    );

    if (existing) {
      return existing;
    }

    const verdict = createStubVerdict(cart, userId);
    const expiresAt = new Date(now.getTime() + this.options.ttlSeconds * 1_000);

    await this.options.repository.save({
      userId,
      cart,
      verdict,
      policyVersion: STUB_POLICY_VERSION,
      expiresAt: expiresAt.toISOString(),
    });

    return verdict;
  }
}
