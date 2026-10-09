import { beforeEach, describe, expect, it } from "vitest";

import type { CartDraft } from "../messages";
import { createPendingStore, type PendingClick } from "./pending";

const click: PendingClick = {
  signal: { intent: "buy_now", source: "known", label: "Buy Now" },
  pageType: "product",
  at: "2026-10-04T20:00:00.000Z",
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
  it("returns the click once, then nothing", () => {
    const store = createPendingStore(sessionStorage);
    store.saveClick(click);

    expect(store.takeClick()).toEqual(click);
    expect(store.takeClick()).toBeNull();
  });

  it("survives a new store on the same storage (a page change)", () => {
    createPendingStore(sessionStorage).saveClick(click);

    expect(createPendingStore(sessionStorage).takeClick()).toEqual(click);
  });

  it("has no time limit: an old click is still used by the next read", () => {
    const store = createPendingStore(sessionStorage);
    store.saveClick({ ...click, at: "2020-01-01T00:00:00.000Z" });

    expect(store.takeClick()?.at).toBe("2020-01-01T00:00:00.000Z");
  });

  it("a newer click replaces an unread one", () => {
    const store = createPendingStore(sessionStorage);
    store.saveClick(click);
    store.saveClick({ ...click, signal: { intent: "checkout", source: "known" } });

    expect(store.takeClick()?.signal.intent).toBe("checkout");
  });

  it("drops malformed data", () => {
    const store = createPendingStore(sessionStorage);
    sessionStorage.setItem("auxo:pending-click", "{not json");
    expect(store.takeClick()).toBeNull();
    sessionStorage.setItem("auxo:pending-click", JSON.stringify({ at: click.at }));
    expect(store.takeClick()).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("works without storage", () => {
    const store = createPendingStore(null);
    store.saveClick(click);
    expect(store.takeClick()).toBeNull();
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
    expect(store.takeClick()).toBeNull();
  });
});

describe("pending purchases", () => {
  it("keeps a purchase until it's read, once", () => {
    const store = createPendingStore(sessionStorage);
    const purchase = { decisionId: "2b9ebefe-78c8-561e-9a68-da51842c65a8", draft, at: click.at };
    store.savePurchase(purchase);

    expect(store.takePurchase()).toEqual(purchase);
    expect(store.takePurchase()).toBeNull();
  });

  it("the next place-order click replaces it", () => {
    const store = createPendingStore(sessionStorage);
    store.savePurchase({ decisionId: "first", draft, at: click.at });
    store.savePurchase({ decisionId: "second", draft, at: click.at });

    expect(store.takePurchase()?.decisionId).toBe("second");
  });

  it("keeps clicks and purchases separate", () => {
    const store = createPendingStore(sessionStorage);
    store.saveClick(click);
    store.savePurchase({ decisionId: "x", draft, at: click.at });

    expect(store.takeClick()).toEqual(click);
    expect(store.takePurchase()?.decisionId).toBe("x");
  });
});
