import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CartSchema } from "@auxo/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hashCart } from "../cart";
import { createShopifyAdapter, readShopifyCartFrom } from "./shopify";

// Real responses saved from public Shopify stores (see src/cart/__fixtures__/shopify).
const FIXTURES = resolve(__dirname, "../cart/__fixtures__/shopify");
const allbirdsCart = readFileSync(resolve(FIXTURES, "allbirds-cart.json"), "utf8");
const allbirdsEmpty = readFileSync(resolve(FIXTURES, "allbirds-cart-empty.json"), "utf8");
const gymsharkHeadless = readFileSync(resolve(FIXTURES, "gymshark-cart-headless.html"), "utf8");

// Allbirds serves /cart.js as text/javascript, Gymshark answers 404 HTML.
const respond = (body: string, status = 200, type = "text/javascript") =>
  vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status, headers: { "content-type": type } }));

afterEach(() => vi.useRealTimers());

describe("readShopifyCartFrom", () => {
  it("reads a real Shopify cart from /cart.js with the visitor's cookies", async () => {
    const fetchMock = respond(allbirdsCart);
    const result = await readShopifyCartFrom(new URL("https://www.allbirds.com/products/x"), fetchMock);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://www.allbirds.com/cart.js");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin" });
    expect(result.draft?.items.length).toBeGreaterThan(0);
    expect(CartSchema.safeParse({ ...result.draft!, cart_hash: await hashCart(result.draft!) }).success).toBe(true);
  });

  it("an empty cart reads as no draft", async () => {
    const result = await readShopifyCartFrom(new URL("https://www.allbirds.com/cart"), respond(allbirdsEmpty));
    expect(result.draft).toBeNull();
  });

  it("a headless store (404 HTML) fails open", async () => {
    const result = await readShopifyCartFrom(new URL("https://www.gymshark.com/cart"), respond(gymsharkHeadless, 404, "text/html"));
    expect(result.draft).toBeNull();
    expect(result.problems.join(" ")).toMatch(/no Shopify cart API/);
  });

  it("network errors and timeouts fail open", async () => {
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline"));
    expect((await readShopifyCartFrom(new URL("https://s.example/cart"), failing)).draft).toBeNull();

    vi.useFakeTimers();
    const hanging = vi.fn<typeof fetch>(
      (_u, init) => new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    const pending = readShopifyCartFrom(new URL("https://s.example/cart"), hanging, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).problems).toEqual(["/cart.js didn't answer in time"]);
  });
});

describe("createShopifyAdapter", () => {
  const adapterAt = (href: string, fetchMock = respond(allbirdsCart)) =>
    createShopifyAdapter({ fetch: fetchMock, location: () => new URL(href), doc: document });

  it("reads the cart on /cart", async () => {
    const reading = await adapterAt("https://www.allbirds.com/cart").inspect(null);
    expect(reading.pageType).toBe("cart");
    expect(reading.draft?.items.length).toBeGreaterThan(0);
  });

  it("doesn't read product or other pages, and says why", async () => {
    const fetchMock = respond(allbirdsCart);
    const product = await adapterAt("https://www.allbirds.com/products/mens-tree-runners", fetchMock).inspect(null);
    expect(product).toMatchObject({ pageType: "product", draft: null });
    expect(product.problems[0]).toMatch(/adds show up in the cart/);
    expect((await adapterAt("https://www.allbirds.com/pages/about", fetchMock).inspect(null)).pageType).toBe("other");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies Shopify's standard buttons as known on any host", () => {
    document.body.innerHTML = readFileSync(resolve(FIXTURES, "dawn-cart-buttons.html"), "utf8");
    const checkout = document.querySelector('button[name="checkout"]');
    expect(checkout).not.toBeNull();

    const signal = adapterAt("https://any-store.example/cart").classifyClick(checkout, new URL("https://any-store.example/cart"), null);
    expect(signal).toMatchObject({ intent: "checkout", source: "known" });
  });

  it("reads the whole cart from /cart.js for the cross-tab check", async () => {
    const draft = await adapterAt("https://www.allbirds.com/pages/about").fullCart!(null);
    expect(draft?.items.length).toBeGreaterThan(0);
  });

  it("watches /cart.js and reports an add as a cart change", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="cart-count">0</div>';
    const full = JSON.parse(allbirdsCart);
    let body = JSON.stringify({ ...full, items: full.items.slice(0, 1), items_subtotal_price: full.items[0].final_line_price, item_count: full.items[0].quantity });
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(body));
    const onChange = vi.fn();

    const stop = adapterAt("https://www.allbirds.com/products/x", fetchMock).watch({
      onPageChange: () => {},
      reportChange: onChange,
      overrides: null,
      loadedAs: "product",
      ignore: () => [],
    });
    await vi.advanceTimersByTimeAsync(0);

    // The theme updates its cart count after the add; /cart.js now has a higher quantity.
    const bumped = { ...full.items[0], quantity: full.items[0].quantity + 1, final_line_price: full.items[0].final_price * (full.items[0].quantity + 1) };
    body = JSON.stringify({ ...full, items: [bumped], items_subtotal_price: bumped.final_line_price, item_count: bumped.quantity });
    document.getElementById("cart-count")!.textContent = "1";
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(600);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![2].added).toEqual([expect.objectContaining({ qty: 1, price_minor: full.items[0].final_price })]);
    stop();
  });
});
