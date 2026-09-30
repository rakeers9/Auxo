import { z } from "zod";

export const UserActionSchema = z.enum(["left", "saved", "overrode", "bought"]);

export const DecisionEventSchema = z.object({
  decision_id: z.string().min(1),
  action: UserActionSchema,
  occurred_at: z.iso.datetime(),
});

// Answer to the delayed "was it worth it?" prompt after a purchase.
export const WorthItSchema = z.enum(["yes", "meh", "regret"]);

export const CheckInSchema = z.object({
  decision_id: z.string().min(1),
  worth_it: WorthItSchema,
  note: z.string().max(500).optional(),
  answered_at: z.iso.datetime(),
});

export type UserAction = z.infer<typeof UserActionSchema>;
export type DecisionEvent = z.infer<typeof DecisionEventSchema>;
export type WorthIt = z.infer<typeof WorthItSchema>;
export type CheckIn = z.infer<typeof CheckInSchema>;
