import type { Lane, Verdict } from "@auxo/shared";
import { VerdictSchema } from "@auxo/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatSeconds, ideaFor, reasonLine, renderOverlay, type OverlayHandle } from "./render";
import { LANE_TEMPLATES } from "./templates";

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

function countdownText(root: ShadowRoot): string {
  return root.querySelector('[data-role="countdown"]')?.textContent ?? "";
}

// Dispatches a keydown from whatever has focus (inside the shadow root, or the page).
function press(root: ShadowRoot, key: string, shiftKey = false): KeyboardEvent {
  const target = root.activeElement ?? document.activeElement ?? document.body;
  const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, composed: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function focusedAction(root: ShadowRoot): string | undefined {
  return (root.activeElement as HTMLElement | null)?.dataset.action;
}

describe("renderOverlay", () => {
  let root: ShadowRoot;
  let onExit: ReturnType<typeof vi.fn<(action: string) => void>>;
  let handle: OverlayHandle | null;

  beforeEach(() => {
    vi.useFakeTimers();
    root = mount();
    onExit = vi.fn<(action: string) => void>();
    handle = null;
  });

  afterEach(() => {
    handle?.destroy();
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("L0 renders nothing and returns null", () => {
    handle = renderOverlay(root, verdict("L0"), { onExit });
    expect(handle).toBeNull();
    expect(root.childNodes).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["L1", "L2", "L3", "L4"] as const)("%s renders its lane template with styles", (lane) => {
    handle = renderOverlay(root, verdict(lane), { onExit });
    const template = LANE_TEMPLATES[lane];
    const container = root.querySelector<HTMLElement>(".auxo-overlay");
    expect(handle).not.toBeNull();
    expect(container?.dataset.lane).toBe(lane);
    expect(container?.dataset.template).toBe(template.id);
    expect(container?.textContent).toContain(template.title);
    expect(container?.textContent).toContain(template.body);
    expect(root.querySelector("style")?.textContent).toContain(".auxo-overlay");
  });

  describe("L1 banner", () => {
    it("is a non-modal banner with no exit buttons", () => {
      handle = renderOverlay(root, verdict("L1"), { onExit });
      expect(root.querySelector(".auxo-banner")).not.toBeNull();
      expect(root.querySelector('[role="dialog"]')).toBeNull();
      expect(root.querySelectorAll("button")).toHaveLength(1);
    });

    it("dismissing hides the banner without calling onExit", () => {
      handle = renderOverlay(root, verdict("L1"), { onExit });
      btn(root, "dismiss").click();
      expect(root.querySelector(".auxo-banner")).toBeNull();
      expect(onExit).not.toHaveBeenCalled();
    });
  });

  describe("L2 pause", () => {
    it("is a modal dialog", () => {
      handle = renderOverlay(root, verdict("L2"), { onExit });
      const dialog = root.querySelector('[role="dialog"]');
      expect(dialog?.getAttribute("aria-modal")).toBe("true");
      expect(root.querySelectorAll("button")).toHaveLength(1);
    });

    it("counts down and enables continue only after the cooldown", () => {
      handle = renderOverlay(root, verdict("L2"), { onExit });
      const cont = btn(root, "continue");
      expect(cont.disabled).toBe(true);
      expect(countdownText(root)).toBe("You can continue in 1:00");

      vi.advanceTimersByTime(15_000);
      expect(countdownText(root)).toBe("You can continue in 0:45");
      cont.click();
      expect(onExit).not.toHaveBeenCalled();

      vi.advanceTimersByTime(44_000);
      expect(cont.disabled).toBe(true);
      vi.advanceTimersByTime(1_000);
      expect(cont.disabled).toBe(false);
      expect(countdownText(root)).toBe("You can continue now.");
    });

    it("continue calls onExit('overrode') once", () => {
      handle = renderOverlay(root, verdict("L2"), { onExit });
      vi.advanceTimersByTime(60_000);
      btn(root, "continue").click();
      btn(root, "continue").click();
      expect(onExit).toHaveBeenCalledTimes(1);
      expect(onExit).toHaveBeenCalledWith("overrode");
    });

    it("a zero cooldown enables continue immediately", () => {
      handle = renderOverlay(root, verdict("L2", { cooldown_seconds: 0 }), { onExit });
      expect(btn(root, "continue").disabled).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe.each(["L3", "L4"] as const)("%s block", (lane) => {
    const cooldownMs = COOLDOWN[lane] * 1000;

    it("is a modal dialog with three exits and focuses Leave", () => {
      handle = renderOverlay(root, verdict(lane), { onExit });
      const dialog = root.querySelector('[role="dialog"]');
      expect(dialog?.getAttribute("aria-modal")).toBe("true");
      expect([...root.querySelectorAll<HTMLButtonElement>("button")].map((b) => b.dataset.action)).toEqual([
        "leave",
        "save",
        "go-anyway",
      ]);
      expect(root.activeElement).toBe(btn(root, "leave"));
    });

    it("go anyway is disabled until the cooldown passes", () => {
      handle = renderOverlay(root, verdict(lane), { onExit });
      const go = btn(root, "go-anyway");
      expect(go.disabled).toBe(true);
      expect(countdownText(root)).toBe(`Go anyway unlocks in ${formatSeconds(COOLDOWN[lane])}`);

      go.click();
      expect(onExit).not.toHaveBeenCalled();

      vi.advanceTimersByTime(cooldownMs - 1_000);
      expect(go.disabled).toBe(true);
      expect(countdownText(root)).toBe("Go anyway unlocks in 0:01");
      vi.advanceTimersByTime(1_000);
      expect(go.disabled).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
      ["leave", "left"],
      ["save", "saved"],
      ["go-anyway", "overrode"],
    ] as const)("%s calls onExit(%s)", (action, expected) => {
      handle = renderOverlay(root, verdict(lane), { onExit });
      vi.advanceTimersByTime(cooldownMs);
      btn(root, action).click();
      expect(onExit).toHaveBeenCalledTimes(1);
      expect(onExit).toHaveBeenCalledWith(expected);
    });

    it("leave and save work before the cooldown", () => {
      handle = renderOverlay(root, verdict(lane), { onExit });
      btn(root, "save").click();
      expect(onExit).toHaveBeenCalledWith("saved");
    });

    it("reports only the first exit", () => {
      handle = renderOverlay(root, verdict(lane), { onExit });
      btn(root, "leave").click();
      btn(root, "save").click();
      expect(onExit).toHaveBeenCalledTimes(1);
      expect(onExit).toHaveBeenCalledWith("left");
    });
  });

  it.each(["L1", "L2", "L3", "L4"] as const)("destroy() on %s removes every node and clears timers", (lane) => {
    handle = renderOverlay(root, verdict(lane), { onExit });
    handle?.destroy();
    expect(root.childNodes).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    handle?.destroy(); // idempotent
    expect(onExit).not.toHaveBeenCalled();
  });

  describe("keyboard", () => {
    it("L1: Escape dismisses the banner without calling onExit or swallowing the key", () => {
      handle = renderOverlay(root, verdict("L1"), { onExit });
      const event = press(root, "Escape");
      expect(root.querySelector(".auxo-banner")).toBeNull();
      expect(event.defaultPrevented).toBe(false);
      expect(onExit).not.toHaveBeenCalled();
    });

    it("L1: Escape listener is removed by destroy()", () => {
      handle = renderOverlay(root, verdict("L1"), { onExit });
      const banner = root.querySelector(".auxo-banner");
      handle?.destroy();
      root.append(banner as Node); // re-attach to prove the listener is gone
      press(root, "Escape");
      expect(root.querySelector(".auxo-banner")).not.toBeNull();
    });

    it.each(["L2", "L3", "L4"] as const)("%s: Escape does nothing and keeps the dialog", (lane) => {
      handle = renderOverlay(root, verdict(lane), { onExit });
      const outside = vi.fn();
      document.addEventListener("keydown", outside);
      const event = press(root, "Escape");
      document.removeEventListener("keydown", outside);

      expect(event.defaultPrevented).toBe(true);
      expect(outside).not.toHaveBeenCalled();
      expect(root.querySelector('[role="dialog"]')).not.toBeNull();
      expect(onExit).not.toHaveBeenCalled();
    });

    it("L3: Escape does not unlock go anyway", () => {
      handle = renderOverlay(root, verdict("L3"), { onExit });
      press(root, "Escape");
      expect(btn(root, "go-anyway").disabled).toBe(true);
    });

    it("L3: Tab and Shift+Tab skip the locked go anyway during the cooldown", () => {
      handle = renderOverlay(root, verdict("L3"), { onExit });
      expect(focusedAction(root)).toBe("leave");
      press(root, "Tab");
      expect(focusedAction(root)).toBe("save");
      press(root, "Tab");
      expect(focusedAction(root)).toBe("leave");
      press(root, "Tab", true);
      expect(focusedAction(root)).toBe("save");
    });

    it("L4: Tab cycles through all three buttons after the cooldown", () => {
      handle = renderOverlay(root, verdict("L4"), { onExit });
      vi.advanceTimersByTime(COOLDOWN.L4 * 1000);
      const seen = [focusedAction(root)];
      for (let i = 0; i < 3; i++) {
        const event = press(root, "Tab");
        expect(event.defaultPrevented).toBe(true);
        seen.push(focusedAction(root));
      }
      expect(seen).toEqual(["leave", "save", "go-anyway", "leave"]);
      press(root, "Tab", true);
      expect(focusedAction(root)).toBe("go-anyway");
    });

    it("L2: Tab keeps focus on the dialog while continue is locked, then reaches it", () => {
      handle = renderOverlay(root, verdict("L2"), { onExit });
      const dialog = root.querySelector('[role="dialog"]');
      expect(root.activeElement).toBe(dialog);
      press(root, "Tab");
      expect(root.activeElement).toBe(dialog);

      vi.advanceTimersByTime(COOLDOWN.L2 * 1000);
      press(root, "Tab");
      expect(focusedAction(root)).toBe("continue");
      press(root, "Tab");
      expect(focusedAction(root)).toBe("continue");
    });

    it("focus moved to the page is pulled back into the dialog", () => {
      handle = renderOverlay(root, verdict("L3"), { onExit });
      const pageButton = document.createElement("button");
      document.body.append(pageButton);
      pageButton.focus();
      expect(document.activeElement).not.toBe(pageButton);
      expect(root.activeElement).toBe(root.querySelector('[role="dialog"]'));
    });

    it("destroy() releases the focus trap", () => {
      handle = renderOverlay(root, verdict("L3"), { onExit });
      handle?.destroy();
      const pageButton = document.createElement("button");
      document.body.append(pageButton);
      pageButton.focus();
      expect(document.activeElement).toBe(pageButton);
    });
  });

  it("an unknown template_id falls back to the lane's template", () => {
    handle = renderOverlay(root, verdict("L3", { template_id: "l3-something-new" }), { onExit });
    const container = root.querySelector<HTMLElement>(".auxo-overlay");
    expect(container?.dataset.template).toBe("l3-block");
    expect(root.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("works when the root is a plain element", () => {
    const host = document.createElement("div");
    document.body.append(host);
    handle = renderOverlay(host, verdict("L3"), { onExit });
    expect(host.querySelector(".auxo-dialog")).not.toBeNull();
    handle?.destroy();
    expect(host.childNodes).toHaveLength(0);
  });
});

describe("formatSeconds", () => {
  it.each([
    [0, "0:00"],
    [9, "0:09"],
    [60, "1:00"],
    [905, "15:05"],
  ])("%i -> %s", (input, expected) => {
    expect(formatSeconds(input)).toBe(expected);
  });
});

describe("why the overlay showed up (AUX-50)", () => {
  type Context = NonNullable<Verdict["context"]>;
  function context(lane: Lane, overrides: Partial<Context> = {}): Context {
    return {
      decision_id: "6f1c2b8e-3d4a-4c5b-9e7f-0a1b2c3d4e5f",
      cart_summary: { merchant: "amazon.com", total_minor: 2_500, currency: "USD", item_count: 1 },
      budget: null,
      matched_rules: [],
      model_signal: null,
      decisive_factors: [{ code: "no_policy_match", source: "policy", lane }],
      available_actions: ["continue"],
      ...overrides,
    };
  }
  const rule = (name: string, lane: Lane) => ({
    rule_id: "11111111-1111-4111-8111-111111111111",
    name,
    rule_type: "description" as const,
    lane,
  });

  it("names the user's rule that set the lane", () => {
    const v = verdict("L2", { context: context("L2", { matched_rules: [rule("I don't want to buy clothes", "L2")] }) });
    expect(reasonLine(v)).toBe("Your rule: “I don't want to buy clothes”.");
  });

  it("counts other rules at the same lane and skips weaker ones", () => {
    const v = verdict("L3", {
      context: context("L3", { matched_rules: [rule("Weak", "L1"), rule("Clothes", "L3"), rule("Shoes", "L3")] }),
    });
    expect(reasonLine(v)).toBe("Your rules: “Clothes” and 1 more.");
  });

  it("names the budget when it set the lane", () => {
    const v = verdict("L4", {
      context: context("L4", {
        matched_rules: [rule("Clothes", "L1")],
        decisive_factors: [
          { code: "rule.description", source: "rule", lane: "L1" },
          { code: "budget.exceeded", source: "budget", lane: "L4" },
        ],
      }),
    });
    expect(reasonLine(v)).toBe("This would put you over your spending limit.");
  });

  it("says nothing when the model's own pick or the stub set the lane, or there's no context", () => {
    expect(reasonLine(verdict("L2"))).toBeUndefined();
    expect(reasonLine(verdict("L2", { context: context("L2", { decisive_factors: [{ code: "model.escalation", source: "model", lane: "L2" }] }) }))).toBeUndefined();
  });

  it("shows the line as text in the banner and in the pause dialog", () => {
    const sneaky = "<img src=x onerror=alert(1)>";
    for (const lane of ["L1", "L2"] as const) {
      const root = mount();
      const shown = renderOverlay(root, verdict(lane, { context: context(lane, { matched_rules: [rule(sneaky, lane)] }) }), { onExit: vi.fn() });
      const line = root.querySelector('[data-role="why"]');
      expect(line?.textContent).toBe(`Your rule: “${sneaky}”.`);
      expect(root.querySelector("img")).toBeNull();
      shown?.destroy();
    }
  });

  it("adds no line without a reason", () => {
    const root = mount();
    const shown = renderOverlay(root, verdict("L3"), { onExit: vi.fn() });
    expect(root.querySelector('[data-role="why"]')).toBeNull();
    shown?.destroy();
  });
});

describe("suggesting an alternative", () => {
  type Context = NonNullable<Verdict["context"]>;
  function withIdea(lane: Lane, alternative: Context["alternative"], merchant = "amazon.com"): Verdict {
    return verdict(lane, {
      context: {
        decision_id: "6f1c2b8e-3d4a-4c5b-9e7f-0a1b2c3d4e5f",
        cart_summary: { merchant, total_minor: 149_999, currency: "USD", item_count: 1 },
        budget: null,
        matched_rules: [],
        model_signal: null,
        decisive_factors: [{ code: "model.escalation", source: "model", lane }],
        available_actions: ["leave", "save_for_later", "continue"],
        ...(alternative ? { alternative } : {}),
      },
    });
  }

  it("links a renewed search on the same Amazon store", () => {
    const idea = ideaFor(withIdea("L2", { strategy: "renewed", probability: 0.7, query: "Gaming laptop & dock" }));
    expect(idea).toEqual({
      text: "Idea: a renewed or used one could do the same job for less.",
      link: { href: "https://www.amazon.com/s?k=Gaming%20laptop%20%26%20dock%20renewed", text: "See renewed options" },
    });
    expect(ideaFor(withIdea("L2", { strategy: "cheaper_version", probability: 0.6, query: "Desk" }, "amazon.co.uk"))?.link?.href).toBe(
      "https://www.amazon.co.uk/s?k=Desk",
    );
  });

  it("gives text only for strategies without a search, for other stores, or without a query", () => {
    expect(ideaFor(withIdea("L2", { strategy: "wait_for_deal", probability: 0.6 }))).toEqual({
      text: "Idea: this may not be urgent. Save it and see if the price drops.",
    });
    expect(ideaFor(withIdea("L2", { strategy: "renewed", probability: 0.7, query: "Laptop" }, "evil.example"))).not.toHaveProperty("link");
    expect(ideaFor(withIdea("L2", { strategy: "renewed", probability: 0.7 }))).not.toHaveProperty("link");
    expect(ideaFor(withIdea("L2", undefined))).toBeUndefined();
  });

  it("shows the idea in the banner and the pause dialog, as text, with a link that opens a new tab", () => {
    const sneaky = "<img src=x onerror=alert(1)>";
    for (const lane of ["L1", "L2", "L3"] as const) {
      const root = mount();
      const shown = renderOverlay(root, withIdea(lane, { strategy: "renewed", probability: 0.7, query: sneaky }), { onExit: vi.fn() });
      const line = root.querySelector('[data-role="idea"]');
      expect(line?.textContent).toBe("Idea: a renewed or used one could do the same job for less. See renewed options");
      const link = line?.querySelector("a");
      expect(link?.getAttribute("target")).toBe("_blank");
      expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
      expect(root.querySelector("img")).toBeNull();
      shown?.destroy();
    }
  });

  it("lets Tab reach the link inside the dialog", () => {
    vi.useFakeTimers();
    const root = mount();
    const shown = renderOverlay(root, withIdea("L3", { strategy: "renewed", probability: 0.7, query: "Laptop" }), { onExit: vi.fn() });
    const dialog = root.querySelector<HTMLElement>(".auxo-dialog");
    const link = root.querySelector<HTMLAnchorElement>('[data-role="idea"] a');
    link?.focus();
    expect(root.activeElement).toBe(link);
    // From the link, Tab moves on to an enabled button instead of leaving the dialog.
    dialog?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, composed: true, cancelable: true }));
    expect((root.activeElement as HTMLElement | null)?.tagName).toBe("BUTTON");
    shown?.destroy();
    vi.useRealTimers();
  });

  it("adds no idea line without a suggestion", () => {
    const root = mount();
    const shown = renderOverlay(root, withIdea("L2", undefined), { onExit: vi.fn() });
    expect(root.querySelector('[data-role="idea"]')).toBeNull();
    shown?.destroy();
  });
});
