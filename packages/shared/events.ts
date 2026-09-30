import { z } from "zod";

export const UserActionSchema = z.enum(["left", "saved", "overrode", "bought"]);

export const DecisionEventSchema = z
  .object({
    event_id: z.string().uuid(),
    decision_id: z.string().uuid(),
    action: UserActionSchema,
    occurred_at: z.string().datetime({ offset: true }),
  })
  .strict();

export type UserAction = z.infer<typeof UserActionSchema>;
export type DecisionEvent = z.infer<typeof DecisionEventSchema>;
