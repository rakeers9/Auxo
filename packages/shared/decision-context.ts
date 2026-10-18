import { z } from "zod";

import { LaneSchema } from "./lane.js";
import { RuleTypeSchema } from "./rules.js";

export const DecisionReasonCodeSchema = z.enum([
  "rule.cart_total",
  "rule.merchant",
  "rule.item_keyword",
  "budget.warning",
  "budget.critical",
  "budget.exceeded",
  "model.escalation",
  "trigger.reducing",
  "stub.hash",
  "no_policy_match",
]);

export const DecisionHistorySchema = z
  .object({
    merchant: z.string(),
    window_days: z.number().int().positive(),
    // Confirmed purchases (`bought` events) at this merchant in the window.
    purchases: z.number().int().nonnegative(),
    // Their total, in the cart's currency only.
    spent_minor: z.number().int().nonnegative().safe(),
    check_ins: z.number().int().nonnegative(),
    // Share of check-ins answered "regret"; null with no check-ins.
    regret_rate: z.number().min(0).max(1).nullable(),
    // Share of paused or blocked decisions the user overrode; null with none.
    override_rate: z.number().min(0).max(1).nullable(),
  })
  .strict();

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
      rule_type: RuleTypeSchema,
      lane: LaneSchema,
    }).strict()),
    model_signal: z.object({
      provider: z.literal("cloudflare-clef"),
      model: z.string(),
      suggested_lane: LaneSchema,
      confidence: z.number().min(0).max(1),
    }).strict().nullable(),
    decisive_factors: z.array(z.object({
      code: DecisionReasonCodeSchema,
      source: z.enum(["rule", "budget", "model", "policy"]),
      lane: LaneSchema,
    }).strict()).min(1),
    available_actions: z.array(z.enum(["continue", "leave", "save_for_later", "override_after_cooldown"])),
    // The user's recent history at this merchant (Phase 4 feedback loop).
    history: DecisionHistorySchema.optional(),
  })
  .strict();

export type DecisionReasonCode = z.infer<typeof DecisionReasonCodeSchema>;
export type DecisionHistory = z.infer<typeof DecisionHistorySchema>;
export type DecisionContext = z.infer<typeof DecisionContextSchema>;
