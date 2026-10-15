import { beforeEach, describe, expect, it, vi } from "vitest";
import { browser } from "wxt/browser";
const auth = vi.hoisted(() => ({ getSession: vi.fn(), refreshSession: vi.fn(), signOut: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth }) }));
import { authenticatedFetch, configureAuth, isLoopbackRequest } from "./session";
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
  it("sends unsigned requests to the local API when signed out", async () => {
    auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const fn = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fn);
    await authenticatedFetch("http://127.0.0.1:3001/v1/decide", { headers: { "content-type": "application/json" } });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(new Headers(fn.mock.calls[0]?.[1]?.headers).has("Authorization")).toBe(false);
  });
  it("sends unsigned requests to the local API before sign-in is configured", async () => {
    await browser.storage.local.remove("auxo:auth-config");
    await configureAuth("https://test.supabase.co", "public"); // resets the cached client
    await browser.storage.local.remove("auxo:auth-config");
    const fn = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fn);
    await authenticatedFetch(new URL("http://localhost:3001/v1/config"));
    expect(fn).toHaveBeenCalledTimes(1);
    await expect(authenticatedFetch("https://api.example.com/v1/config")).rejects.toThrow("options page");
  });
  it("still signs local requests when signed in", async () => {
    const fn = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fn);
    await authenticatedFetch("http://127.0.0.1:3001/v1/decide");
    expect(fn.mock.calls[0]?.[1].headers.get("Authorization")).toBe("Bearer first");
  });
  it("only treats loopback hosts as local", () => {
    expect(isLoopbackRequest("http://127.0.0.1:3001/x")).toBe(true);
    expect(isLoopbackRequest("http://localhost/x")).toBe(true);
    expect(isLoopbackRequest("http://[::1]:3001/x")).toBe(true);
    expect(isLoopbackRequest(new Request("http://127.0.0.1:3001/x"))).toBe(true);
    expect(isLoopbackRequest("https://api-ten-sand-28.vercel.app/v1/decide")).toBe(false);
    expect(isLoopbackRequest("https://127.0.0.1.evil.example/x")).toBe(false);
    expect(isLoopbackRequest("not a url")).toBe(false);
  });
  it("rejects untrusted auth hosts", async () => {
    await expect(configureAuth("https://evil.example", "public")).rejects.toThrow("Supabase project URL");
  });
});
