import { z } from "zod";
import { CartSchema } from "./cart";
import { VerdictSchema } from "./verdict";

export const DecideRequestSchema = z.object({
  cart: CartSchema,
});

export const DecideResponseSchema = VerdictSchema;

export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export type DecideRequest = z.infer<typeof DecideRequestSchema>;
export type DecideResponse = z.infer<typeof DecideResponseSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
