export type UserAction = "left" | "saved" | "overrode" | "bought";

export interface DecisionEvent {
  decision_id: string;
  action: UserAction;
  occurred_at: string;
}
