import type { Cart, DecisionEvent, Trigger, Verdict } from "@auxo/shared";
import { describe, expect, it, vi } from "vitest";

import type { DecideResult, EventResult } from "../messages";
import {
  handleDecideMessage,
  handleEventMessage,
  isAckMessage,
  isCartLoadMessage,
  isCartRecordMessage,
  isClaimMessage,
  isConfigMessage,
  isDecideMessage,
  isDecisionForMessage,
  isEventMessage,
  isWishlistSaveMessage,
  triggerOf,
} from "./handler";

const cart: Cart = {
  merchant: "amazon.com",
  items: [{ name: "Desk lamp", price_minor: 2499, qty: 1 }],
  total_minor: 2499,
  currency: "USD",
  url: "https://www.amazon.com/gp/cart/view.html",
  cart_hash: "b".repeat(64),
};

const verdict: Verdict = {
  decision_id: "2b9ebefe-78c8-561e-9a68-da51842c65a8",
  lane: "L1",
  action: "allow",
  template_id: "l1-banner",
  cooldown_seconds: 0,
};

describe("isDecideMessage", () => {
  it("recognizes only auxo:decide messages", () => {
    expect(isDecideMessage({ type: "auxo:decide", cart })).toBe(true);
    expect(isDecideMessage({ type: "other" })).toBe(false);
    expect(isDecideMessage(null)).toBe(false);
    expect(isDecideMessage("auxo:decide")).toBe(false);
  });
});

describe("handleDecideMessage", () => {
  const trigger = {
    intent: "checkout",
    source: "known",
    page_type: "checkout",
    occurred_at: "2026-10-04T20:00:00.000Z",
  } as const;

  it("passes a valid trigger along with the cart", async () => {
    const decide = vi.fn<(cart: Cart, trigger?: Trigger) => Promise<DecideResult>>().mockResolvedValue({ ok: true, verdict });

    await handleDecideMessage({ type: "auxo:decide", cart, trigger }, decide);
    expect(decide).toHaveBeenCalledWith(cart, trigger);
  });

  it("drops a malformed trigger but still decides", async () => {
    const decide = vi.fn<(cart: Cart, trigger?: Trigger) => Promise<DecideResult>>().mockResolvedValue({ ok: true, verdict });

    await handleDecideMessage({ type: "auxo:decide", cart, trigger: { intent: "nope" } }, decide);
    expect(decide).toHaveBeenCalledWith(cart);
  });

  it("passes a valid cart to decide and returns its result", async () => {
    const decide = vi.fn<(cart: Cart) => Promise<DecideResult>>().mockResolvedValue({ ok: true, verdict });

    expect(await handleDecideMessage({ type: "auxo:decide", cart }, decide)).toEqual({ ok: true, verdict });
    expect(decide).toHaveBeenCalledWith(cart);
  });

  it("rejects an invalid cart without calling the API", async () => {
    const decide = vi.fn<(cart: Cart) => Promise<DecideResult>>();

    const result = await handleDecideMessage({ type: "auxo:decide", cart: { merchant: "x" } }, decide);

    expect(result).toEqual({ ok: false, reason: "invalid_cart" });
    expect(decide).not.toHaveBeenCalled();
  });

  it("fails open if decide throws", async () => {
    const decide = vi.fn<(cart: Cart) => Promise<DecideResult>>().mockRejectedValue(new Error("boom"));

    expect(await handleDecideMessage({ type: "auxo:decide", cart }, decide)).toEqual({
      ok: false,
      reason: "network",
    });
  });
});

const event: DecisionEvent = {
  event_id: "8a4f0c2e-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
  decision_id: "2b9ebefe-78c8-561e-9a68-da51842c65a8",
  action: "left",
  occurred_at: "2026-10-04T17:00:00.000Z",
};

describe("isEventMessage", () => {
  it("recognizes only auxo:event messages", () => {
    expect(isEventMessage({ type: "auxo:event", event })).toBe(true);
    expect(isEventMessage({ type: "auxo:decide", cart })).toBe(false);
    expect(isEventMessage(null)).toBe(false);
    expect(isEventMessage("auxo:event")).toBe(false);
  });

  it("does not change what isDecideMessage accepts", () => {
    expect(isDecideMessage({ type: "auxo:event", event })).toBe(false);
  });
});

describe("handleEventMessage", () => {
  it("passes a valid event to postEvent and returns its result", async () => {
    const postEvent = vi.fn<(event: DecisionEvent) => Promise<EventResult>>().mockResolvedValue({
      ok: true,
      duplicate: false,
    });

    expect(await handleEventMessage({ type: "auxo:event", event }, postEvent)).toEqual({ ok: true, duplicate: false });
    expect(postEvent).toHaveBeenCalledWith(event);
  });

  it.each([
    ["missing fields", { decision_id: event.decision_id }],
    ["bad action", { ...event, action: "clicked" }],
    ["non-uuid event_id", { ...event, event_id: "1" }],
    ["unknown field", { ...event, extra: true }],
    ["not an object", "left"],
  ])("rejects an invalid event (%s) without calling the API", async (_label, bad) => {
    const postEvent = vi.fn<(event: DecisionEvent) => Promise<EventResult>>();

    const result = await handleEventMessage({ type: "auxo:event", event: bad }, postEvent);

    expect(result).toEqual({ ok: false, reason: "invalid_event" });
    expect(postEvent).not.toHaveBeenCalled();
  });

  it("returns 'network' if postEvent throws", async () => {
    const postEvent = vi.fn<(event: DecisionEvent) => Promise<EventResult>>().mockRejectedValue(new Error("boom"));

    expect(await handleEventMessage({ type: "auxo:event", event }, postEvent)).toEqual({
      ok: false,
      reason: "network",
    });
  });
});

