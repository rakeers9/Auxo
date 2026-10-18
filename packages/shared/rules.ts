import { z } from "zod";

import { LaneSchema } from "./lane.js";

export const RuleTypeSchema = z.enum(["cart_total", "merchant", "item_keyword"]);

const TermListSchema = z.array(z.string().trim().min(1).max(100)).min(1).max(100);

// Each rule type's configuration. `lane` is the lane the rule asks for when it matches.
export const RuleConfigurationSchemas = {
  cart_total: z.object({ lane: LaneSchema, threshold_minor: z.number().int().nonnegative().safe() }).strict(),
  merchant: z.object({ lane: LaneSchema, merchants: TermListSchema }).strict(),
  item_keyword: z.object({ lane: LaneSchema, keywords: TermListSchema }).strict(),
} as const satisfies Record<z.infer<typeof RuleTypeSchema>, z.ZodType>;

const RuleFieldsSchema = z.object({
  name: z.string().trim().min(1).max(100),
  rule_type: RuleTypeSchema,
  configuration: z.record(z.string(), z.unknown()),
  enabled: z.boolean(),
});

export const CreateRuleSchema = RuleFieldsSchema.strict().superRefine((rule, context) => {
  const parsed = RuleConfigurationSchemas[rule.rule_type].safeParse(rule.configuration);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({ code: "custom", message: issue.message, path: ["configuration", ...issue.path] });
    }
  }
});

// A rule's type can't change; `configuration` is checked against the stored type.
export const UpdateRuleSchema = RuleFieldsSchema.omit({ rule_type: true }).partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one field must be provided." },
);

export const RuleSchema = RuleFieldsSchema.extend({
  id: z.string().uuid(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict();

export type RuleType = z.infer<typeof RuleTypeSchema>;
export type CreateRule = z.infer<typeof CreateRuleSchema>;
export type UpdateRule = z.infer<typeof UpdateRuleSchema>;
export type Rule = z.infer<typeof RuleSchema>;
