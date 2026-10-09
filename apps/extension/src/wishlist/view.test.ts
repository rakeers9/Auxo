import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WishlistEntry } from "./store";
import { formatMoney, formatSavedAt, renderWishlist, safeHref, type WishlistSource } from "./view";

const NOW = new Date("2026-10-04T12:00:00.000Z");

function entry(id: string, overrides: Partial<WishlistEntry> = {}): WishlistEntry {
  return {
    id,
    name: `Item ${id}`,
    price_minor: 999,
    qty: 1,
    currency: "USD",
    merchant: "amazon.com",
    url: `https://www.amazon.com/dp/B0TEST000${id}`,
    saved_at: "2026-10-04T11:55:00.000Z",
    ...overrides,
  };
}

// A store backed by an array, like the real one.
function fakeStore(initial: WishlistEntry[]) {
  const state = { entries: [...initial] };
  const store = {
    state,
    list: vi.fn(async (): Promise<WishlistEntry[]> => [...state.entries]),
    remove: vi.fn(async (id: string): Promise<WishlistEntry[]> => {
      state.entries = state.entries.filter((saved) => saved.id !== id);
      return [...state.entries];
    }),
  } satisfies WishlistSource & { state: { entries: WishlistEntry[] } };
  return store;
}

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
});

afterEach(() => {
  root.remove();
});

// Let the store's promises resolve and the view redraw.
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const items = () => [...root.querySelectorAll<HTMLLIElement>("li.auxo-item")];
const removeButton = (li: HTMLLIElement) => li.querySelector<HTMLButtonElement>('button[data-action="remove"]')!;

describe("renderWishlist", () => {
  it("shows the Auxo header and the saved items in order", async () => {
    renderWishlist(root, fakeStore([entry("1"), entry("2")]), { now: () => NOW });
    await settle();

    expect(root.querySelector("h1")?.textContent).toBe("Auxo");
    expect(root.querySelector("h2")?.textContent).toBe("Saved for later");
    expect(items().map((li) => li.querySelector(".auxo-name")?.textContent)).toEqual(["Item 1", "Item 2"]);
  });

  it("shows each item's name as a link, store, price, quantity, and when it was saved", async () => {
    renderWishlist(root, fakeStore([entry("1", { name: "Mug", price_minor: 1250, qty: 3, merchant: "amazon.com" })]), {
      now: () => NOW,
    });
    await settle();

    const li = items()[0]!;
    const link = li.querySelector<HTMLAnchorElement>("a.auxo-name")!;
    expect(link.textContent).toBe("Mug");
    expect(link.href).toBe("https://www.amazon.com/dp/B0TEST0001");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    expect(li.querySelector(".auxo-store")?.textContent).toBe("amazon.com");
    expect(li.querySelector(".auxo-price")?.textContent).toBe("$12.50 × 3");
    const time = li.querySelector("time")!;
    expect(time.textContent).toBe("5 minutes ago");
    expect(time.getAttribute("datetime")).toBe("2026-10-04T11:55:00.000Z");
  });

  it("shows a single item's price without a quantity", async () => {
    renderWishlist(root, fakeStore([entry("1")]), { now: () => NOW });
    await settle();

    expect(items()[0]!.querySelector(".auxo-price")?.textContent).toBe("$9.99");
  });

  it("shows an empty state when nothing is saved", async () => {
    renderWishlist(root, fakeStore([]), { now: () => NOW });
    await settle();

    expect(items()).toHaveLength(0);
    expect(root.querySelector(".auxo-empty")?.textContent).toContain("Nothing saved yet");
  });

  it("shows loading until the store answers", () => {
    renderWishlist(root, fakeStore([entry("1")]), { now: () => NOW });

    expect(root.querySelector(".auxo-loading")?.textContent).toBe("Loading…");
  });

  it("removes an item with an accessible button, announces it, and moves focus to the next one", async () => {
    const store = fakeStore([entry("1"), entry("2"), entry("3")]);
    renderWishlist(root, store, { now: () => NOW });
    await settle();

    const button = removeButton(items()[1]!);
    expect(button.tagName).toBe("BUTTON");
    expect(button.type).toBe("button");
    expect(button.getAttribute("aria-label")).toBe("Remove Item 2");
    button.click();
    await settle();

    expect(store.remove).toHaveBeenCalledWith("2");
    expect(items().map((li) => li.dataset.id)).toEqual(["1", "3"]);
    expect(root.querySelector('[role="status"]')?.textContent).toBe("Removed Item 2.");
    expect(document.activeElement).toBe(removeButton(items()[1]!));
  });

  it("moves focus to the previous item, then the heading, as the list empties", async () => {
    renderWishlist(root, fakeStore([entry("1"), entry("2")]), { now: () => NOW });
    await settle();

    removeButton(items()[1]!).click();
    await settle();
    expect(document.activeElement).toBe(removeButton(items()[0]!));

    removeButton(items()[0]!).click();
    await settle();
    expect(document.activeElement).toBe(root.querySelector("h2"));
    expect(root.querySelector(".auxo-empty")).not.toBeNull();
  });

  it("says so when a remove didn't stick, and keeps the item", async () => {
    const store = fakeStore([entry("1")]);
    // A failed storage write returns the list unchanged.
    store.remove.mockImplementation(async () => [...store.state.entries]);
    renderWishlist(root, store, { now: () => NOW });
    await settle();

    removeButton(items()[0]!).click();
    await settle();

    expect(items()).toHaveLength(1);
    expect(removeButton(items()[0]!).disabled).toBe(false);
    expect(root.querySelector('[role="status"]')?.textContent).toBe("Couldn't remove Item 1. Try again.");
  });

  it("never renders names as markup", async () => {
    renderWishlist(root, fakeStore([entry("1", { name: '<img src=x onerror="alert(1)">' })]), { now: () => NOW });
    await settle();

    expect(root.querySelector("img")).toBeNull();
    expect(items()[0]!.querySelector(".auxo-name")?.textContent).toBe('<img src=x onerror="alert(1)">');
  });

  it("shows a non-http url as plain text, not a link", async () => {
    renderWishlist(root, fakeStore([entry("1", { url: "javascript:alert(1)" })]), { now: () => NOW });
    await settle();

    expect(items()[0]!.querySelector("a")).toBeNull();
    expect(items()[0]!.querySelector("span.auxo-name")?.textContent).toBe("Item 1");
  });

  it("keeps focus when a refresh finds the same list (e.g. after its own remove)", async () => {
    const store = fakeStore([entry("1"), entry("2")]);
    const view = renderWishlist(root, store, { now: () => NOW });
    await settle();

    removeButton(items()[0]!).click();
    await settle();
    const focused = document.activeElement;
    await view.refresh();

    expect(document.activeElement).toBe(focused);
    expect(focused).toBe(removeButton(items()[0]!));
  });

  it("redraws on refresh and clears on destroy", async () => {
    const store = fakeStore([entry("1")]);
    const view = renderWishlist(root, store, { now: () => NOW });
    await settle();

    store.state.entries.unshift(entry("2"));
    await view.refresh();
    expect(items().map((li) => li.dataset.id)).toEqual(["2", "1"]);

    view.destroy();
    expect(root.childElementCount).toBe(0);
  });
});

