import { z } from "zod";

// A kind of alternative that could still give the user what they want from a
// cart, for less money or regret. The decision model picks one (or none); the
// overlay shows it as a suggestion. Specific products may come later.
export const AlternativeStrategySchema = z.enum([
  // Buy it renewed, refurbished or used.
  "renewed",
  // A less expensive version or brand of the same thing.
  "cheaper_version",
  // Not urgent: save it and wait for a deal.
  "wait_for_deal",
  // Something the user may already own, or could borrow or rent.
  "already_own",
  // A smaller size or quantity.
  "fewer",
  "none",
]);

export const DecisionAlternativeSchema = z
  .object({
    strategy: AlternativeStrategySchema.exclude(["none"]),
    // How sure the model is that this alternative fits.
    probability: z.number().min(0).max(1),
    // What to search for, for the strategies that link to a search: the name
    // of the cart's priciest item, as the store wrote it.
    query: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export type AlternativeStrategy = z.infer<typeof AlternativeStrategySchema>;
export type DecisionAlternative = z.infer<typeof DecisionAlternativeSchema>;