describe("hand-off messages", () => {
  it("recognizes ack and claim messages", () => {
    expect(isAckMessage({ type: "auxo:ack", decisionId: "x" })).toBe(true);
    expect(isAckMessage({ type: "auxo:ack" })).toBe(false);
    expect(isClaimMessage({ type: "auxo:claim" })).toBe(true);
    expect(isClaimMessage({ type: "auxo:ack", decisionId: "x" })).toBe(false);
    expect(isClaimMessage(null)).toBe(false);
  });

  it("extracts only a valid trigger", () => {
    const trigger = { intent: "add_to_cart", source: "known", page_type: "product", occurred_at: "2026-10-04T20:00:00.000Z" };
    expect(triggerOf({ trigger })).toEqual(trigger);
    expect(triggerOf({ trigger: { intent: "nope" } })).toBeUndefined();
    expect(triggerOf({})).toBeUndefined();
  });
});

describe("isDecisionForMessage", () => {
  it("accepts only well-formed item lists", () => {
    expect(isDecisionForMessage({ type: "auxo:decision-for", items: [{ name: "Mug", price_minor: 999 }] })).toBe(true);
    expect(isDecisionForMessage({ type: "auxo:decision-for", items: [] })).toBe(true);
    expect(isDecisionForMessage({ type: "auxo:decision-for", items: [{ name: "Mug", price_minor: 9.99 }] })).toBe(false);
    expect(isDecisionForMessage({ type: "auxo:decision-for", items: [{ name: 1, price_minor: 999 }] })).toBe(false);
    expect(isDecisionForMessage({ type: "auxo:decision-for" })).toBe(false);
    expect(isDecisionForMessage(null)).toBe(false);
  });
});

describe("isConfigMessage", () => {
  it("needs a host", () => {
    expect(isConfigMessage({ type: "auxo:config", host: "www.amazon.com" })).toBe(true);
    expect(isConfigMessage({ type: "auxo:config" })).toBe(false);
    expect(isConfigMessage({ type: "auxo:claim" })).toBe(false);
  });
});

describe("isWishlistSaveMessage", () => {
  it("needs a decision id", () => {
    expect(isWishlistSaveMessage({ type: "auxo:wishlist-save", decisionId: "x" })).toBe(true);
    expect(isWishlistSaveMessage({ type: "auxo:wishlist-save" })).toBe(false);
    expect(isWishlistSaveMessage({ type: "auxo:ack", decisionId: "x" })).toBe(false);
  });
});

describe("cart state messages", () => {
  const draft = {
    merchant: "amazon.com",
    items: [{ name: "Desk lamp", price_minor: 2499, qty: 1 }],
    total_minor: 2499,
    currency: "USD",
    url: "https://www.amazon.com/gp/cart/view.html",
  };

  it("accepts a whole cart, including an emptied one", () => {
    expect(isCartLoadMessage({ type: "auxo:cart-load", merchant: "amazon.com", cart: draft })).toBe(true);
    expect(isCartRecordMessage({ type: "auxo:cart-record", merchant: "amazon.com", cart: draft })).toBe(true);
    const empty = { ...draft, items: [], total_minor: 0 };
    expect(isCartLoadMessage({ type: "auxo:cart-load", merchant: "amazon.com", cart: empty })).toBe(true);
  });

  it("tells the two types apart", () => {
    expect(isCartLoadMessage({ type: "auxo:cart-record", merchant: "amazon.com", cart: draft })).toBe(false);
    expect(isCartRecordMessage({ type: "auxo:cart-load", merchant: "amazon.com", cart: draft })).toBe(false);
  });

  it.each([
    ["no merchant", { merchant: undefined }],
    ["a blank merchant", { merchant: "  " }],
    ["no cart", { cart: undefined }],
    ["a cart with a hash", { cart: { ...draft, cart_hash: "0".repeat(64) } }],
    ["a fractional price", { cart: { ...draft, items: [{ name: "Desk lamp", price_minor: 24.99, qty: 1 }] } }],
    ["a zero quantity", { cart: { ...draft, items: [{ name: "Desk lamp", price_minor: 2499, qty: 0 }] } }],
    ["an unsafe quantity", { cart: { ...draft, items: [{ name: "Desk lamp", price_minor: 2499, qty: 2 ** 53 }] } }],
    ["a nameless item", { cart: { ...draft, items: [{ name: "", price_minor: 2499, qty: 1 }] } }],
  ])("rejects %s", (_label, change) => {
    expect(isCartLoadMessage({ type: "auxo:cart-load", merchant: "amazon.com", cart: draft, ...change })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isCartLoadMessage(null)).toBe(false);
    expect(isCartRecordMessage("auxo:cart-record")).toBe(false);
  });
});
