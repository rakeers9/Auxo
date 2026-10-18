import { z } from "zod";

import { DecisionContextSchema } from "./decision-context.js";
import { LaneSchema } from "./lane.js";
export const VerdictActionSchema = z.enum(["allow", "pause", "block"]);

export const VerdictSchema = z
  .object({
    decision_id: z.string().uuid(),
    lane: LaneSchema,
    action: VerdictActionSchema,
    template_id: z.string().trim().min(1).max(100),
    cooldown_seconds: z.number().int().nonnegative().safe(),
    context: DecisionContextSchema.optional(),
  })
  .strict();

export type VerdictAction = z.infer<typeof VerdictActionSchema>;
export type Verdict = z.infer<typeof VerdictSchema>;
