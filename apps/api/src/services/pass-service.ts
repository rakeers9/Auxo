import type { Pass } from "@auxo/shared";
import type { DecisionRepository } from "../repositories/decision-repository.js";
import type { PassRepository } from "../repositories/pass-repository.js";
import { DecisionNotFoundError } from "./outcome-service.js";

export type PassUnavailableReason = "not_required" | "cooldown_active" | "decision_expired";

// 409 PASS_NOT_AVAILABLE; `reason` says why (sent as error.details.reason).
export class PassNotAvailableError extends Error {
  public constructor(message: string, public readonly reason: PassUnavailableReason) {
    super(message);
    this.name = "PassNotAvailableError";
  }
}

export class PassService {
  public constructor(
    private readonly decisions: DecisionRepository,
    private readonly passes: PassRepository,
    private readonly ttlSeconds = 600,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // Returns the decision's active pass if it has one, otherwise issues a new
  // one (also after an earlier pass expired). Unknown or another user's
  // decision: DecisionNotFoundError (404, same as events and check-ins).
  public async issue(userId: string, decisionId: string): Promise<Pass> {
    const decision = await this.decisions.findOwned(userId, decisionId);
    if (!decision) throw new DecisionNotFoundError();
    if (decision.verdict.action === "allow") {
      throw new PassNotAvailableError("This decision does not require a pass.", "not_required");
    }
    const now = this.now();
    if (now.getTime() >= Date.parse(decision.expiresAt)) {
      throw new PassNotAvailableError("The decision has expired. Request a new decision.", "decision_expired");
    }
    const availableAt = Date.parse(decision.createdAt) + decision.verdict.cooldown_seconds * 1_000;
    if (now.getTime() < availableAt) {
      throw new PassNotAvailableError("The decision cooldown is still active.", "cooldown_active");
    }
    return this.passes.issue({
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
