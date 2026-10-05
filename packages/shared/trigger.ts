import { z } from "zod";

// What made the extension ask for a decision: a buy-intent click, a cart
// edit (quantity +/-, delete, save for later; in the cart page or the cart
// sidebar), or landing on a cart or checkout page without one.
export const TriggerIntentSchema = z.enum([
  "add_to_cart",
  "buy_now",
  "view_cart",
  "checkout",
  "place_order",
  "increase_qty",
  "decrease_qty",
  "remove_item",
  "save_for_later",
  "page_view",
]);

// Cart edits that lower spending. They're always recorded, but never get a
// pause or block: Auxo doesn't add friction to putting things back.
export const REDUCING_INTENTS = ["decrease_qty", "remove_item", "save_for_later"] as const satisfies readonly z.infer<
  typeof TriggerIntentSchema
>[];

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
    // The page re-checked a cart identical to the one it last sent (e.g. the
    // cart area re-rendered). Sent anyway: the backend decides what it means.
    same_cart: z.boolean().optional(),
  })
  .strict();

export type TriggerIntent = z.infer<typeof TriggerIntentSchema>;
export type TriggerSource = z.infer<typeof TriggerSourceSchema>;
export type TriggerPageType = z.infer<typeof TriggerPageTypeSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
