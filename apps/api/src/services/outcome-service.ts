import type { CheckIn, DecisionEvent, OutcomeReceipt } from "@auxo/shared";

import type { DecisionRepository } from "../repositories/decision-repository.js";
import type { OutcomeRepository } from "../repositories/outcome-repository.js";

export class DecisionNotFoundError extends Error {
  public constructor() {
    super("Decision not found.");
    this.name = "DecisionNotFoundError";
  }
}

export class OutcomeService {
  public constructor(
    private readonly decisions: DecisionRepository,
    private readonly outcomes: OutcomeRepository,
  ) {}

  public async recordEvent(userId: string, event: DecisionEvent): Promise<OutcomeReceipt> {
    await this.assertDecisionOwnership(userId, event.decision_id);
    const result = await this.outcomes.saveEvent(userId, event);

    return { accepted: true, duplicate: result === "duplicate" };
  }

  public async recordCheckIn(userId: string, checkIn: CheckIn): Promise<OutcomeReceipt> {
    await this.assertDecisionOwnership(userId, checkIn.decision_id);
    const result = await this.outcomes.saveCheckIn(userId, checkIn);

    return { accepted: true, duplicate: result === "duplicate" };
  }

  private async assertDecisionOwnership(userId: string, decisionId: string): Promise<void> {
    if (!(await this.decisions.belongsToUser(userId, decisionId))) {
      throw new DecisionNotFoundError();
    }
  }
}
