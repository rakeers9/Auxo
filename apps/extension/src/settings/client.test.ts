import { describe, expect, it, vi } from "vitest";

import { SignedOutError } from "../api/session";
import { isSettingsMessage, parseSettingsRequest, runSettingsRequest } from "./client";

const BASE = "https://api.example.com";
const RULE = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "No clothes",
  rule_type: "description",
  configuration: { description: "I don't want to buy clothes" },
  enabled: true,
  created_at: "2026-11-06T12:00:00.000Z",
  updated_at: "2026-11-06T12:00:00.000Z",
};
const BUDGET = {
  id: "22222222-2222-4222-8222-222222222222",
  currency: "USD",
  limit_minor: 30_000,
  spent_minor: 0,
  period_start: "2026-11-01",
  period_end: "2026-11-30",
  created_at: "2026-11-06T12:00:00.000Z",
  updated_at: "2026-11-06T12:00:00.000Z",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Answers like the API: lists, plus whatever a write returns.
function api(write: () => Response = () => json(RULE, 201)) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname === "/v1/rules") return json({ rules: [RULE] });
    if (method === "GET" && url.pathname === "/v1/budgets") return json({ budgets: [BUDGET] });
    return write();
  });
}

describe("parseSettingsRequest", () => {
  it("accepts requests that match the shared contracts", () => {
    expect(parseSettingsRequest({ op: "list" })).toEqual({ op: "list" });
    expect(parseSettingsRequest({ op: "create-rule", rule: { name: "x", rule_type: "description", configuration: { description: "x" }, enabled: true } })).not.toBeNull();
    expect(parseSettingsRequest({ op: "delete-budget", id: BUDGET.id })).not.toBeNull();
  });

  it.each([
    null,
    { op: "drop-tables" },
    { op: "delete-rule", id: "../v1/passes" },
    { op: "create-rule", rule: { name: "x", rule_type: "description", configuration: { description: "" }, enabled: true } },
    { op: "update-rule", id: RULE.id, update: {} },
    { op: "list", extra: true },
  ])("rejects %j", (request) => {
    expect(parseSettingsRequest(request)).toBeNull();
  });

  it("recognizes the message", () => {
    expect(isSettingsMessage({ type: "auxo:settings", request: { op: "list" } })).toBe(true);
    expect(isSettingsMessage({ type: "auxo:decide" })).toBe(false);
  });
});

describe("runSettingsRequest", () => {
  it("lists rules and budgets", async () => {
    const fetch = api();
    expect(await runSettingsRequest({ op: "list" }, { baseUrl: BASE, fetch })).toEqual({ ok: true, rules: [RULE], budgets: [BUDGET] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("sends a write, then returns the whole list again", async () => {
    const fetch = api();
    const rule = { name: "No clothes", rule_type: "description", configuration: { description: "I don't want to buy clothes" }, enabled: true };

    const result = await runSettingsRequest({ op: "create-rule", rule }, { baseUrl: BASE, fetch });

    expect(result).toMatchObject({ ok: true, rules: [RULE] });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE}/v1/rules`);
    expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    expect(JSON.parse(String(init?.body))).toEqual(rule);
  });

  it.each([
    [{ op: "update-rule", id: RULE.id, update: { enabled: false } }, "PATCH", `/v1/rules/${RULE.id}`],
    [{ op: "delete-rule", id: RULE.id }, "DELETE", `/v1/rules/${RULE.id}`],
    [{ op: "update-budget", id: BUDGET.id, update: { limit_minor: 100 } }, "PATCH", `/v1/budgets/${BUDGET.id}`],
    [{ op: "delete-budget", id: BUDGET.id }, "DELETE", `/v1/budgets/${BUDGET.id}`],
  ])("sends %j to the right route", async (request, method, path) => {
    const fetch = api(() => (method === "DELETE" ? new Response(null, { status: 204 }) : json(RULE)));
    expect((await runSettingsRequest(request, { baseUrl: BASE, fetch })).ok).toBe(true);
    const [url, init] = fetch.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe(path);
    expect(init?.method).toBe(method);
  });

  it("never calls the API for an invalid request", async () => {
    const fetch = api();
    expect(await runSettingsRequest({ op: "delete-rule", id: "nope" }, { baseUrl: BASE, fetch })).toEqual({ ok: false, reason: "invalid" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports signed out, from the session or the API", async () => {
    const throwing = vi.fn(async () => {
      throw new SignedOutError("Sign in required.");
    });
    expect(await runSettingsRequest({ op: "list" }, { baseUrl: BASE, fetch: throwing })).toEqual({ ok: false, reason: "signed_out" });
    const unauthorized = vi.fn(async () => json({ error: { code: "UNAUTHORIZED", message: "No." } }, 401));
    expect(await runSettingsRequest({ op: "list" }, { baseUrl: BASE, fetch: unauthorized })).toEqual({ ok: false, reason: "signed_out" });
  });

  it("passes on the API's error message", async () => {
    const fetch = api(() => json({ error: { code: "INVALID_REQUEST", message: "The rule request is invalid." } }, 400));
    const rule = { name: "x", rule_type: "description", configuration: { description: "x" }, enabled: true };
    expect(await runSettingsRequest({ op: "create-rule", rule }, { baseUrl: BASE, fetch })).toEqual({
      ok: false,
      reason: "http",
      message: "The rule request is invalid.",
    });
  });

  it("reports a network failure and a malformed list", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await runSettingsRequest({ op: "list" }, { baseUrl: BASE, fetch: offline })).toEqual({ ok: false, reason: "network" });
    const odd = vi.fn(async () => json({ rules: [{ id: "x" }], budgets: [] }));
    expect(await runSettingsRequest({ op: "list" }, { baseUrl: BASE, fetch: odd })).toEqual({ ok: false, reason: "invalid_response" });
  });
});
