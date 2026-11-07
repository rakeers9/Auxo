import type { Budget, Rule } from "@auxo/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SettingsRequest, SettingsResult } from "./client";
import { renderSettings } from "./view";

const NOW = new Date(2026, 10, 6, 12);

function rule(id: string, overrides: Partial<Rule> = {}): Rule {
  return {
    id,
    name: "No clothes",
    rule_type: "description",
    configuration: { description: "I don't want to buy clothes", lane: "L2" },
    enabled: true,
    created_at: "2026-11-06T12:00:00.000Z",
    updated_at: "2026-11-06T12:00:00.000Z",
    ...overrides,
  };
}

const BUDGET: Budget = {
  id: "22222222-2222-4222-8222-222222222222",
  currency: "USD",
  limit_minor: 30_000,
  spent_minor: 5_000,
  period_start: "2026-11-01",
  period_end: "2026-11-30",
  created_at: "2026-11-06T12:00:00.000Z",
  updated_at: "2026-11-06T12:00:00.000Z",
};

// A worker that answers every request with the current lists.
function fakeTransport(rules: Rule[] = [], budgets: Budget[] = []) {
  const state = { rules, budgets };
  const send = vi.fn(async (request: SettingsRequest): Promise<SettingsResult> => {
    void request;
    return { ok: true, rules: state.rules, budgets: state.budgets };
  });
  return { state, send };
}

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
});
afterEach(() => root.remove());

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const form = (name: string) => root.querySelector<HTMLFormElement>(`form[data-form="${name}"]`)!;
const status = () => root.querySelector('[data-role="status"]')?.textContent ?? "";
const items = (list: string) => [...root.querySelectorAll<HTMLElement>(`[data-list="${list}"] > li`)];

