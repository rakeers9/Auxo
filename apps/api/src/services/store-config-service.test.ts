import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../application.js";
import { InMemoryStoreConfigRepository } from "../repositories/store-config-repository.js";
import { stableStringify, StoreConfigService, versionOf } from "./store-config-service.js";

describe("StoreConfigService", () => {
  it("reports each skipped recipe and merchant", async () => {
    const amazon = { id: randomUUID(), domain: "www.amazon.com", enabled: true };
    const blank = { id: randomUUID(), domain: "", enabled: true };
    const duplicate = { id: randomUUID(), domain: "WWW.AMAZON.COM", enabled: true };
    const onSkipped = vi.fn();
    const service = new StoreConfigService(
      new InMemoryStoreConfigRepository({
        merchants: [amazon, blank, duplicate],
        recipes: [{ merchant_id: amazon.id, version: 3, enabled: true, selectors: { buttons: { page_view: ["#x"] } } }],
      }),
      onSkipped,
    );

    const config = await service.getConfig();

    expect(Object.keys(config.stores)).toEqual(["www.amazon.com"]);
    expect(onSkipped).toHaveBeenCalledTimes(3);
    expect(onSkipped).toHaveBeenCalledWith({ domain: "", reason: "domain isn't a valid hostname key" });
    expect(onSkipped).toHaveBeenCalledWith({ domain: "WWW.AMAZON.COM", reason: "another merchant already uses www.amazon.com" });
    expect(onSkipped).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "www.amazon.com", recipe_version: 3, reason: expect.stringContaining("buttons") }),
    );
  });

  it("returns the API error shape when the store tables can't be read", async () => {
    const app = await buildApp({
      storeConfigRepository: {
        listMerchants: async () => {
          throw new Error("Unable to list merchants.");
        },
        listEnabledRecipes: async () => [],
      },
    });

    const response = await app.inject({ method: "GET", url: "/v1/config" });
    await app.close();

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } });
  });
});

describe("versionOf", () => {
  it("is 'default' with no stores", () => {
    expect(versionOf({})).toBe("default");
  });

  it("depends on content, not key order", () => {
    const a = versionOf({ "a.com": { enabled: true, selectors: { x: "#x", y: "#y" } }, "b.com": { enabled: false } });
    const b = versionOf({ "b.com": { enabled: false }, "a.com": { selectors: { y: "#y", x: "#x" }, enabled: true } });
    expect(a).toBe(b);
    expect(versionOf({ "a.com": { enabled: true } })).not.toBe(versionOf({ "a.com": { enabled: false } }));
  });
});

describe("stableStringify", () => {
  it("sorts object keys at every level and keeps array order", () => {
    expect(stableStringify({ b: [2, 1], a: { d: null, c: "x" } })).toBe('{"a":{"c":"x","d":null},"b":[2,1]}');
  });
});
