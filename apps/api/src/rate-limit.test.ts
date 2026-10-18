import { describe, expect, it } from "vitest";

import { InMemoryRateLimitStore, RateLimiter, rateLimitKey } from "./rate-limit.js";

describe("RateLimiter", () => {
  it("limits a key after max requests in a window and resets afterwards", async () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(new InMemoryRateLimitStore(), 2, 60_000, () => now);

    expect((await limiter.consume("ip:1")).limited).toBe(false);
    expect((await limiter.consume("ip:1")).limited).toBe(false);
    now += 30_000;
    expect(await limiter.consume("ip:1")).toEqual({ limited: true, retryAfterSeconds: 30 });

    now += 30_000;
    expect((await limiter.consume("ip:1")).limited).toBe(false);
  });

  it("keeps separate buckets per key", async () => {
    const limiter = new RateLimiter(new InMemoryRateLimitStore(), 1, 60_000, () => 0);

    expect((await limiter.consume("user:a")).limited).toBe(false);
    expect((await limiter.consume("user:b")).limited).toBe(false);
    expect((await limiter.consume("user:a")).limited).toBe(true);
  });
});

describe("InMemoryRateLimitStore", () => {
  it("drops expired windows once it holds too many keys", async () => {
    const store = new InMemoryRateLimitStore(2);
    await store.hit("a", 1_000, 0);
    await store.hit("b", 1_000, 0);
    await store.hit("c", 1_000, 0);

    await store.hit("d", 1_000, 5_000);

    expect(store.size).toBe(1);
  });
});

describe("rateLimitKey", () => {
  it("prefers the user id and falls back to the IP", () => {
    expect(rateLimitKey("u1", "10.0.0.1")).toBe("user:u1");
    expect(rateLimitKey(null, "10.0.0.1")).toBe("ip:10.0.0.1");
  });
});
