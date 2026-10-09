import type { StoreConfig } from "@auxo/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { KeyValueArea } from "./decision-memory";
import { CONFIG_MAX_AGE_MS, createConfigCache, fetchStoreConfig, overridesFor } from "./store-config";

const config = (version: string, enabled = true): StoreConfig => ({
  version,
  stores: { "www.amazon.com": { enabled, buttons: { buy_now: ["#buy-now-button"] } } },
});

function area(): KeyValueArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
    set: async (items) => void Object.assign(data, structuredClone(items)),
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.useRealTimers());

describe("fetchStoreConfig", () => {
  it("returns a valid config from GET /v1/config", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json(config("v1")));

    expect(await fetchStoreConfig({ baseUrl: "http://127.0.0.1:3001", fetch: fetchMock })).toEqual(config("v1"));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:3001/v1/config");
  });

  it("returns null for errors, bad bodies, and anything that isn't pure config data", async () => {
    const cases: Array<Promise<Response>> = [
      Promise.resolve(json({ error: { code: "X", message: "x" } }, 500)),
      Promise.resolve(new Response("not json")),
      Promise.resolve(json({ version: "v1", stores: { "www.amazon.com": { enabled: true, script: "alert(1)" } } })),
      Promise.reject(new TypeError("offline")),
    ];
    for (const response of cases) {
      expect(await fetchStoreConfig({ baseUrl: "http://x", fetch: () => response })).toBeNull();
    }
  });

  it("gives up after the timeout", async () => {
    vi.useFakeTimers();
    const hanging = vi.fn<typeof fetch>(
      (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    const pending = fetchStoreConfig({ baseUrl: "http://x", fetch: hanging, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await pending).toBeNull();
  });
});

describe("createConfigCache", () => {
  it("fetches once, then serves the cached copy while it's fresh", async () => {
    let t = 0;
    const load = vi.fn().mockResolvedValue(config("v1"));
    const cache = createConfigCache({ load, area: area(), now: () => t });

    expect(await cache.get()).toEqual(config("v1"));
    t = CONFIG_MAX_AGE_MS - 1;
    expect(await cache.get()).toEqual(config("v1"));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("refreshes a stale copy", async () => {
    let t = 0;
    const load = vi.fn().mockResolvedValueOnce(config("v1")).mockResolvedValueOnce(config("v2"));
    const cache = createConfigCache({ load, area: area(), now: () => t });

    await cache.get();
    t = CONFIG_MAX_AGE_MS;
    expect((await cache.get())?.version).toBe("v2");
  });

  it("keeps the last good copy when the backend is down", async () => {
    let t = 0;
    const load = vi.fn().mockResolvedValueOnce(config("v1")).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("x"));
    const cache = createConfigCache({ load, area: area(), now: () => t });

    await cache.get();
    t = CONFIG_MAX_AGE_MS;
    expect((await cache.get())?.version).toBe("v1");
    expect((await cache.get())?.version).toBe("v1");
  });

  it("returns null when there has never been a config", async () => {
    const cache = createConfigCache({ load: async () => null, area: area() });
    expect(await cache.get()).toBeNull();
  });

  it("survives a worker restart through storage", async () => {
    const shared = area();
    await createConfigCache({ load: async () => config("v1"), area: shared, now: () => 0 }).get();

    const load = vi.fn();
    expect((await createConfigCache({ load, area: shared, now: () => 1 }).get())?.version).toBe("v1");
    expect(load).not.toHaveBeenCalled();
  });

  it("ignores a corrupted cached copy", async () => {
    const shared = area();
    shared.data["auxo:store-config"] = { config: { version: 1 }, fetchedAt: 0 };
    const cache = createConfigCache({ load: async () => config("v2"), area: shared, now: () => 0 });

    expect((await cache.get())?.version).toBe("v2");
  });

  it("shares one fetch between callers asking at the same time", async () => {
    const load = vi.fn().mockResolvedValue(config("v1"));
    const cache = createConfigCache({ load, area: area() });

    await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("overridesFor", () => {
  it("picks one host's overrides", () => {
    expect(overridesFor(config("v1"), "www.amazon.com")).toEqual({ enabled: true, buttons: { buy_now: ["#buy-now-button"] } });
    expect(overridesFor(config("v1"), "www.walmart.com")).toBeNull();
    expect(overridesFor(null, "www.amazon.com")).toBeNull();
  });
});
