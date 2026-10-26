import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp, type BuildAppOptions } from "./application.js";
import type { AuthService } from "./auth/auth-service.js";
import { InMemoryReadFailureRepository } from "./repositories/read-failure-repository.js";

const openApps: ReturnType<typeof buildApp>[] = [];
const NOW = new Date("2026-10-26T12:00:00.000Z");
const authService: AuthService = {
  authenticate: async (token) => (token === "user-a" ? { id: "a0000000-0000-4000-8000-000000000001" } : null),
};

const report = {
  reader: "amazon_cart",
  page_type: "cart",
  store_host: "www.amazon.com",
  extension_version: "0.0.0",
  codes: ["item.no_price"],
  day: "2026-10-26",
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function app(options: BuildAppOptions = {}) {
  const readFailureRepository = new InMemoryReadFailureRepository();
  const instance = buildApp({ authRequired: true, authService, readFailureRepository, ...options });
  openApps.push(instance);
  return { instance, reports: readFailureRepository.reports };
}

function post(instance: ReturnType<typeof buildApp>, payload: unknown, token: string | null = "user-a") {
  return instance.inject({
    method: "POST",
    url: "/v1/read-failures",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: payload as Record<string, unknown>,
  });
}

describe("POST /v1/read-failures", () => {
  it("stores the report as sent, with nothing about the user", async () => {
    const { instance, reports } = app();
    const response = await post(instance, report);
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(reports).toEqual([report]);
  });

  it("accepts a null store host (a shop the user visited isn't sent)", async () => {
    const { instance, reports } = app();
    const shopify = { ...report, reader: "shopify_cart", store_host: null, codes: ["shopify.timeout"] };
    expect((await post(instance, shopify)).statusCode).toBe(204);
    expect(reports).toEqual([shopify]);
  });

  it("requires a signed-in user", async () => {
    const { instance, reports } = app();
    expect((await post(instance, report, null)).statusCode).toBe(401);
    expect((await post(instance, report, "nobody")).statusCode).toBe(401);
    expect(reports).toEqual([]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["page text in place of a code", { codes: ['item 1 has no readable data-price: "8.982"'] }],
    ["an unknown code", { codes: ["price.vibes"] }],
    ["no codes", { codes: [] }],
    ["a repeated code", { codes: ["item.no_price", "item.no_price"] }],
    ["a URL as the host", { store_host: "https://www.amazon.com/gp/cart" }],
    ["a time in place of a day", { day: "2026-10-26T12:00:00Z" }],
    ["a date that doesn't exist", { day: "2026-02-30" }],
    ["an unknown page type", { page_type: "search" }],
    ["a free-form version", { extension_version: "dev build" }],
    ["an extra field", { url: "https://www.amazon.com/gp/cart/view.html" }],
    ["an extra field (title)", { title: "Unscented hand soap" }],
  ])("rejects %s", async (_label, change) => {
    const { instance, reports } = app();
    const response = await post(instance, { ...report, ...change });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
    expect(reports).toEqual([]);
  });

  it("accepts yesterday and tomorrow (UTC days differ by time zone) but nothing further", async () => {
    const { instance, reports } = app();
    for (const day of ["2026-10-25", "2026-10-27"]) expect((await post(instance, { ...report, day })).statusCode).toBe(204);
    for (const day of ["2026-10-24", "2026-10-28", "2025-10-26"]) {
      const response = await post(instance, { ...report, day });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.details.fieldErrors.day).toEqual(["day must be within a day of today (UTC)."]);
    }
    expect(reports.map((r) => r.day)).toEqual(["2026-10-25", "2026-10-27"]);
  });

  it("answers 500 when storage fails, so the extension just drops the report", async () => {
    const { instance } = app({ readFailureRepository: { record: async () => { throw new Error("down"); } } });
    expect((await post(instance, report)).statusCode).toBe(500);
  });
});
