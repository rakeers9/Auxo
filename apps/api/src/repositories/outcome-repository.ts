import type { CheckIn, DecisionEvent } from "@auxo/shared";

import type { DecisionRepository } from "./decision-repository.js";
import type { SpendLedger } from "./settings-repository.js";

export type SaveOutcomeResult = "created" | "duplicate";

export interface OutcomeRepository {
  // A replayed event_id, or a second `bought` event for a decision that
  // already has one (one purchase per decision), is a duplicate. The first
  // `bought` event adds the decision's cart total to the user's budgets in the
  // cart's currency whose period contains occurred_at (UTC date).
  saveEvent(userId: string, event: DecisionEvent): Promise<SaveOutcomeResult>;
  saveCheckIn(userId: string, checkIn: CheckIn): Promise<SaveOutcomeResult>;
}

export interface InMemoryOutcomeRepositoryOptions {
  // Both are needed for spend tracking; without them `bought` only records the event.
  decisions?: Pick<DecisionRepository, "findOwned">;
  spend?: SpendLedger;
}

export class InMemoryOutcomeRepository implements OutcomeRepository {
  private readonly events = new Map<string, { userId: string; event: DecisionEvent }>();
  private readonly checkIns = new Map<string, { userId: string; checkIn: CheckIn }>();

  public constructor(private readonly options: InMemoryOutcomeRepositoryOptions = {}) {}

  public async saveEvent(
    userId: string,
    event: DecisionEvent,
  ): Promise<SaveOutcomeResult> {
    if (this.events.has(event.event_id)) {
      return "duplicate";
    }

    if (
      event.action === "bought" &&
      [...this.events.values()].some((row) => row.event.action === "bought" && row.event.decision_id === event.decision_id)
    ) {
      return "duplicate";
    }

    this.events.set(event.event_id, { userId, event });

    if (event.action === "bought" && this.options.decisions && this.options.spend) {
      const decision = await this.options.decisions.findOwned(userId, event.decision_id);
      if (decision) {
        await this.options.spend.recordSpend(userId, {
          currency: decision.cart.currency,
          amountMinor: decision.cart.total_minor,
          occurredOn: utcDate(event.occurred_at),
        });
      }
    }

    return "created";
  }

  public async saveCheckIn(userId: string, checkIn: CheckIn): Promise<SaveOutcomeResult> {
    if (this.checkIns.has(checkIn.decision_id)) {
      return "duplicate";
    }

    this.checkIns.set(checkIn.decision_id, { userId, checkIn });
    return "created";
  }
}

// The UTC calendar date of an ISO timestamp with any offset, matching how
// budgets are matched against "now" in the policy engine.
export function utcDate(timestamp: string): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}
