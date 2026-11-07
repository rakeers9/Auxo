import { isSupportedTimeZone, VerdictSchema, type Cart, type Trigger } from "@auxo/shared";

import type { DecideResult } from "../messages";

// The API's Jev call may take up to JEV_TIMEOUT_MS (2000 ms by default), so
// the client waits a little longer before giving up and failing open.
export const DECIDE_TIMEOUT_MS = 2_500;

export interface DecideOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  // The user's IANA time zone; defaults to the browser's. Lets the API use
  // the user's local time (late-night shopping, weekends).
  timeZone?: string;
}

// The browser's IANA time zone, or undefined when it can't be read. Only
// zones the API accepts are sent, so a bad one never turns into a 400.
export function browserTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isSupportedTimeZone(zone) ? zone : undefined;
  } catch {
    return undefined;
  }
}

export async function decide(cart: Cart, options: DecideOptions, trigger?: Trigger): Promise<DecideResult> {
  const fetchFn = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DECIDE_TIMEOUT_MS);
  const requested = options.timeZone ?? browserTimeZone();
  const timeZone = requested !== undefined && isSupportedTimeZone(requested) ? requested : undefined;

  try {
    let response: Response;
    try {
      response = await fetchFn(new URL("/v1/decide", options.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cart, ...(trigger ? { trigger } : {}), ...(timeZone ? { time_zone: timeZone } : {}) }),
        signal: controller.signal,
      });
    } catch {
      return { ok: false, reason: controller.signal.aborted ? "timeout" : "network" };
    }

    if (!response.ok) {
      return { ok: false, reason: "http" };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, reason: controller.signal.aborted ? "timeout" : "invalid_response" };
    }

    const parsed = VerdictSchema.safeParse(body);
    return parsed.success ? { ok: true, verdict: parsed.data } : { ok: false, reason: "invalid_response" };
  } finally {
    clearTimeout(timer);
  }
}
