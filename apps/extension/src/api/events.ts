import { OutcomeReceiptSchema, type DecisionEvent } from "@auxo/shared";

import type { EventResult, ExitAction } from "../messages";

// Logging an exit is not on the checkout path, but it should not hang the
// worker either. Same budget as the decide call.
export const EVENT_TIMEOUT_MS = 2_500;

export interface PostEventOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

// The API dedupes on event_id: 201 for a new event, 200 with duplicate: true
// for a retry. Build the event once and reuse it for any retry.
export async function postEvent(event: DecisionEvent, options: PostEventOptions): Promise<EventResult> {
  const fetchFn = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? EVENT_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await fetchFn(new URL("/v1/events", options.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
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

    const parsed = OutcomeReceiptSchema.safeParse(body);
    return parsed.success ? { ok: true, duplicate: parsed.data.duplicate } : { ok: false, reason: "invalid_response" };
  } finally {
    clearTimeout(timer);
  }
}

// The event for a user's choice on the overlay. Each call gets a new event_id.
export function buildExitEvent(decisionId: string, action: ExitAction, now: Date = new Date()): DecisionEvent {
  return {
    event_id: crypto.randomUUID(),
    decision_id: decisionId,
    action,
    occurred_at: now.toISOString(),
  };
}
