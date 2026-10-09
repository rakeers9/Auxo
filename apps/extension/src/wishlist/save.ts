import type { DecisionMemory } from "../api/decision-memory";
import type { Wishlist } from "./store";

// "Save for later" on a decision: put that decision's items on the wishlist.
// Returns how many items were saved (0 if the decision is no longer remembered).
export async function saveDecisionToWishlist(
  decisionId: string,
  memory: Pick<DecisionMemory, "cartFor">,
  wishlist: Pick<Wishlist, "add">,
): Promise<number> {
  const cart = await memory.cartFor(decisionId);
  if (!cart || cart.items.length === 0) return 0;
  await wishlist.add(
    cart.items.map((item) => ({
      name: item.name,
      price_minor: item.price_minor,
      qty: item.qty,
      currency: cart.currency,
      merchant: cart.merchant,
      url: cart.url,
      decision_id: decisionId,
    })),
  );
  return cart.items.length;
}
