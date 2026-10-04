import type { Cart, Verdict } from "@auxo/shared";
import { describe, expect, it, vi } from "vitest";

import type { DecideResult } from "../messages";
import { handleDecideMessage, isDecideMessage } from "./handler";

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
