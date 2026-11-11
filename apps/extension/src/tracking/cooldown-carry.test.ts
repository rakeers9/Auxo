import { describe, expect, it } from "vitest";

import { CARRY_WINDOW_MS, createCooldownCarry } from "./cooldown-carry";

const cart = { merchant: "amazon.com", cartHash: "a".repeat(64) };
const other = { merchant: "amazon.com", cartHash: "b".repeat(64) };

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  };
}

describe("createCooldownCarry", () => {
  it("gives the full cooldown for a cart that hasn't been paused", () => {
    const carry = createCooldownCarry(memoryStorage(), () => 1_000_000);
    expect(carry.remaining(cart, 300)).toBe(300);
  });

  it("keeps the timer running on the next page instead of restarting it", () => {
    const storage = memoryStorage();
    let t = 1_000_000;
    // Added-to-cart page: the block shows.
    createCooldownCarry(storage, () => t).shown(cart);
    // Two minutes later, the cart page (a new page, a new carry, same tab).
    t += 120_000;
    const cartPage = createCooldownCarry(storage, () => t);
    expect(cartPage.remaining(cart, 300)).toBe(180);
    cartPage.shown(cart);
    // Checkout, four more minutes later: the wait is over.
    t += 240_000;
    expect(createCooldownCarry(storage, () => t).remaining(cart, 300)).toBe(0);
  });

  it("gives a stricter lane its longer cooldown, counted from the first pause", () => {
    let t = 1_000_000;
    const carry = createCooldownCarry(memoryStorage(), () => t);
    carry.shown(cart);
    t += 100_000;
    // An L2 pause (60s) is over; an L4 block (900s) has 800s left.
    expect(carry.remaining(cart, 60)).toBe(0);
    expect(carry.remaining(cart, 900)).toBe(800);
  });

  it("tracks each cart on its own: a changed cart starts fresh", () => {
    let t = 1_000_000;
    const carry = createCooldownCarry(memoryStorage(), () => t);
    carry.shown(cart);
    t += 200_000;
    expect(carry.remaining(other, 300)).toBe(300);
  });

  it("starts fresh after the carry window", () => {
    let t = 1_000_000;
    const carry = createCooldownCarry(memoryStorage(), () => t);
    carry.shown(cart);
    t += CARRY_WINDOW_MS + 1;
    expect(carry.remaining(cart, 300)).toBe(300);
  });

  it("keeps the first showing when shown again", () => {
    let t = 1_000_000;
    const carry = createCooldownCarry(memoryStorage(), () => t);
    carry.shown(cart);
    t += 60_000;
    carry.shown(cart);
    expect(carry.remaining(cart, 300)).toBe(240);
  });

  it("ignores a showing from the future (a changed clock) and bad stored data", () => {
    const storage = memoryStorage();
    storage.setItem("auxo:cooldowns", JSON.stringify([{ merchant: "amazon.com", cart_hash: cart.cartHash, shown_at: 9e15 }, { junk: true }]));
    expect(createCooldownCarry(storage, () => 1_000_000).remaining(cart, 300)).toBe(300);
    storage.setItem("auxo:cooldowns", "not json");
    expect(createCooldownCarry(storage, () => 1_000_000).remaining(cart, 300)).toBe(300);
  });

  it("works within the page without storage", () => {
    let t = 1_000_000;
    const carry = createCooldownCarry(null, () => t);
    carry.shown(cart);
    t += 30_000;
    expect(carry.remaining(cart, 60)).toBe(30);
  });
});
