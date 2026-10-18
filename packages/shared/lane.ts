import { z } from "zod";

// L0 is a silent pass. It is still returned and logged so friction rate can be measured.
export const LaneSchema = z.enum(["L0", "L1", "L2", "L3", "L4"]);

export type Lane = z.infer<typeof LaneSchema>;
