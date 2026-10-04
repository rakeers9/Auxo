import { z } from "zod";

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CreateBudgetSchema = z
  .object({
    currency: z.string().trim().regex(/^[A-Z]{3}$/),
    limit_minor: z.number().int().nonnegative().safe(),
    period_start: DateSchema,
    period_end: DateSchema,
  })
  .strict()
  .refine((value) => value.period_end >= value.period_start, {
    message: "period_end must be on or after period_start.",
    path: ["period_end"],
  });

export const UpdateBudgetSchema = z
  .object({
    limit_minor: z.number().int().nonnegative().safe().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided.",
  });

export const BudgetSchema = z
  .object({
    id: z.string().uuid(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    limit_minor: z.number().int().nonnegative().safe(),
    spent_minor: z.number().int().nonnegative().safe(),
    period_start: DateSchema,
    period_end: DateSchema,
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export type CreateBudget = z.infer<typeof CreateBudgetSchema>;
export type UpdateBudget = z.infer<typeof UpdateBudgetSchema>;
export type Budget = z.infer<typeof BudgetSchema>;
