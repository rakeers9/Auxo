import { z } from "zod";

// Answer to the delayed "was it worth it?" prompt after a purchase.
export const WorthItSchema = z.enum(["yes", "meh", "regret"]);

export const CheckInSchema = z
  .object({
    decision_id: z.string().uuid(),
    worth_it: WorthItSchema,
    note: z.string().trim().max(500).optional(),
    answered_at: z.string().datetime({ offset: true }),
  })
  .strict();

export type WorthIt = z.infer<typeof WorthItSchema>;
export type CheckIn = z.infer<typeof CheckInSchema>;
