import { CartSchema, DecisionEventSchema, type Cart, type DecisionEvent } from "@auxo/shared";

import type { DecideResult, EventResult } from "../messages";

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

export function isEventMessage(message: unknown): message is { type: "auxo:event"; event: unknown } {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "auxo:event";
}

// Runs in the background worker. Re-validates the event and never throws.
export async function handleEventMessage(
  message: { type: "auxo:event"; event: unknown },
  postEvent: (event: DecisionEvent) => Promise<EventResult>,
): Promise<EventResult> {
  const parsed = DecisionEventSchema.safeParse(message.event);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_event" };
  }

  try {
    return await postEvent(parsed.data);
  } catch {
    return { ok: false, reason: "network" };
  }
}
