import { DecisionEventSchema, type DecisionEvent } from "@auxo/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildExitEvent, postEvent } from "./events";

const event: DecisionEvent = {
  event_id: "8a4f0c2e-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
  decision_id: "2b9ebefe-78c8-561e-9a68-da51842c65a8",
  action: "overrode",
  occurred_at: "2026-10-04T17:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("postEvent", () => {
  it("posts the event to /v1/events and reports a new event (201)", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ accepted: true, duplicate: false }, 201));

    const result = await postEvent(event, { baseUrl: "http://127.0.0.1:3001", fetch: fetchMock });

    expect(result).toEqual({ ok: true, duplicate: false });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:3001/v1/events");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual(event);
  });

  it("reports a retry the API already has as a duplicate (200)", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ accepted: true, duplicate: true }, 200));

    expect(await postEvent(event, { baseUrl: "http://x", fetch: fetchMock })).toEqual({ ok: true, duplicate: true });
  });

  it.each([
    [400, "INVALID_REQUEST"],
    [401, "UNAUTHORIZED"],
    [404, "DECISION_NOT_FOUND"],
    [429, "RATE_LIMITED"],
    [500, "INTERNAL"],
    [503, "UNAVAILABLE"],
  ])("returns 'http' on a %i", async (status, code) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: { code, message: "no" } }, status));

    expect(await postEvent(event, { baseUrl: "http://x", fetch: fetchMock })).toEqual({ ok: false, reason: "http" });
  });

  it.each([
    ["missing duplicate", { accepted: true }],
    ["accepted false", { accepted: false, duplicate: false }],
    ["extra field", { accepted: true, duplicate: false, extra: 1 }],
    ["not an object", ["accepted"]],
  ])("returns 'invalid_response' for a malformed receipt (%s)", async (_label, body) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body, 201));

    expect(await postEvent(event, { baseUrl: "http://x", fetch: fetchMock })).toEqual({
      ok: false,
      reason: "invalid_response",
    });
  });

  it("returns 'invalid_response' when the body is not JSON", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("not json", { status: 201 }));

    expect(await postEvent(event, { baseUrl: "http://x", fetch: fetchMock })).toEqual({
      ok: false,
      reason: "invalid_response",
    });
  });

  it("returns 'network' when fetch rejects", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));

    expect(await postEvent(event, { baseUrl: "http://x", fetch: fetchMock })).toEqual({ ok: false, reason: "network" });
  });

  it("returns 'timeout' when the API does not answer in time", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );

    const pending = postEvent(event, { baseUrl: "http://x", fetch: fetchMock, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toEqual({ ok: false, reason: "timeout" });
  });

  it("clears its timeout once the API answers", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ accepted: true, duplicate: false }, 201));

    await postEvent(event, { baseUrl: "http://x", fetch: fetchMock });

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("buildExitEvent", () => {
  it.each(["left", "saved", "overrode"] as const)("builds a valid %s event", (action) => {
    const now = new Date("2026-10-04T17:30:15.250Z");
    const built = buildExitEvent(event.decision_id, action, now);

    expect(DecisionEventSchema.safeParse(built).success).toBe(true);
    expect(built).toMatchObject({
      decision_id: event.decision_id,
      action,
      occurred_at: "2026-10-04T17:30:15.250Z",
    });
    expect(built).not.toHaveProperty("metadata");
  });

  it("gives every event a fresh event_id", () => {
    const a = buildExitEvent(event.decision_id, "left");
    const b = buildExitEvent(event.decision_id, "left");
    expect(a.event_id).not.toBe(b.event_id);
  });

  it("defaults occurred_at to now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T18:00:00.000Z"));
    expect(buildExitEvent(event.decision_id, "saved").occurred_at).toBe("2026-10-04T18:00:00.000Z");
  });
});
