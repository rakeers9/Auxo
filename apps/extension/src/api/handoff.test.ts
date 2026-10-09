import type { Trigger, Verdict } from "@auxo/shared";
import { describe, expect, it } from "vitest";

import type { DecideResult } from "../messages";
import { createHandoff } from "./handoff";

const verdict = (id: string): Verdict => ({
  decision_id: id,
  lane: "L3",
  action: "block",
  template_id: "l3-block",
  cooldown_seconds: 300,
});
const trigger = (intent: Trigger["intent"]): Trigger => ({
  intent,
  source: "known",
  page_type: "product",
  occurred_at: "2026-10-04T20:00:00.000Z",
});
const ok = (id: string): Promise<DecideResult> => Promise.resolve({ ok: true, verdict: verdict(id) });

describe("createHandoff", () => {
  it("hands an add-to-cart answer to the next page in the tab, once", async () => {
    const h = createHandoff();
    h.track(7, trigger("add_to_cart"), ok("a"));

    expect(await h.claim(7)).toEqual(verdict("a"));
    expect(await h.claim(7)).toBeNull();
  });

  it("waits for an answer that's still on its way", async () => {
    const h = createHandoff();
    let answer!: (r: DecideResult) => void;
    h.track(7, trigger("add_to_cart"), new Promise((resolve) => (answer = resolve)));

    const claimed = h.claim(7);
    answer({ ok: true, verdict: verdict("a") });
    expect(await claimed).toEqual(verdict("a"));
  });

  it("doesn't hand over an answer the asking page already got", async () => {
    const h = createHandoff();
    h.track(7, trigger("add_to_cart"), ok("a"));

    await h.ack(7, "a");
    expect(await h.claim(7)).toBeNull();
  });

  it("ignores an ack for a different decision", async () => {
    const h = createHandoff();
    h.track(7, trigger("add_to_cart"), ok("b"));

    await h.ack(7, "a");
    expect(await h.claim(7)).toEqual(verdict("b"));
  });

  it("keeps tabs separate", async () => {
    const h = createHandoff();
    h.track(7, trigger("add_to_cart"), ok("a"));

    expect(await h.claim(8)).toBeNull();
    expect(await h.claim(7)).toEqual(verdict("a"));
  });

  it("only tracks add to cart", async () => {
    const h = createHandoff();
    for (const intent of ["buy_now", "view_cart", "checkout", "page_view"] as const) {
      h.track(7, trigger(intent), ok(intent));
    }
    h.track(7, undefined, ok("none"));

    expect(await h.claim(7)).toBeNull();
  });

  it("a newer add to cart replaces the older one", async () => {
    const h = createHandoff();
    h.track(7, trigger("add_to_cart"), ok("a"));
    h.track(7, trigger("add_to_cart"), ok("b"));

    expect(await h.claim(7)).toEqual(verdict("b"));
  });

  it("returns nothing when the request failed or threw", async () => {
    const h = createHandoff();
    h.track(7, trigger("add_to_cart"), Promise.resolve({ ok: false, reason: "timeout" }));
    expect(await h.claim(7)).toBeNull();

    h.track(7, trigger("add_to_cart"), Promise.reject(new Error("boom")));
    expect(await h.claim(7)).toBeNull();
  });

  it("forgets a closed tab", async () => {
    const h = createHandoff();
    h.track(7, trigger("add_to_cart"), ok("a"));
    h.forget(7);

    expect(await h.claim(7)).toBeNull();
  });
});
