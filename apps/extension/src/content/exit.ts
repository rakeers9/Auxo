import type { DecisionEvent, Verdict } from "@auxo/shared";

import { buildExitEvent } from "../api/events";
import type { ExitAction } from "../messages";

// Asks the worker for a pass (handled in entrypoints/background.ts).
export interface PassMessage {
  type: "auxo:pass";
  decisionId: string;
}

// The worker's answer to an "auxo:pass" message.
export interface PassReply {
  ok?: boolean;
  expiresAt?: string;
}

export interface ExitDeps {
  // Asks the worker for a pass that lifts this decision's block.
  requestPass(decisionId: string): Promise<PassReply | undefined>;
  // Removes the overlay.
  close(): void;
  // Lets the user's next buy clicks through, until `expiresAt` (ms) or, with
  // none, until the page gets a different answer.
  override(decisionId: string, expiresAt?: number): void;
  saveForLater(decisionId: string): void;
  sendEvent(event: DecisionEvent): void;
  // A line for the debug panel.
  note(text: string): void;
  // How long to wait for the pass before failing open.
  timeoutMs: number;
  now?: () => number;
}

export interface ExitOptions {
  // The dev placeholder answer: no pass is asked for and nothing is sent.
  synthetic?: boolean;
}

// Runs one overlay exit: Leave, Save for later, or Continue / Go anyway.
//
// Continuing past a block asks for a pass first. If the pass fails, comes back
// unusable, or takes longer than `timeoutMs`, the exit still goes ahead (fails
// open, AUX-36): the overlay closes, the next click goes through, and the
// override is still logged. The overlay's buttons are disabled once one is
// clicked, so returning early here would leave the user stuck.
export async function handleOverlayExit(
  verdict: Verdict,
  action: ExitAction,
  deps: ExitDeps,
  options: ExitOptions = {},
): Promise<void> {
  const synthetic = options.synthetic ?? false;
  let expiresAt: number | undefined;
  if (action === "overrode" && !synthetic && verdict.action !== "allow") {
    expiresAt = await passExpiry(verdict.decision_id, deps);
    if (expiresAt === undefined) deps.note("Continued without a pass: the pass request failed or timed out.");
  }
  deps.close();
  if (action === "overrode") deps.override(verdict.decision_id, expiresAt);
  if (synthetic) return;
  if (action === "saved") deps.saveForLater(verdict.decision_id);
  deps.sendEvent(buildExitEvent(verdict.decision_id, action));
}

// The pass's expiry (ms), or undefined when there's no usable pass in time.
async function passExpiry(decisionId: string, deps: ExitDeps): Promise<number | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), deps.timeoutMs);
  });
  try {
    const reply = await Promise.race([deps.requestPass(decisionId).catch(() => undefined), timeout]);
    const until = Date.parse(reply?.expiresAt ?? "");
    if (!reply?.ok || !Number.isFinite(until) || until <= (deps.now ?? Date.now)()) return undefined;
    return until;
  } finally {
    clearTimeout(timer);
  }
}
