import type { Cart, Verdict } from "@auxo/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { decide } from "./client";

const cart: Cart = {
  merchant: "amazon.com",
  items: [{ name: "Desk lamp", price_minor: 2499, qty: 1 }],
  total_minor: 2499,
  currency: "USD",
  url: "https://www.amazon.com/gp/cart/view.html",
  cart_hash: "a".repeat(63) + "3",
};

const verdict: Verdict = {
  decision_id: "2b9ebefe-78c8-561e-9a68-da51842c65a8",
  lane: "L3",
  action: "block",
  template_id: "l3-block",
  cooldown_seconds: 300,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("decide", () => {
  it("posts the cart to /v1/decide and returns the verdict", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(verdict));

    const result = await decide(cart, { baseUrl: "http://127.0.0.1:3001", fetch: fetchMock });

    expect(result).toEqual({ ok: true, verdict });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:3001/v1/decide");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ cart });
  });

  it("sends the trigger with the cart when given", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(verdict));
    const trigger = {
      intent: "add_to_cart" as const,
      source: "known" as const,
      page_type: "product" as const,
      occurred_at: "2026-10-04T20:00:00.000Z",
    };

    await decide(cart, { baseUrl: "http://x", fetch: fetchMock }, trigger);

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ cart, trigger });
  });

  it("fails open with 'http' on a non-2xx status", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ error: { code: "INVALID_REQUEST", message: "bad" } }, 400),
    );

    expect(await decide(cart, { baseUrl: "http://x", fetch: fetchMock })).toEqual({
      ok: false,
      reason: "http",
    });
  });

  it("fails open with 'invalid_response' when the body is not a Verdict", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ lane: "L9" }));

    expect(await decide(cart, { baseUrl: "http://x", fetch: fetchMock })).toEqual({
      ok: false,
      reason: "invalid_response",
    });
  });

  it("fails open with 'invalid_response' when the body is not JSON", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("not json"));

    expect(await decide(cart, { baseUrl: "http://x", fetch: fetchMock })).toEqual({
      ok: false,
      reason: "invalid_response",
    });
  });

  it("fails open with 'network' when fetch rejects", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));

    expect(await decide(cart, { baseUrl: "http://x", fetch: fetchMock })).toEqual({
      ok: false,
      reason: "network",
    });
  });

  it("fails open with 'timeout' when the API does not answer in time", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );

    const pending = decide(cart, { baseUrl: "http://x", fetch: fetchMock, timeoutMs: 2_500 });
    await vi.advanceTimersByTimeAsync(2_500);

    expect(await pending).toEqual({ ok: false, reason: "timeout" });
  });
});
