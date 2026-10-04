import type { Pass } from "@auxo/shared";
import type { DecisionRepository } from "../repositories/decision-repository.js";
import type { PassRepository } from "../repositories/pass-repository.js";

export class PassNotAvailableError extends Error {}

export class PassService {
  public constructor(
    private readonly decisions: DecisionRepository,
    private readonly passes: PassRepository,
    private readonly ttlSeconds = 600,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async issue(userId: string, decisionId: string): Promise<Pass> {
    const decision = await this.decisions.findOwned(userId, decisionId);
    if (!decision) throw new PassNotAvailableError("Decision not found.");
    if (decision.verdict.action === "allow") throw new PassNotAvailableError("This decision does not require a pass.");
    const now = this.now();
    const availableAt = new Date(decision.createdAt).getTime() + decision.verdict.cooldown_seconds * 1_000;
    if (now.getTime() < availableAt) throw new PassNotAvailableError("The decision cooldown is still active.");
    return this.passes.create({
      userId,
      decisionId,
      cartHash: decision.cart.cart_hash,
      merchant: decision.cart.merchant,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlSeconds * 1_000).toISOString(),
    });
  }

  public active(userId: string, cartHash: string): Promise<Pass | null> {
    return this.passes.findActive(userId, cartHash, this.now());
  }
}
