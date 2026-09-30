import { afterEach, describe, expect, it } from "vitest";

import { VerdictSchema } from "@auxo/shared";

import { buildApp } from "./app.js";

const openApps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function cartWithHashSuffix(suffix: string) {
  return {
    merchant: "Example Store",
    items: [{ name: "Example item", price_minor: 2_500, qty: 1 }],
    total_minor: 2_500,
    currency: "USD",
    url: "https://example.com/cart",
    cart_hash: `${"0".repeat(63)}${suffix}`,
  };
}

describe("GET /health", () => {
  it("reports that the service is healthy", async () => {
    const app = await buildApp();
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});

describe("POST /v1/decide", () => {
  it.each([
    ["0", "L1", "allow", 0],
    ["1", "L2", "pause", 60],
    ["2", "L3", "block", 300],
    ["3", "L4", "block", 900],
  ])("maps hash suffix %s to %s", async (suffix, lane, action, cooldownSeconds) => {
    const app = await buildApp();
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/decide",
      payload: { cart: cartWithHashSuffix(suffix) },
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(VerdictSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      lane,
      action,
      cooldown_seconds: cooldownSeconds,
    });
  });

  it("returns the same verdict for the same cart hash", async () => {
    const app = await buildApp();
    openApps.push(app);
    const payload = { cart: cartWithHashSuffix("2") };

    const first = await app.inject({ method: "POST", url: "/v1/decide", payload });
    const second = await app.inject({ method: "POST", url: "/v1/decide", payload });

    expect(second.json()).toEqual(first.json());
  });

  it("rejects an invalid cart", async () => {
    const app = await buildApp();
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/decide",
      payload: { cart: { merchant: "Example Store" } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
  });
});
