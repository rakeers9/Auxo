import { z } from "zod";

const RuleFieldsSchema = z.object({
  name: z.string().trim().min(1).max(100),
  rule_type: z.string().trim().min(1).max(50),
  configuration: z.record(z.string(), z.unknown()),
  enabled: z.boolean(),
});

export const CreateRuleSchema = RuleFieldsSchema.strict();
export const UpdateRuleSchema = RuleFieldsSchema.partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one field must be provided." },
);

export const RuleSchema = RuleFieldsSchema.extend({
  id: z.string().uuid(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict();

export type CreateRule = z.infer<typeof CreateRuleSchema>;
export type UpdateRule = z.infer<typeof UpdateRuleSchema>;
export type Rule = z.infer<typeof RuleSchema>;
