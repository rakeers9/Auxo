import { beforeEach, describe, expect, it, vi } from "vitest";
import { browser } from "wxt/browser";
const auth = vi.hoisted(() => ({ getSession: vi.fn(), refreshSession: vi.fn(), signOut: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth }) }));
import { authenticatedFetch, configureAuth } from "./session";
beforeEach(async () => {
  vi.unstubAllGlobals();
  await browser.storage.local.set({ "auxo:auth-config": { url: "https://test.supabase.co", key: "public" } });
  auth.getSession.mockResolvedValue({ data: { session: { access_token: "first" } }, error: null });
});
describe("authenticated API connector", () => {
  it("adds a bearer token", async () => {
    const fn = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fn);
    await authenticatedFetch("https://example.com", { headers: { "content-type": "application/json" } });
    expect(fn.mock.calls[0]?.[1].headers.get("Authorization")).toBe("Bearer first");
  });
  it("refreshes and retries once after a 401", async () => {
    auth.refreshSession.mockResolvedValue({ data: { session: { access_token: "renewed" } }, error: null });
    const fn = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 401 })).mockResolvedValueOnce(new Response("{}")); vi.stubGlobal("fetch", fn);
    await authenticatedFetch("https://example.com");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[1]?.[1].headers.get("Authorization")).toBe("Bearer renewed");
  });
  it("does not send requests when signed out", async () => {
    auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const fn = vi.fn(); vi.stubGlobal("fetch", fn);
    await expect(authenticatedFetch("https://example.com")).rejects.toThrow("Sign in required");
    expect(fn).not.toHaveBeenCalled();
  });
  it("rejects untrusted auth hosts", async () => {
    await expect(configureAuth("https://evil.example", "public")).rejects.toThrow("Supabase project URL");
  });
});
