import type { DecisionEvent, UserAction } from "@auxo/shared";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// An event about a decision. Each call gets a new event_id, so build it once
// and reuse it for any retry (the API dedupes on event_id).
export function buildDecisionEvent(
  decisionId: string,
  action: UserAction,
  metadata?: Record<string, JsonValue>,
  now: Date = new Date(),
): DecisionEvent {
  return {
    event_id: crypto.randomUUID(),
    decision_id: decisionId,
    action,
    occurred_at: now.toISOString(),
    ...(metadata ? { metadata } : {}),
  };
}
