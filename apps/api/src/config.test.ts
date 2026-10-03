import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("allows an unconfigured development environment", () => {
    const config = loadConfig({ NODE_ENV: "development" });

    expect(config.authMode).toBe("development");
    expect(config.supabaseUrl).toBeUndefined();
  });

  it("rejects production without required authentication", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "production", CORS_ORIGINS: "chrome-extension://example" }),
    ).toThrow("AUTH_MODE must be required");
  });

  it("rejects partial Supabase configuration", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "development", SUPABASE_URL: "https://example.supabase.co" }),
    ).toThrow("must be configured together");
  });
});
