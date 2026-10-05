import type { Lane, Verdict } from "@auxo/shared";
import { VerdictSchema } from "@auxo/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderClickAgainHint, renderOverlay, type OverlayHandle } from "./render";
import { CLICK_PAUSE_COPY, LANE_TEMPLATES } from "./templates";

const COOLDOWN: Record<Lane, number> = { L0: 0, L1: 0, L2: 60, L3: 300, L4: 900 };
const ACTION: Record<Lane, Verdict["action"]> = { L0: "allow", L1: "allow", L2: "pause", L3: "block", L4: "block" };

function verdict(lane: Lane, overrides: Partial<Verdict> = {}): Verdict {
  return VerdictSchema.parse({
    decision_id: "6f1c2b8e-3d4a-4c5b-9e7f-0a1b2c3d4e5f",
    lane,
    action: ACTION[lane],
    template_id: LANE_TEMPLATES[lane].id,
    cooldown_seconds: COOLDOWN[lane],
    ...overrides,
  });
}

function mount(): ShadowRoot {
  const host = document.createElement("div");
  document.body.append(host);
  return host.attachShadow({ mode: "open" });
}

function btn(root: ShadowRoot, action: string): HTMLButtonElement {
  const b = root.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`);
  if (!b) throw new Error(`no ${action} button`);
  return b;
}

function text(root: ShadowRoot, role: string): string {
  return root.querySelector(`[data-role="${role}"]`)?.textContent ?? "";
}

function press(root: ShadowRoot, key: string): KeyboardEvent {
  const target = root.activeElement ?? document.activeElement ?? document.body;
  const event = new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

let root: ShadowRoot;
let handle: OverlayHandle | null;

beforeEach(() => {
  vi.useFakeTimers();
  root = mount();
  handle = null;
});

afterEach(() => {
  handle?.destroy();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("renderOverlay with a stopped click", () => {
  it.each(["L3", "L4"] as const)("%s names what was paused and keeps the usual copy", (lane) => {
    handle = renderOverlay(root, verdict(lane), { onExit: vi.fn() }, { clicked: "Place your order" });
    const dialog = root.querySelector('[role="dialog"]');
    expect(text(root, "stopped")).toBe("We paused “Place your order”.");
    expect(dialog?.textContent).toContain(LANE_TEMPLATES[lane].title);
    expect(dialog?.textContent).toContain(LANE_TEMPLATES[lane].body);
    expect(root.querySelector<HTMLElement>(".auxo-overlay")?.dataset.clicked).toBe("Place your order");
  });

  it("the stopped line is part of the dialog's description", () => {
    handle = renderOverlay(root, verdict("L3"), { onExit: vi.fn() }, { clicked: "Buy Now" });
    const dialog = root.querySelector('[role="dialog"]');
    const ids = dialog?.getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(ids).toHaveLength(2);
    expect(root.getElementById(ids[0] ?? "")?.textContent).toBe("We paused “Buy Now”.");
  });

  it("Go anyway reads Continue and stays locked for the cooldown", () => {
    handle = renderOverlay(root, verdict("L3"), { onExit: vi.fn() }, { clicked: "Place your order" });
    const go = btn(root, "go-anyway");
    expect(go.textContent).toBe("Continue");
    expect(go.disabled).toBe(true);
    expect(text(root, "countdown")).toBe("Continue unlocks in 5:00");

    vi.advanceTimersByTime(299_000);
    expect(go.disabled).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(go.disabled).toBe(false);
    expect(text(root, "countdown")).toBe("You can continue now.");
  });

  it.each([
    ["leave", "left"],
    ["save", "saved"],
    ["go-anyway", "overrode"],
  ] as const)("%s reports %s, once", (action, expected) => {
    const onExit = vi.fn();
    handle = renderOverlay(root, verdict("L4"), { onExit }, { clicked: "Add to cart" });
    vi.advanceTimersByTime(COOLDOWN.L4 * 1000);
    btn(root, action).click();
    btn(root, "leave").click();
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(expected);
  });

  it("Escape does nothing and focus stays trapped", () => {
    const onExit = vi.fn();
    handle = renderOverlay(root, verdict("L3"), { onExit }, { clicked: "Place your order" });
    expect(press(root, "Escape").defaultPrevented).toBe(true);
    expect(onExit).not.toHaveBeenCalled();
    expect(root.querySelector('[role="dialog"]')).not.toBeNull();
    expect((root.activeElement as HTMLElement | null)?.dataset.action).toBe("leave");
    press(root, "Tab");
    expect((root.activeElement as HTMLElement | null)?.dataset.action).toBe("save");
  });

  describe("on a verdict whose action isn't block (dev mode)", () => {
    it("L2 pause still shows the block screen with the verdict's cooldown", () => {
      handle = renderOverlay(root, verdict("L2"), { onExit: vi.fn() }, { clicked: "Proceed to checkout" });
      expect([...root.querySelectorAll("button")].map((b) => b.dataset.action)).toEqual(["leave", "save", "go-anyway"]);
      expect(text(root, "stopped")).toBe("We paused “Proceed to checkout”.");
      expect(root.textContent).toContain(LANE_TEMPLATES.L2.title);
      expect(text(root, "countdown")).toBe("Continue unlocks in 1:00");
      vi.advanceTimersByTime(60_000);
      expect(btn(root, "go-anyway").disabled).toBe(false);
    });

    it("L1 allow shows the block screen, unlocked at once (cooldown 0)", () => {
      handle = renderOverlay(root, verdict("L1"), { onExit: vi.fn() }, { clicked: "Add to cart" });
      expect(root.querySelector(".auxo-banner")).toBeNull();
      expect(root.querySelector('[role="dialog"]')).not.toBeNull();
      expect(btn(root, "go-anyway").disabled).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("L0 renders (instead of null) with the generic copy", () => {
      handle = renderOverlay(root, verdict("L0"), { onExit: vi.fn() }, { clicked: "Buy Now" });
      expect(handle).not.toBeNull();
      expect(root.textContent).toContain(CLICK_PAUSE_COPY.title);
      expect(root.textContent).toContain(CLICK_PAUSE_COPY.body);
      expect(btn(root, "go-anyway").disabled).toBe(false);
    });

    it("an allow verdict with a cooldown still gates Continue", () => {
      handle = renderOverlay(root, verdict("L1", { cooldown_seconds: 10 }), { onExit: vi.fn() }, { clicked: "Buy Now" });
      expect(btn(root, "go-anyway").disabled).toBe(true);
      vi.advanceTimersByTime(10_000);
      expect(btn(root, "go-anyway").disabled).toBe(false);
    });
  });

  it("cleans the label: collapses whitespace and caps it at 200 characters", () => {
    handle = renderOverlay(root, verdict("L3"), { onExit: vi.fn() }, { clicked: `  Place \n your   order ${"x".repeat(300)}` });
    const clicked = root.querySelector<HTMLElement>(".auxo-overlay")?.dataset.clicked ?? "";
    expect(clicked.startsWith("Place your order x")).toBe(true);
    expect(clicked.length).toBeLessThanOrEqual(200);
  });

  it("an empty label still says a click was paused", () => {
    handle = renderOverlay(root, verdict("L3"), { onExit: vi.fn() }, { clicked: "   " });
    expect(text(root, "stopped")).toBe("We paused that click.");
  });

  it("renders the label as text, never markup", () => {
    handle = renderOverlay(root, verdict("L3"), { onExit: vi.fn() }, { clicked: '<img src=x onerror="alert(1)">' });
    expect(root.querySelector("img")).toBeNull();
    expect(text(root, "stopped")).toContain("<img");
  });

  it("destroy() removes everything and clears the cooldown timer", () => {
    handle = renderOverlay(root, verdict("L3"), { onExit: vi.fn() }, { clicked: "Place your order" });
    handle?.destroy();
    expect(root.childNodes).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("without a click, the block screen is unchanged", () => {
    handle = renderOverlay(root, verdict("L3"), { onExit: vi.fn() }, {});
    expect(root.querySelector('[data-role="stopped"]')).toBeNull();
    expect(btn(root, "go-anyway").textContent).toBe("Go anyway");
    expect(root.querySelector<HTMLElement>(".auxo-overlay")?.dataset.clicked).toBeUndefined();
  });
});

describe("renderClickAgainHint", () => {
  it("is a non-modal banner naming the button", () => {
    handle = renderClickAgainHint(root, "Place your order", { onDismiss: vi.fn() });
    const banner = root.querySelector('[role="status"]');
    expect(banner?.textContent).toContain("You can click “Place your order” now.");
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(root.querySelector("style")?.textContent).toContain(".auxo-banner");
  });

  it("never takes or traps focus", () => {
    const pageButton = document.createElement("button");
    document.body.append(pageButton);
    pageButton.focus();
    handle = renderClickAgainHint(root, "Buy Now", { onDismiss: vi.fn() });
    expect(document.activeElement).toBe(pageButton);

    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    expect(document.activeElement).toBe(other);
  });

  it("the dismiss button removes it and calls onDismiss once", () => {
    const onDismiss = vi.fn();
    handle = renderClickAgainHint(root, "Buy Now", { onDismiss });
    btn(root, "dismiss").click();
    expect(root.childNodes).toHaveLength(0);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    press(root, "Escape");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("Escape dismisses it without swallowing the key", () => {
    const onDismiss = vi.fn();
    handle = renderClickAgainHint(root, "Buy Now", { onDismiss });
    const event = press(root, "Escape");
    expect(event.defaultPrevented).toBe(false);
    expect(root.childNodes).toHaveLength(0);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("destroy() removes it without calling onDismiss, and Escape is no longer heard", () => {
    const onDismiss = vi.fn();
    handle = renderClickAgainHint(root, "Buy Now", { onDismiss });
    handle.destroy();
    expect(root.childNodes).toHaveLength(0);
    press(root, "Escape");
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("renders the label as text and handles an empty one", () => {
    handle = renderClickAgainHint(root, "<b>x</b>", { onDismiss: vi.fn() });
    expect(root.querySelector("b")).toBeNull();
    handle.destroy();
    handle = renderClickAgainHint(root, "  ", { onDismiss: vi.fn() });
    expect(root.textContent).toContain("You can click it now.");
  });
});
