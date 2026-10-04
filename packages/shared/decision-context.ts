import { z } from "zod";

const ContextLaneSchema = z.enum(["L0", "L1", "L2", "L3", "L4"]);

export const DecisionReasonCodeSchema = z.enum([
  "rule.cart_total",
  "rule.merchant",
  "rule.item_keyword",
  "budget.warning",
  "budget.critical",
  "budget.exceeded",
  "model.escalation",
  "no_policy_match",
]);

export const DecisionContextSchema = z
  .object({
    decision_id: z.string().uuid(),
    cart_summary: z.object({
      merchant: z.string(),
      total_minor: z.number().int().nonnegative(),
      currency: z.string().regex(/^[A-Z]{3}$/),
      item_count: z.number().int().positive(),
    }).strict(),
    budget: z.object({
      limit_minor: z.number().int().nonnegative(),
      spent_minor: z.number().int().nonnegative(),
      projected_minor: z.number().int().nonnegative(),
      would_exceed: z.boolean(),
    }).strict().nullable(),
    matched_rules: z.array(z.object({
      rule_id: z.string().uuid(),
      name: z.string(),
      rule_type: z.string(),
      lane: ContextLaneSchema,
    }).strict()),
    model_signal: z.object({
      provider: z.literal("cloudflare-clef"),
      model: z.string(),
      suggested_lane: ContextLaneSchema,
      confidence: z.number().min(0).max(1),
    }).strict().nullable(),
    decisive_factors: z.array(z.object({
      code: DecisionReasonCodeSchema,
      source: z.enum(["rule", "budget", "model", "policy"]),
      lane: ContextLaneSchema,
    }).strict()).min(1),
    available_actions: z.array(z.enum(["continue", "leave", "save_for_later", "override_after_cooldown"])),
  })
  .strict();

export type DecisionReasonCode = z.infer<typeof DecisionReasonCodeSchema>;
export type DecisionContext = z.infer<typeof DecisionContextSchema>;
