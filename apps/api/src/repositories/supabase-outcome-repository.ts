import type { SupabaseClient } from "@supabase/supabase-js";

import type { CheckIn, DecisionEvent } from "@auxo/shared";

import type { OutcomeRepository, SaveOutcomeResult } from "./outcome-repository.js";

function isUniqueViolation(error: { code?: string }): boolean {
  return error.code === "23505";
}

export class SupabaseOutcomeRepository implements OutcomeRepository {
  public constructor(private readonly client: SupabaseClient) {}

  // record_decision_event (migration 202610180002) inserts the event with
  // ON CONFLICT DO NOTHING and, for the first `bought` event of a decision,
  // increments the matching budgets in the same transaction.
  public async saveEvent(
    userId: string,
    event: DecisionEvent,
  ): Promise<SaveOutcomeResult> {
    const { data, error } = await this.client.rpc("record_decision_event", {
      p_event_id: event.event_id,
      p_user_id: userId,
      p_decision_id: event.decision_id,
      p_event_type: event.action,
      p_occurred_at: event.occurred_at,
      p_metadata: event.metadata ?? {},
    });

    if (error) {
      throw new Error("Unable to persist the decision event.", { cause: error });
    }

    if (data === "created" || data === "duplicate") {
      return data;
    }

    throw new Error("Unexpected result from record_decision_event.", { cause: data });
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
