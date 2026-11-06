import type { Verdict } from "@auxo/shared";
import { describe, expect, it, vi } from "vitest";

import { handleOverlayExit, type ExitDeps, type PassReply } from "./exit";

const NOW = Date.parse("2026-11-06T12:00:00Z");

const block: Verdict = {
  decision_id: "11111111-1111-4111-8111-111111111111",
  lane: "L3",
  action: "block",
  template_id: "l3-block",
  cooldown_seconds: 30,
};

function deps(requestPass: ExitDeps["requestPass"]) {
  return {
    requestPass: vi.fn(requestPass),
    close: vi.fn(),
    override: vi.fn(),
    saveForLater: vi.fn(),
    sendEvent: vi.fn(),
    note: vi.fn(),
    timeoutMs: 3_000,
    now: () => NOW,
  } satisfies ExitDeps;
}

const passUntil = (iso: string) => async (): Promise<PassReply> => ({ ok: true, expiresAt: iso });

describe("handleOverlayExit", () => {
  it("lifts the block until the pass expires", async () => {
    const d = deps(passUntil("2026-11-06T12:10:00Z"));
    await handleOverlayExit(block, "overrode", d);

    expect(d.requestPass).toHaveBeenCalledWith(block.decision_id);
    expect(d.close).toHaveBeenCalledOnce();
    expect(d.override).toHaveBeenCalledWith(block.decision_id, Date.parse("2026-11-06T12:10:00Z"));
    expect(d.sendEvent).toHaveBeenCalledWith(expect.objectContaining({ decision_id: block.decision_id, action: "overrode" }));
  });

  // AUX-36: a failed pass used to leave the overlay up with every button
  // disabled. Errors fail open: the overlay closes and the next click goes through.
  it.each<[string, ExitDeps["requestPass"]]>([
    ["the worker says no", async () => ({ ok: false })],
    ["the worker is unavailable", async () => Promise.reject(new Error("no worker"))],
    ["the worker gives no answer", async () => undefined],
    ["the pass has already expired", passUntil("2026-11-06T11:59:00Z")],
    ["the pass has no expiry", async () => ({ ok: true })],
  ])("fails open when %s", async (_, requestPass) => {
    const d = deps(requestPass);
    await handleOverlayExit(block, "overrode", d);

    expect(d.close).toHaveBeenCalledOnce();
    expect(d.override).toHaveBeenCalledWith(block.decision_id, undefined);
    expect(d.sendEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "overrode" }));
    expect(d.note).toHaveBeenCalledWith(expect.stringContaining("without a pass"));
  });

  it("fails open when the pass takes longer than the timeout", async () => {
    vi.useFakeTimers();
    try {
      const d = deps(() => new Promise<PassReply>(() => {}));
      const done = handleOverlayExit(block, "overrode", d);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(d.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await done;

      expect(d.close).toHaveBeenCalledOnce();
      expect(d.override).toHaveBeenCalledWith(block.decision_id, undefined);
      expect(d.sendEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "overrode" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for no pass when the answer only warns", async () => {
    const d = deps(passUntil("2026-11-06T12:10:00Z"));
    await handleOverlayExit({ ...block, lane: "L2", action: "allow" }, "overrode", d);

    expect(d.requestPass).not.toHaveBeenCalled();
    expect(d.close).toHaveBeenCalledOnce();
    expect(d.override).toHaveBeenCalledWith(block.decision_id, undefined);
  });

  it("asks for no pass on Leave or Save for later", async () => {
    const left = deps(passUntil("2026-11-06T12:10:00Z"));
    await handleOverlayExit(block, "left", left);
    expect(left.requestPass).not.toHaveBeenCalled();
    expect(left.override).not.toHaveBeenCalled();
    expect(left.close).toHaveBeenCalledOnce();
    expect(left.sendEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "left" }));

    const saved = deps(passUntil("2026-11-06T12:10:00Z"));
    await handleOverlayExit(block, "saved", saved);
    expect(saved.saveForLater).toHaveBeenCalledWith(block.decision_id);
    expect(saved.sendEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "saved" }));
  });

  it("sends nothing for the dev placeholder answer", async () => {
    const d = deps(passUntil("2026-11-06T12:10:00Z"));
    await handleOverlayExit(block, "overrode", d, { synthetic: true });

    expect(d.requestPass).not.toHaveBeenCalled();
    expect(d.close).toHaveBeenCalledOnce();
    expect(d.override).toHaveBeenCalledWith(block.decision_id, undefined);
    expect(d.sendEvent).not.toHaveBeenCalled();
  });
});
