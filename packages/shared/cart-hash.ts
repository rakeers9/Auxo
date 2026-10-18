import { z } from "zod";

// 64 hex chars with an optional "sha256:" prefix, stored and compared lowercase.
export const CartHashSchema = z
  .string()
  .regex(/^(?:sha256:)?[a-f0-9]{64}$/i)
  .transform((value) => value.toLowerCase());
