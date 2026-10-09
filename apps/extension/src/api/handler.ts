import { CartSchema, DecisionEventSchema, TriggerSchema, type Cart, type DecisionEvent, type Trigger } from "@auxo/shared";

import type { CartDraft, DecideResult, EventResult } from "../messages";
import { parseCartDraft } from "./cart-state";

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

export function isDecisionForMessage(
  message: unknown,
): message is { type: "auxo:decision-for"; items: Array<{ name: string; price_minor: number }> } {
  if (typeof message !== "object" || message === null) return false;
  const m = message as { type?: unknown; items?: unknown };
  return (
    m.type === "auxo:decision-for" &&
    Array.isArray(m.items) &&
    m.items.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { name?: unknown }).name === "string" &&
        Number.isSafeInteger((item as { price_minor?: unknown }).price_minor),
    )
  );
}

export function isConfigMessage(message: unknown): message is { type: "auxo:config"; host: string } {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "auxo:config" &&
    typeof (message as { host?: unknown }).host === "string"
  );
}

export function isWishlistSaveMessage(message: unknown): message is { type: "auxo:wishlist-save"; decisionId: string } {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "auxo:wishlist-save" &&
    typeof (message as { decisionId?: unknown }).decisionId === "string"
  );
}

// auxo:cart-record / auxo:cart-load: a non-empty merchant and a whole cart
// (items may be empty; each item has a name and safe-integer price and qty).
export function isCartRecordMessage(
  message: unknown,
): message is { type: "auxo:cart-record"; merchant: string; cart: CartDraft } {
  return isCartMessage(message, "auxo:cart-record");
}

export function isCartLoadMessage(
  message: unknown,
): message is { type: "auxo:cart-load"; merchant: string; cart: CartDraft } {
  return isCartMessage(message, "auxo:cart-load");
}

function isCartMessage(message: unknown, type: string): boolean {
  if (typeof message !== "object" || message === null) return false;
  const m = message as { type?: unknown; merchant?: unknown; cart?: unknown };
  return m.type === type && typeof m.merchant === "string" && m.merchant.trim() !== "" && parseCartDraft(m.cart) !== null;
}
