import type { SupabaseClient } from "@supabase/supabase-js";

import type { CheckIn, DecisionEvent } from "@auxo/shared";

import type { OutcomeRepository, SaveOutcomeResult } from "./outcome-repository.js";

function isUniqueViolation(error: { code?: string }): boolean {
  return error.code === "23505";
}

export class SupabaseOutcomeRepository implements OutcomeRepository {
  public constructor(private readonly client: SupabaseClient) {}

  public async saveEvent(
    userId: string,
    event: DecisionEvent,
  ): Promise<SaveOutcomeResult> {
    const { error } = await this.client.from("events").insert({
      event_id: event.event_id,
      user_id: userId,
      decision_id: event.decision_id,
      event_type: event.action,
      occurred_at: event.occurred_at,
      metadata: event.metadata ?? {},
    });

    if (!error) {
      return "created";
    }

    if (isUniqueViolation(error)) {
      return "duplicate";
    }

    throw new Error("Unable to persist the decision event.", { cause: error });
  }

  public async saveCheckIn(userId: string, checkIn: CheckIn): Promise<SaveOutcomeResult> {
    const { error } = await this.client.from("check_ins").insert({
      user_id: userId,
      decision_id: checkIn.decision_id,
      worth_it: checkIn.worth_it,
      note: checkIn.note ?? null,
      answered_at: checkIn.answered_at,
    });

    if (!error) {
      return "created";
    }

    if (isUniqueViolation(error)) {
      return "duplicate";
    }

    throw new Error("Unable to persist the purchase check-in.", { cause: error });
  }
}
