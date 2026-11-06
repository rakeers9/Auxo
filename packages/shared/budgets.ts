import { z } from "zod";

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// A budget is a spending limit for the dates the user books, period_start to
// period_end (both included). With `repeats`, the same length of time starts
// again the day after it ends, forever, with the limit unchanged and the
// spending reset to 0 for each new cycle. Without it, the budget ends.
export const CreateBudgetSchema = z
  .object({
    currency: z.string().trim().regex(/^[A-Z]{3}$/),
    limit_minor: z.number().int().nonnegative().safe(),
    period_start: DateSchema,
    period_end: DateSchema,
    repeats: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.period_end >= value.period_start, {
    message: "period_end must be on or after period_start.",
    path: ["period_end"],
  });

// Turning `repeats` off ends the budget after its current cycle.
export const UpdateBudgetSchema = z
  .object({
    limit_minor: z.number().int().nonnegative().safe().optional(),
    repeats: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided.",
  });

// For a repeating budget, period_start and period_end are the CURRENT cycle
// and spent_minor is what was spent in it. period_days is the length of one
// cycle (period_end - period_start + 1).
export const BudgetSchema = z
  .object({
    id: z.string().uuid(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    limit_minor: z.number().int().nonnegative().safe(),
    spent_minor: z.number().int().nonnegative().safe(),
    period_start: DateSchema,
    period_end: DateSchema,
    period_days: z.number().int().positive(),
    repeats: z.boolean(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export type CreateBudget = z.infer<typeof CreateBudgetSchema>;
export type UpdateBudget = z.infer<typeof UpdateBudgetSchema>;
export type Budget = z.infer<typeof BudgetSchema>;
