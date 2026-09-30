import { z } from "zod";

export const PassSchema = z
  .object({
    pass_id: z.string().uuid(),
    decision_id: z.string().uuid(),
    cart_hash: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/i),
    merchant: z.string().trim().min(1).max(100),
    expires_at: z.string().datetime({ offset: true }),
  })
  .strict();

export const CreatePassRequestSchema = z
  .object({ decision_id: z.string().uuid() })
  .strict();

export type Pass = z.infer<typeof PassSchema>;
export type CreatePassRequest = z.infer<typeof CreatePassRequestSchema>;