function fill(target: HTMLFormElement, name: string, value: string) {
  const field = target.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[name="${name}"]`)!;
  field.value = value;
}

function submitForm(target: HTMLFormElement) {
  target.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

describe("renderSettings", () => {
  it("loads and shows the user's rules and budgets", async () => {
    const transport = fakeTransport([rule("11111111-1111-4111-8111-111111111111")], [BUDGET]);
    renderSettings(root, transport, { now: () => NOW });
    await flush();

    expect(transport.send).toHaveBeenCalledWith({ op: "list" });
    const [shown] = items("rules");
    expect(shown?.textContent).toContain("“I don't want to buy clothes”");
    expect(shown?.querySelector<HTMLSelectElement>("select")?.value).toBe("L2");
    expect(items("budgets")[0]?.textContent).toContain("$50.00 of $300.00 spent");
    expect(status()).toBe("");
  });

  it("says when there are no rules", async () => {
    renderSettings(root, fakeTransport(), { now: () => NOW });
    await flush();
    expect(items("rules")[0]?.textContent).toBe("No rules yet. Add one above.");
  });

  it("adds a free-text rule, leaving the lane to Auxo by default, and clears the box", async () => {
    const transport = fakeTransport();
    renderSettings(root, transport, { now: () => NOW });
    await flush();

    fill(form("description"), "description", "I don't want to buy clothes");
    submitForm(form("description"));
    await flush();

    expect(transport.send).toHaveBeenLastCalledWith({
      op: "create-rule",
      rule: {
        name: "I don't want to buy clothes",
        rule_type: "description",
        configuration: { description: "I don't want to buy clothes" },
        enabled: true,
      },
    });
    expect(form("description").querySelector("textarea")?.value).toBe("");
    expect(status()).toBe("Added.");
  });

  it("adds a free-text rule with the lane the user picked, L0 included", async () => {
    const transport = fakeTransport();
    renderSettings(root, transport, { now: () => NOW });
    await flush();

    fill(form("description"), "description", "Groceries are fine");
    fill(form("description"), "lane", "L0");
    submitForm(form("description"));
    await flush();

    expect(transport.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ rule: expect.objectContaining({ configuration: { description: "Groceries are fine", lane: "L0" } }) }),
    );
  });

  it("doesn't send an empty rule", async () => {
    const transport = fakeTransport();
    renderSettings(root, transport, { now: () => NOW });
    await flush();

    submitForm(form("description"));
    await flush();

    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(status()).toBe("Write what you want to cut back on first.");
  });

  it("changes a rule's lane, turns it off, and deletes it", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const transport = fakeTransport([rule(id)]);
    renderSettings(root, transport, { now: () => NOW });
    await flush();

    const lane = items("rules")[0]!.querySelector<HTMLSelectElement>("select")!;
    lane.value = "auto";
    lane.dispatchEvent(new Event("change"));
    await flush();
    expect(transport.send).toHaveBeenLastCalledWith({
      op: "update-rule",
      id,
      update: { configuration: { description: "I don't want to buy clothes" } },
    });

    const toggle = items("rules")[0]!.querySelector<HTMLInputElement>('[data-action="toggle"]')!;
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await flush();
    expect(transport.send).toHaveBeenLastCalledWith({ op: "update-rule", id, update: { enabled: false } });

    items("rules")[0]!.querySelector<HTMLButtonElement>('[data-action="delete"]')!.click();
    await flush();
    expect(transport.send).toHaveBeenLastCalledWith({ op: "delete-rule", id });
  });

  it("offers Auxo's choice only for free-text rules", async () => {
    const transport = fakeTransport([
      rule("11111111-1111-4111-8111-111111111111"),
      rule("33333333-3333-4333-8333-333333333333", { rule_type: "cart_total", configuration: { threshold_minor: 10_000, lane: "L3" } }),
    ]);
    renderSettings(root, transport, { now: () => NOW });
    await flush();

    const [description, total] = items("rules").map((item) => [...item.querySelectorAll("option")].map((option) => option.value));
    expect(description).toEqual(["auto", "L0", "L1", "L2", "L3", "L4"]);
    expect(total).toEqual(["L0", "L1", "L2", "L3", "L4"]);
  });

  it("adds a spending limit for this month by default", async () => {
    const transport = fakeTransport();
    renderSettings(root, transport, { now: () => NOW });
    await flush();

    fill(form("budget"), "amount", "300");
    submitForm(form("budget"));
    await flush();

    expect(transport.send).toHaveBeenLastCalledWith({
      op: "create-budget",
      budget: { currency: "USD", limit_minor: 30_000, period_start: "2026-11-01", period_end: "2026-11-30" },
    });
  });

  it("adds cart total and store rules", async () => {
    const transport = fakeTransport();
    renderSettings(root, transport, { now: () => NOW });
    await flush();

    fill(form("cart-total"), "total", "100");
    fill(form("cart-total"), "lane", "L3");
    submitForm(form("cart-total"));
    await flush();
    expect(transport.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ rule: expect.objectContaining({ rule_type: "cart_total", configuration: { threshold_minor: 10_000, lane: "L3" } }) }),
    );

    fill(form("store"), "store", "amazon.com");
    submitForm(form("store"));
    await flush();
    expect(transport.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ rule: expect.objectContaining({ rule_type: "merchant", configuration: { merchants: ["amazon.com"], lane: "L1" } }) }),
    );
  });

  it("asks the user to sign in when signed out, and keeps what they typed on a failed save", async () => {
    const send = vi.fn(async (): Promise<SettingsResult> => ({ ok: false, reason: "signed_out" }));
    renderSettings(root, { send }, { now: () => NOW });
    await flush();
    expect(status()).toBe("Sign in above to see and change your settings.");

    fill(form("description"), "description", "No clothes");
    submitForm(form("description"));
    await flush();
    expect(form("description").querySelector("textarea")?.value).toBe("No clothes");
  });

  it("shows the API's message, and a fallback when the worker can't be reached", async () => {
    const send = vi
      .fn<(request: SettingsRequest) => Promise<SettingsResult>>()
      .mockResolvedValueOnce({ ok: false, reason: "http", message: "The rule request is invalid." })
      .mockRejectedValueOnce(new Error("Receiving end does not exist."));
    const view = renderSettings(root, { send }, { now: () => NOW });
    await flush();
    expect(status()).toBe("The rule request is invalid.");

    await view.refresh();
    expect(status()).toBe("Couldn't reach Auxo. Check your connection and try again.");
  });

  it("disables the controls while saving", async () => {
    let answer: (result: SettingsResult) => void = () => {};
    const send = vi.fn(() => new Promise<SettingsResult>((resolve) => { answer = resolve; }));
    renderSettings(root, { send }, { now: () => NOW });

    expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    answer({ ok: true, rules: [], budgets: [] });
    await flush();
    expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  });

  it("shows a rule's words as text, never markup", async () => {
    const sneaky = "<img src=x onerror=alert(1)>";
    renderSettings(root, fakeTransport([rule("11111111-1111-4111-8111-111111111111", { configuration: { description: sneaky } })]), {
      now: () => NOW,
    });
    await flush();

    expect(root.querySelector("img")).toBeNull();
    expect(items("rules")[0]?.textContent).toContain(sneaky);
  });
});
