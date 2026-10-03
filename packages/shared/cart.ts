import { z } from "zod";

export const CartItemSchema = z
  .object({
    name: z.string().trim().min(1).max(500),
    price_minor: z.number().int().nonnegative().safe(),
    qty: z.number().int().positive().safe(),
  })
  .strict();

export const CartSchema = z
  .object({
    merchant: z.string().trim().min(1).max(100),
    items: z.array(CartItemSchema).min(1).max(250),
    total_minor: z.number().int().nonnegative().safe(),
    currency: z.string().trim().regex(/^[A-Z]{3}$/),
    url: z.string().url(),
    cart_hash: z
      .string()
      .regex(/^(?:sha256:)?[a-f0-9]{64}$/i)
      .transform((value) => value.toLowerCase()),
  })
  .strict();

export type CartItem = z.infer<typeof CartItemSchema>;
export type Cart = z.infer<typeof CartSchema>;