describe("formatMoney", () => {
  it("formats minor units in the currency's own digits", () => {
    expect(formatMoney(999, "USD")).toBe("$9.99");
    expect(formatMoney(123456, "USD")).toBe("$1,234.56");
    expect(formatMoney(500, "JPY")).toBe("¥500");
  });

  it("shows an unknown but well-formed code as Intl does, and falls back for a malformed one", () => {
    expect(formatMoney(999, "XYZ")).toBe("XYZ\u00a09.99"); // Intl uses a no-break space
    expect(formatMoney(999, "dollars")).toBe("9.99 dollars");
  });
});

describe("formatSavedAt", () => {
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

  it("says how long ago, then a date after 30 days", () => {
    expect(formatSavedAt(ago(10_000), NOW)).toBe("just now");
    expect(formatSavedAt(ago(5 * 60_000), NOW)).toBe("5 minutes ago");
    expect(formatSavedAt(ago(3 * 3_600_000), NOW)).toBe("3 hours ago");
    expect(formatSavedAt(ago(26 * 3_600_000), NOW)).toBe("yesterday");
    expect(formatSavedAt(ago(4 * 86_400_000), NOW)).toBe("4 days ago");
    expect(formatSavedAt("2026-08-01T12:00:00.000Z", NOW)).toBe("Aug 1, 2026");
    expect(formatSavedAt("not a date", NOW)).toBe("");
  });
});

describe("safeHref", () => {
  it("allows only http and https", () => {
    expect(safeHref("https://www.amazon.com/dp/B0TEST0001")).toBe("https://www.amazon.com/dp/B0TEST0001");
    expect(safeHref("http://example.com/")).toBe("http://example.com/");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,hi")).toBeNull();
    expect(safeHref("not a url")).toBeNull();
  });
});
