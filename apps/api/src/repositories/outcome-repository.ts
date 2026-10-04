import type { CheckIn, DecisionEvent } from "@auxo/shared";

export type SaveOutcomeResult = "created" | "duplicate";

export interface OutcomeRepository {
  saveEvent(userId: string, event: DecisionEvent): Promise<SaveOutcomeResult>;
  saveCheckIn(userId: string, checkIn: CheckIn): Promise<SaveOutcomeResult>;
}

export class InMemoryOutcomeRepository implements OutcomeRepository {
  private readonly events = new Map<string, { userId: string; event: DecisionEvent }>();
  private readonly checkIns = new Map<string, { userId: string; checkIn: CheckIn }>();

  public async saveEvent(
    userId: string,
    event: DecisionEvent,
  ): Promise<SaveOutcomeResult> {
    if (this.events.has(event.event_id)) {
      return "duplicate";
    }

    this.events.set(event.event_id, { userId, event });
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
