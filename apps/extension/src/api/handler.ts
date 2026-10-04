import { CartSchema, type Cart } from "@auxo/shared";

import type { DecideResult } from "../messages";

export function isDecideMessage(message: unknown): message is { type: "auxo:decide"; cart: unknown } {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "auxo:decide";
}

// Runs in the background worker. Re-validates the cart (messages cross a
// process boundary) and never throws, so the content script can fail open.
export async function handleDecideMessage(
  message: { type: "auxo:decide"; cart: unknown },
  decide: (cart: Cart) => Promise<DecideResult>,
): Promise<DecideResult> {
  const parsed = CartSchema.safeParse(message.cart);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_cart" };
  }

  try {
    return await decide(parsed.data);
  } catch {
    return { ok: false, reason: "network" };
  }
}
