import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { inspectPage } from "./inspect";

function load(name: string): void {
  document.documentElement.innerHTML = readFileSync(resolve(__dirname, "../cart/__fixtures__", name), "utf8");
}

describe("inspectPage", () => {
  it("reads a real cart page", () => {
    load("amazon-cart.html");
    const result = inspectPage(document, new URL("https://www.amazon.com/gp/cart/view.html"));

    expect(result.pageType).toBe("cart");
    expect(result.draft?.items.length).toBeGreaterThan(0);
    expect(result.problems).toEqual([]);
  });

  it("reports an empty cart as a cart page it could not read", () => {
    load("amazon-cart-empty.html");
    const result = inspectPage(document, new URL("https://www.amazon.com/gp/cart/view.html"));

    expect(result.pageType).toBe("cart");
    expect(result.draft).toBeNull();
    expect(result.problems.length).toBe(1);
  });

  it("treats a product page as 'other'", () => {
    load("amazon-product.html");
    const result = inspectPage(document, new URL("https://www.amazon.com/dp/B0TEST0001"));

    expect(result).toEqual({ pageType: "other", draft: null, problems: [] });
  });
});
