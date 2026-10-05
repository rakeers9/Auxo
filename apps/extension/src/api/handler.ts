import { CartSchema, DecisionEventSchema, TriggerSchema, type Cart, type DecisionEvent, type Trigger } from "@auxo/shared";

import type { DecideResult, EventResult } from "../messages";

export function isDecideMessage(message: unknown): message is { type: "auxo:decide"; cart: unknown; trigger?: unknown } {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "auxo:decide";
}

// Runs in the background worker. Re-validates the cart (messages cross a
// process boundary) and never throws, so the content script can fail open.
export async function handleDecideMessage(
  message: { type: "auxo:decide"; cart: unknown; trigger?: unknown },
  decide: (cart: Cart, trigger?: Trigger) => Promise<DecideResult>,
): Promise<DecideResult> {
  const parsed = CartSchema.safeParse(message.cart);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_cart" };
  }
  // A malformed trigger is dropped rather than failing the decision.
  const trigger = message.trigger === undefined ? undefined : TriggerSchema.safeParse(message.trigger);

  try {
    return await (trigger?.success ? decide(parsed.data, trigger.data) : decide(parsed.data));
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

export function isAckMessage(message: unknown): message is { type: "auxo:ack"; decisionId: string } {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "auxo:ack" &&
    typeof (message as { decisionId?: unknown }).decisionId === "string"
  );
}

export function isClaimMessage(message: unknown): message is { type: "auxo:claim" } {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "auxo:claim";
}

// The validated trigger of a decide message, if it has one.
export function triggerOf(message: { trigger?: unknown }): Trigger | undefined {
  const parsed = message.trigger === undefined ? undefined : TriggerSchema.safeParse(message.trigger);
  return parsed?.success ? parsed.data : undefined;
}
