import { beforeEach, describe, expect, it } from "vitest";

import type { CartDraft } from "../messages";
import { CLICK_MAX_AGE_MS, createPendingStore, PURCHASE_MAX_AGE_MS, type PendingClick } from "./pending";

const t0 = new Date("2026-10-04T20:00:00.000Z");
const later = (ms: number) => new Date(t0.getTime() + ms);

const click: PendingClick = {
  signal: { intent: "buy_now", source: "known", label: "Buy Now" },
  pageType: "product",
  at: t0.toISOString(),
};

const draft: CartDraft = {
  merchant: "amazon.com",
  items: [{ name: "Desk lamp", price_minor: 2499, qty: 1 }],
  total_minor: 2499,
  currency: "USD",
  url: "https://www.amazon.com/checkout",
};

beforeEach(() => sessionStorage.clear());

describe("pending clicks", () => {
  it("returns a fresh click once, then nothing", () => {
    const store = createPendingStore(sessionStorage);
    store.saveClick(click);

    expect(store.takeClick(later(1_000))).toEqual(click);
    expect(store.takeClick(later(1_000))).toBeNull();
  });

  it("survives a new store on the same storage (a page change)", () => {
    createPendingStore(sessionStorage).saveClick(click);

    expect(createPendingStore(sessionStorage).takeClick(later(500))).toEqual(click);
  });

  it("drops a click older than the max age", () => {
    const store = createPendingStore(sessionStorage);
    store.saveClick(click);

    expect(store.takeClick(later(CLICK_MAX_AGE_MS + 1))).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("drops a click from the future and malformed data", () => {
    const store = createPendingStore(sessionStorage);
    store.saveClick(click);
    expect(store.takeClick(later(-1))).toBeNull();

    sessionStorage.setItem("auxo:pending-click", "{not json");
    expect(store.takeClick(t0)).toBeNull();
    sessionStorage.setItem("auxo:pending-click", JSON.stringify({ at: t0.toISOString() }));
    expect(store.takeClick(t0)).toBeNull();
  });

  it("works without storage", () => {
    const store = createPendingStore(null);
    store.saveClick(click);
    expect(store.takeClick(t0)).toBeNull();
  });

  it("never throws when storage throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    const store = createPendingStore(broken);

    expect(() => store.saveClick(click)).not.toThrow();
    expect(store.takeClick(t0)).toBeNull();
  });
});

describe("pending purchases", () => {
  it("keeps a purchase for the confirmation page, once", () => {
    const store = createPendingStore(sessionStorage);
    const purchase = { decisionId: "2b9ebefe-78c8-561e-9a68-da51842c65a8", draft, at: t0.toISOString() };
    store.savePurchase(purchase);

    expect(store.takePurchase(later(60_000))).toEqual(purchase);
    expect(store.takePurchase(later(60_000))).toBeNull();
  });

  it("drops a stale purchase", () => {
    const store = createPendingStore(sessionStorage);
    store.savePurchase({ decisionId: "x", draft, at: t0.toISOString() });

    expect(store.takePurchase(later(PURCHASE_MAX_AGE_MS + 1))).toBeNull();
  });

  it("keeps clicks and purchases separate", () => {
    const store = createPendingStore(sessionStorage);
    store.saveClick(click);
    store.savePurchase({ decisionId: "x", draft, at: t0.toISOString() });

    expect(store.takeClick(t0)).toEqual(click);
    expect(store.takePurchase(t0)?.decisionId).toBe("x");
  });
});
