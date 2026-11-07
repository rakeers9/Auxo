import type { ReadFailureReport } from "@auxo/shared";
import { describe, expect, it, vi } from "vitest";

import type { KeyValueArea } from "./decision-memory";
import {
  READ_FAILURES_PER_HOUR,
  buildReadFailureReport,
  createReadFailureLimiter,
  handleReadFailureMessage,
  postReadFailure,
  readFailureReportingEnabled,
} from "./read-failures";

const NOW = new Date("2026-10-26T23:30:00.000Z");
const CART_PAGE = "https://www.amazon.com/gp/cart/view.html?ref_=nav_cart";
const message = { type: "auxo:read-failure", reader: "amazon_cart", page_type: "cart", codes: ["item.no_price"] };
const report: ReadFailureReport = {
  reader: "amazon_cart",
  page_type: "cart",
  store_host: "www.amazon.com",
  extension_version: "0.0.0",
  codes: ["item.no_price"],
  day: "2026-10-26",
};

function memoryArea(): KeyValueArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (key) => (key in data ? { [key]: data[key] } : {}),
    set: async (items) => void Object.assign(data, structuredClone(items)),
  };
}

describe("readFailureReportingEnabled", () => {
  it("is on in production builds and off in dev builds unless WXT_REPORT_READ_FAILURES=1", () => {
    expect(readFailureReportingEnabled("production", undefined)).toBe(true);
    expect(readFailureReportingEnabled("development", undefined)).toBe(false);
    expect(readFailureReportingEnabled("development", "0")).toBe(false);
    expect(readFailureReportingEnabled("development", "1")).toBe(true);
  });
});

describe("buildReadFailureReport", () => {
  const build = (m: unknown, senderUrl: string | undefined) =>
    buildReadFailureReport(m, { senderUrl, version: "0.0.0", now: NOW });

  it("adds the store host, version and UTC day; nothing from the URL beyond the host", () => {
    expect(build(message, CART_PAGE)).toEqual(report);
    expect(JSON.stringify(build(message, CART_PAGE))).not.toContain("view.html");
  });

  it("sends no host for Shopify stores", () => {
    expect(build({ ...message, reader: "shopify_cart", codes: ["shopify.timeout"] }, "https://www.allbirds.com/cart")).toEqual({
      ...report,
      reader: "shopify_cart",
      codes: ["shopify.timeout"],
      store_host: null,
    });
  });

  it.each<[string, unknown, string | undefined]>([
    ["an Amazon reader on another site", message, "https://www.example.com/cart"],
    ["no sender page", message, undefined],
    ["problem text in place of codes", { ...message, codes: ['item 1 has no readable data-price: "8.982"'] }, CART_PAGE],
    ["no codes", { ...message, codes: [] }, CART_PAGE],
    ["an extra field", { ...message, title: "Unscented hand soap" }, CART_PAGE],
    ["another message type", { ...message, type: "auxo:event" }, CART_PAGE],
  ])("drops %s", (_label, m, senderUrl) => {
    expect(build(m, senderUrl)).toBeNull();
  });
});

describe("createReadFailureLimiter", () => {
  it("lets each distinct failure through once per day", async () => {
    const limiter = createReadFailureLimiter(memoryArea());
    expect(await limiter.allow(report, NOW)).toBe(true);
    expect(await limiter.allow(report, NOW)).toBe(false);
    expect(await limiter.allow({ ...report, codes: ["total.missing"] }, NOW)).toBe(true);
    expect(await limiter.allow({ ...report, day: "2026-10-27" }, new Date("2026-10-27T01:00:00.000Z"))).toBe(true);
  });

  it(`sends at most ${READ_FAILURES_PER_HOUR} reports an hour`, async () => {
    const limiter = createReadFailureLimiter(memoryArea(), 2);
    const page = (page_type: ReadFailureReport["page_type"]) => ({ ...report, page_type });
    expect(await limiter.allow(page("cart"), NOW)).toBe(true);
    expect(await limiter.allow(page("checkout"), NOW)).toBe(true);
    expect(await limiter.allow(page("product"), NOW)).toBe(false);
    expect(await limiter.allow(page("product"), new Date(NOW.getTime() + 3_600_000))).toBe(true);
  });

  it("keeps its limits across worker restarts (session storage)", async () => {
    const area = memoryArea();
    expect(await createReadFailureLimiter(area).allow(report, NOW)).toBe(true);
    expect(await createReadFailureLimiter(area).allow(report, NOW)).toBe(false);
  });

  it("doesn't let two messages at once both take the last slot", async () => {
    const limiter = createReadFailureLimiter(memoryArea(), 1);
    const results = await Promise.all([limiter.allow(report, NOW), limiter.allow({ ...report, page_type: "checkout" }, NOW)]);
    expect(results).toEqual([true, false]);
  });
});

describe("postReadFailure", () => {
  it("posts the report as JSON and is true on 204", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    expect(await postReadFailure(report, { baseUrl: "https://api.example", fetch: fetchMock })).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.example/v1/read-failures");
    expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    expect(JSON.parse(String(init?.body))).toEqual(report);
  });

  it("is false, never throwing, on an error status, a network error, or a timeout", async () => {
    const options = (fetchFn: typeof fetch) => ({ baseUrl: "https://api.example", fetch: fetchFn, timeoutMs: 5 });
    expect(await postReadFailure(report, options(vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }))))).toBe(false);
    expect(await postReadFailure(report, options(vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline"))))).toBe(false);
    const hanging = vi.fn<typeof fetch>((_u, init) => new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    expect(await postReadFailure(report, options(hanging))).toBe(false);
  });
});

describe("handleReadFailureMessage", () => {
  const deps = (post = vi.fn(async () => true), area = memoryArea()) => ({
    senderUrl: CART_PAGE,
    version: "0.0.0",
    now: () => NOW,
    limiter: createReadFailureLimiter(area),
    post,
  });

  it("builds, limits, and posts the report", async () => {
    const d = deps();
    expect(await handleReadFailureMessage(message, d)).toBe(true);
    expect(d.post).toHaveBeenCalledExactlyOnceWith(report);
    expect(await handleReadFailureMessage(message, d)).toBe(false);
    expect(d.post).toHaveBeenCalledTimes(1);
  });

  it("posts nothing for an invalid message", async () => {
    const d = deps();
    expect(await handleReadFailureMessage({ ...message, codes: ["nope"] }, d)).toBe(false);
    expect(d.post).not.toHaveBeenCalled();
  });

  it("never throws, even when storage or the post fails", async () => {
    const broken: KeyValueArea = { get: async () => { throw new Error("quota"); }, set: async () => {} };
    expect(await handleReadFailureMessage(message, deps(undefined, broken as never))).toBe(false);
    expect(await handleReadFailureMessage(message, deps(vi.fn(async () => { throw new Error("boom"); })))).toBe(false);
  });
});
