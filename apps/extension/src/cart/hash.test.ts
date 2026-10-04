import { CartSchema } from "@auxo/shared";
import { describe, expect, it } from "vitest";

import type { CartDraft } from "../messages";
import { hashCart } from "./hash";

const draft: CartDraft = {
  merchant: "amazon.com",
  items: [
    { name: "Ceramic coffee mug", price_minor: 999, qty: 3 },
    { name: "Desk lamp", price_minor: 3399, qty: 1 },
  ],
  total_minor: 6396,
  currency: "USD",
  url: "https://www.amazon.com/gp/cart/view.html",
};

describe("hashCart", () => {
  it("returns 64 lowercase hex chars that form a valid Cart", async () => {
    const hash = await hashCart(draft);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(CartSchema.safeParse({ ...draft, cart_hash: hash }).success).toBe(true);
  });

  it("is stable for the same cart", async () => {
    expect(await hashCart(draft)).toBe(await hashCart(structuredClone(draft)));
  });

  it("hashes the documented canonical form", async () => {
    // Computed outside this code, so a change to the canonical form shows up here:
    // printf '%s' '{"v":1,"merchant":"amazon.com","currency":"USD","total_minor":6396,"items":[["Ceramic coffee mug",999,3],["Desk lamp",3399,1]]}' | shasum -a 256
    // If the form changes on purpose, bump `v` in hash.ts: every cart gets a new hash.
    expect(await hashCart(draft)).toBe("f48a0da12daf34d83515a4840e685e4ed102033df60f8101e678b674f5b306d9");
  });

  it("ignores item order", async () => {
    const reordered = { ...draft, items: [...draft.items].reverse() };
    expect(await hashCart(reordered)).toBe(await hashCart(draft));
  });

  it("ignores the URL", async () => {
    const other = { ...draft, url: "https://www.amazon.com/cart?ref=nav_cart" };
    expect(await hashCart(other)).toBe(await hashCart(draft));
  });

  it.each([
    ["qty", { items: [{ ...draft.items[0]!, qty: 2 }, draft.items[1]!] }],
    ["price", { items: [{ ...draft.items[0]!, price_minor: 1099 }, draft.items[1]!] }],
    ["name", { items: [{ ...draft.items[0]!, name: "Glass coffee mug" }, draft.items[1]!] }],
    ["an extra item", { items: [...draft.items, { name: "Pen", price_minor: 199, qty: 1 }] }],
    ["total", { total_minor: 6397 }],
    ["merchant", { merchant: "example.com" }],
  ])("changes when the %s changes", async (_label, change) => {
    expect(await hashCart({ ...draft, ...change })).not.toBe(await hashCart(draft));
  });
});
