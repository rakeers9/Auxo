export type Lane = "L1" | "L2" | "L3" | "L4";
export type VerdictAction = "allow" | "pause" | "block";

export interface Verdict {
  decision_id: string;
  lane: Lane;
  action: VerdictAction;
  template_id: string;
  cooldown_seconds: number;
}
