import { describe, expect, it } from "vitest";

import type { Cart } from "@auxo/shared";

import { InMemoryDecisionRepository } from "../repositories/decision-repository.js";
import { DecisionService } from "./decision-service.js";

const cart: Cart = {
  merchant: "Example Store",
  items: [{ name: "Example item", price_minor: 1_000, qty: 1 }],
  total_minor: 1_000,
  currency: "USD",
  url: "https://example.com/cart",
  cart_hash: `${"a".repeat(63)}2`,
};

describe("DecisionService", () => {
  it("reuses an active decision for the same user and cart", async () => {
    const repository = new InMemoryDecisionRepository();
    const service = new DecisionService({ repository, ttlSeconds: 60 });

    const first = await service.decide("user-1", cart);
    const second = await service.decide("user-1", cart);

    expect(second).toEqual(first);
  });

  it("creates user-specific decision ids", async () => {
    const repository = new InMemoryDecisionRepository();
    const service = new DecisionService({ repository, ttlSeconds: 60 });

    const first = await service.decide("user-1", cart);
    const second = await service.decide("user-2", cart);

    expect(second.decision_id).not.toBe(first.decision_id);
    expect(second.lane).toBe(first.lane);
  });

  it("replaces an expired decision", async () => {
    const repository = new InMemoryDecisionRepository();
    let now = new Date("2026-10-03T12:00:00.000Z");
    const service = new DecisionService({ repository, ttlSeconds: 1, now: () => now });

    const first = await service.decide("user-1", cart);
    now = new Date("2026-10-03T12:00:02.000Z");
    const second = await service.decide("user-1", cart);

    expect(second).toEqual(first);
  });
});
