import { describe, expect, it } from "vitest";

import type { CartDraft } from "../messages";
import { createDebugPanel, money, type DebugSnapshot } from "./panel";

const draft: CartDraft = {
  merchant: "amazon.com",
  items: [
    { name: "Ceramic mug", price_minor: 999, qty: 3 },
    { name: "Desk lamp", price_minor: 3399, qty: 1 },
  ],
  total_minor: 6396,
  currency: "USD",
  url: "https://www.amazon.com/gp/cart/view.html",
};

function snapshot(overrides: Partial<DebugSnapshot> = {}): DebugSnapshot {
  return {
    url: "https://www.amazon.com/gp/cart/view.html?ref_=nav_cart",
    inspection: { pageType: "cart", draft, problems: [] },
    cartHash: "a".repeat(64),
    backend: { status: "verdict", lane: "L2", decisionId: "2b9ebefe-78c8-561e-9a68-da51842c65a8", templateId: "l2-pause" },
    checkedAt: new Date("2026-10-04T20:00:00Z"),
    checks: 1,
    ...overrides,
  };
}

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  return { root, panel: createDebugPanel(root) };
}

describe("createDebugPanel", () => {
  it("shows the page type, site, items, total, hash, and backend verdict", () => {
    const { root, panel } = mount();
    panel.update(snapshot());
    const text = root.textContent ?? "";

    expect(text).toContain("cart");
    expect(text).toContain("www.amazon.com");
    expect(text).toContain("/gp/cart/view.html");
    expect(text).toContain("Read 2 item(s)");
    expect(text).toContain("Ceramic mug");
    expect(text).toContain("×3");
    expect(text).toContain("$9.99");
    expect(text).toContain("$63.96");
    expect(text).toContain("a".repeat(64));
    expect(text).toContain("L2 (l2-pause)");
  });

  it("shows why the cart could not be read", () => {
    const { root, panel } = mount();
    panel.update(
      snapshot({
        inspection: { pageType: "cart", draft: null, problems: ["items sum $45.00 but subtotal says $50.00"] },
        cartHash: null,
        backend: { status: "not_asked" },
      }),
    );
    const text = root.textContent ?? "";

    expect(text).toContain("Could not read the cart");
    expect(text).not.toContain("Could not read the checkout");
    expect(text).toContain("items sum $45.00 but subtotal says $50.00");
    expect(text).toContain("not asked");
  });

  it("shows a plain 'other' page without errors", () => {
    const { root, panel } = mount();
    panel.update(snapshot({ inspection: { pageType: "other", draft: null, problems: [] }, cartHash: null, backend: { status: "not_asked" } }));
    const text = root.textContent ?? "";

    expect(text).toContain("other");
    expect(text).not.toContain("Could not read");
  });

  it("shows failed-open backend results and details", () => {
    const { root, panel } = mount();
    panel.update(
      snapshot({
        backend: { status: "failed", reason: "timeout" },
        inspection: { pageType: "checkout", draft, problems: [], details: { "subtotal text": "$63.96" } },
      }),
    );
    const text = root.textContent ?? "";

    expect(text).toContain("failed open: timeout");
    expect(text).toContain("checkout");
    expect(text).toContain("subtotal text");
  });

  it("never interprets page text as HTML", () => {
    const { root, panel } = mount();
    const evil = { ...draft, items: [{ name: '<img src=x onerror="alert(1)">', price_minor: 1, qty: 1 }], total_minor: 1 };
    panel.update(snapshot({ inspection: { pageType: "cart", draft: evil, problems: [] } }));

    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it("collapses and expands, and destroy removes it", () => {
    const { root, panel } = mount();
    const toggle = root.querySelector("button")!;

    toggle.click();
    expect(root.querySelector(".auxo-debug")!.classList.contains("collapsed")).toBe(true);
    toggle.click();
    expect(root.querySelector(".auxo-debug")!.classList.contains("collapsed")).toBe(false);

    panel.destroy();
    expect(root.querySelector(".auxo-debug")).toBeNull();
    expect(root.querySelector("style")).toBeNull();
  });
});

describe("click tracking lines", () => {
  it("shows the trigger, last click, events, and a pending purchase", () => {
    const { root, panel } = mount();
    panel.update(
      snapshot({
        trigger: { intent: "add_to_cart", source: "known", page_type: "product", occurred_at: "2026-10-04T20:00:00.000Z", label: "Add to Cart" },
        lastClick: { signal: { intent: "add_to_cart", source: "known", label: "Add to Cart" }, at: new Date("2026-10-04T20:00:00Z") },
        events: [{ action: "removed", decisionId: "2b9ebefe-78c8-561e-9a68-da51842c65a8", at: new Date("2026-10-04T20:01:00Z") }],
        pendingPurchase: "2b9ebefe-78c8-561e-9a68-da51842c65a8",
      }),
    );
    const text = root.textContent ?? "";

    expect(text).toContain('add_to_cart (known: "Add to Cart")');
    expect(text).toContain("Events sent");
    expect(text).toContain("removed");
    expect(text).toContain("pending confirmation");
  });

  it("shows a note when there is one", () => {
    const { root, panel } = mount();
    panel.update(snapshot({ note: "handed over by the worker" }));

    expect(root.textContent).toContain("handed over by the worker");
  });

  it("shows 'none' when nothing was clicked", () => {
    const { root, panel } = mount();
    panel.update(snapshot());

    expect(root.textContent).toContain("last click");
    expect(root.textContent).toContain("none");
  });
});

describe("money", () => {
  it("formats minor units for display", () => {
    expect(money(0, "USD")).toBe("$0.00");
    expect(money(999, "USD")).toBe("$9.99");
    expect(money(123456, "USD")).toBe("$1,234.56");
    expect(money(500, "EUR")).toBe("EUR 5.00");
  });
});
