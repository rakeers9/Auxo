import { VerdictSchema, type Cart, type Trigger } from "@auxo/shared";

import type { DecideResult } from "../messages";

// The API's Jev call may take up to JEV_TIMEOUT_MS (2000 ms by default), so
// the client waits a little longer before giving up and failing open.
export const DECIDE_TIMEOUT_MS = 2_500;

export interface DecideOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export async function decide(cart: Cart, options: DecideOptions, trigger?: Trigger): Promise<DecideResult> {
  const fetchFn = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DECIDE_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await fetchFn(new URL("/v1/decide", options.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(trigger ? { cart, trigger } : { cart }),
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
