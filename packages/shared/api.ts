import { z } from "zod";

import { CartSchema } from "./cart.js";
import { DecisionContextSchema } from "./decision-context.js";
import { TriggerSchema } from "./trigger.js";
import { VerdictSchema } from "./verdict.js";

// trigger is optional so older clients keep working.
export const DecideRequestSchema = z.object({ cart: CartSchema, trigger: TriggerSchema.optional() }).strict();
export const DecideResponseSchema = VerdictSchema.extend({
  context: DecisionContextSchema,
}).strict();

export const OutcomeReceiptSchema = z
  .object({
    accepted: z.literal(true),
    duplicate: z.boolean(),
  })
  .strict();

export const ApiErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        details: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();

export type DecideRequest = z.infer<typeof DecideRequestSchema>;
export type DecideResponse = z.infer<typeof DecideResponseSchema>;
export type OutcomeReceipt = z.infer<typeof OutcomeReceiptSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
