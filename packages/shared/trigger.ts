import { z } from "zod";

// What made the extension ask for a decision: a buy-intent click, or landing
// on a cart or checkout page without one.
export const TriggerIntentSchema = z.enum([
  "add_to_cart",
  "buy_now",
  "view_cart",
  "checkout",
  "place_order",
  "page_view",
]);

// known: a store-specific button we've verified on real pages.
// guess: generic signals (button text, form action); a hint only.
// page: no click, the page itself was detected as a cart or checkout.
export const TriggerSourceSchema = z.enum(["known", "guess", "page"]);

export const TriggerPageTypeSchema = z.enum(["product", "cart", "checkout", "other"]);

export const TriggerSchema = z
  .object({
    intent: TriggerIntentSchema,
    source: TriggerSourceSchema,
    // The page the reader confirmed after the trigger.
    page_type: TriggerPageTypeSchema,
    occurred_at: z.string().datetime({ offset: true }),
    // The clicked control's visible label, trimmed, for debugging guesses.
    label: z.string().trim().max(200).optional(),
  })
  .strict();

export type TriggerIntent = z.infer<typeof TriggerIntentSchema>;
export type TriggerSource = z.infer<typeof TriggerSourceSchema>;
export type TriggerPageType = z.infer<typeof TriggerPageTypeSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
