import type { Verdict } from "@auxo/shared";
import { describe, expect, it } from "vitest";

import type { ClickSignal } from "../messages";
import { createClickGate } from "./gate";

const verdict = (lane: Verdict["lane"], action: Verdict["action"], id = "11111111-1111-4111-8111-111111111111"): Verdict => ({
  decision_id: id,
  lane,
  action,
  template_id: `${lane.toLowerCase()}-x`,
  cooldown_seconds: 300,
});
const devVerdict = verdict("L3", "block", "00000000-0000-4000-8000-000000000000");
const known = (intent: ClickSignal["intent"]): ClickSignal => ({ intent, source: "known", label: "Btn" });

describe("createClickGate (production)", () => {
  const gate = () => createClickGate({ alwaysOn: false, devVerdict });

  it("blocks known buy clicks when the page's answer is block", () => {
    const g = gate();
    g.setVerdict(verdict("L4", "block"));
    for (const intent of ["add_to_cart", "buy_now", "checkout", "place_order"] as const) {
      expect(g.check(known(intent))).toEqual({ block: true, verdict: verdict("L4", "block"), synthetic: false });
    }
  });

  it("lets clicks through for allow and pause answers, or no answer", () => {
    const g = gate();
    expect(g.check(known("place_order"))).toEqual({ block: false });
    g.setVerdict(verdict("L2", "pause"));
    expect(g.check(known("place_order"))).toEqual({ block: false });
    g.setVerdict(verdict("L1", "allow"));
    expect(g.check(known("place_order"))).toEqual({ block: false });
  });

  it("never gates guesses or going to the cart", () => {
    const g = gate();
    g.setVerdict(verdict("L3", "block"));
    expect(g.check({ intent: "place_order", source: "guess" })).toEqual({ block: false });
    expect(g.check(known("view_cart"))).toEqual({ block: false });
  });

  it("lets the user's own next click through after they continue", () => {
    const g = gate();
    g.setVerdict(verdict("L3", "block"));
    expect(g.check(known("place_order")).block).toBe(true);

    g.override("11111111-1111-4111-8111-111111111111");
    expect(g.check(known("place_order"))).toEqual({ block: false });
    expect(g.check(known("checkout"))).toEqual({ block: false });
  });

  it("blocks again when the page gets a new block answer", () => {
    const g = gate();
    g.setVerdict(verdict("L3", "block"));
    g.override("11111111-1111-4111-8111-111111111111");

    g.setVerdict(verdict("L3", "block", "22222222-2222-4222-8222-222222222222"));
    expect(g.check(known("place_order")).block).toBe(true);
  });
});

describe("createClickGate (dev: always on)", () => {
  it("blocks every gated known click, using the page's answer when there is one", () => {
    const g = createClickGate({ alwaysOn: true, devVerdict });
    g.setVerdict(verdict("L1", "allow"));

    expect(g.check(known("add_to_cart"))).toEqual({ block: true, verdict: verdict("L1", "allow"), synthetic: false });
  });

  it("uses the placeholder answer when the page has none, and marks it", () => {
    const g = createClickGate({ alwaysOn: true, devVerdict });

    expect(g.check(known("buy_now"))).toEqual({ block: true, verdict: devVerdict, synthetic: true });
  });

  it("still lets the next click through after continuing", () => {
    const g = createClickGate({ alwaysOn: true, devVerdict });
    g.override(devVerdict.decision_id);

    expect(g.check(known("buy_now"))).toEqual({ block: false });
  });

  it("still never gates guesses", () => {
    const g = createClickGate({ alwaysOn: true, devVerdict });
    expect(g.check({ intent: "buy_now", source: "guess" })).toEqual({ block: false });
  });
});
