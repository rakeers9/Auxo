import { z } from "zod";

// Money is stored in integer minor units (cents for USD) to keep budget math exact.
export const CartItemSchema = z.object({
  name: z.string().min(1),
  price_cents: z.number().int().nonnegative(),
  qty: z.number().int().positive(),
});

export const CartSchema = z.object({
  merchant: z.string().min(1),
  items: z.array(CartItemSchema),
  total_cents: z.number().int().nonnegative(),
  currency: z.string().length(3),
  url: z.url(),
  cart_hash: z.string().min(1),
});

export type CartItem = z.infer<typeof CartItemSchema>;
export type Cart = z.infer<typeof CartSchema>;
