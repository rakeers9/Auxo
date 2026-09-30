import { z } from "zod";

// L0 is a silent pass. It is still returned and logged so friction rate can be measured.
export const LaneSchema = z.enum(["L0", "L1", "L2", "L3", "L4"]);
export const VerdictActionSchema = z.enum(["allow", "pause", "block"]);

export const VerdictSchema = z
  .object({
    decision_id: z.string().uuid(),
    lane: LaneSchema,
    action: VerdictActionSchema,
    template_id: z.string().trim().min(1).max(100),
    cooldown_seconds: z.number().int().nonnegative().safe(),
  })
  .strict();

export type Lane = z.infer<typeof LaneSchema>;
export type VerdictAction = z.infer<typeof VerdictActionSchema>;
export type Verdict = z.infer<typeof VerdictSchema>;
