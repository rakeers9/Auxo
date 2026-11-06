import { RULE_DESCRIPTION_MAX_LENGTH, type Budget, type Lane, type Rule } from "@auxo/shared";

import { renderBudgetCalendar } from "./budget-calendar";
import type { SettingsRequest, SettingsResult } from "./client";
import {
  AUTO_LANE,
  AUTO_LANE_LABEL,
  LANE_LABELS,
  LANES,
  budgetFrom,
  budgetSummary,
  cartTotalRule,
  descriptionRule,
  isLane,
  laneOf,
  merchantRule,
  monthRange,
  ruleSummary,
  withLane,
  type LaneChoice,
} from "./form";

// How the page reaches the worker (browser.runtime.sendMessage in production).
export interface SettingsTransport {
  send(request: SettingsRequest): Promise<SettingsResult>;
}

export interface SettingsView {
  // Reload the rules and budgets (e.g. after signing in).
  refresh(): Promise<void>;
}

const FAILURE_TEXT: Record<Exclude<SettingsResult, { ok: true }>["reason"], string> = {
  signed_out: "Sign in above to see and change your settings.",
  invalid: "That didn't look right. Check what you typed.",
  http: "Auxo couldn't save that. Try again.",
  network: "Couldn't reach Auxo. Check your connection and try again.",
  invalid_response: "Auxo sent back something unexpected. Try again.",
};

// Renders the rules and budgets editor into `root` (AUX-50). Text goes in
// with textContent only, so a rule's own words can never become markup.
export function renderSettings(
  root: HTMLElement,
  transport: SettingsTransport,
  options: { now?: () => Date } = {},
): SettingsView {
  const now = options.now ?? (() => new Date());
  const doc = root.ownerDocument;
  let busy = false;

  const status = el(doc, "p", "auxo-status");
  status.setAttribute("role", "status");
  status.dataset.role = "status";

  // What the user is cutting back on, in their own words.
  const describe = section(doc, "What are you trying to cut back on?",
    "Describe it in your own words. Auxo checks each cart against it, so “clothes” also covers shirts, shoes and jackets.");
  const descriptionForm = el(doc, "form", "auxo-form") as HTMLFormElement;
  descriptionForm.dataset.form = "description";
  const description = doc.createElement("textarea");
  description.name = "description";
  description.maxLength = RULE_DESCRIPTION_MAX_LENGTH;
  description.rows = 2;
  description.placeholder = "e.g. I don't want to buy clothes";
  const descriptionLane = laneSelect(doc, true, AUTO_LANE);
  descriptionForm.append(
    labelled(doc, "In your words", description),
    labelled(doc, "When a cart matches", descriptionLane),
    submit(doc, "Add"),
  );
  describe.append(descriptionForm);

  // Everything the user has set up.
  const rulesSection = section(doc, "Your rules");
  const rulesList = el(doc, "ul", "auxo-list");
  rulesList.dataset.list = "rules";
  rulesSection.append(rulesList);

  const budgetSection = section(doc, "Spending limit",
    "Pick the days on the calendar. Turn on Repeat to start the same number of days again when they end, with spending back at $0. When a cart would take you past 75% of a limit, Auxo pauses it. Past 90% or over the limit, it blocks it for a while.");
  const budgetForm = el(doc, "form", "auxo-form auxo-budget-form") as HTMLFormElement;
  budgetForm.dataset.form = "budget";
  const range = monthRange(now());
  const amount = input(doc, "amount", "text", "e.g. 300");
  amount.inputMode = "decimal";
  const calendarSlot = el(doc, "div", "auxo-calendar-slot");
  const calendar = renderBudgetCalendar(calendarSlot, { start: range.start, end: range.end, now });
  budgetForm.append(labelled(doc, "Limit ($)", amount), calendarSlot, submit(doc, "Add limit"));
  const budgetsList = el(doc, "ul", "auxo-list");
  budgetsList.dataset.list = "budgets";
  budgetSection.append(budgetForm, budgetsList);

  const more = section(doc, "More rules");
  const totalForm = el(doc, "form", "auxo-form") as HTMLFormElement;
  totalForm.dataset.form = "cart-total";
  const total = input(doc, "total", "text", "e.g. 100");
  total.inputMode = "decimal";
  const totalLane = laneSelect(doc, false, "L2");
  totalForm.append(labelled(doc, "Any cart of ($) or more", total), labelled(doc, "Then", totalLane), submit(doc, "Add"));
  const storeForm = el(doc, "form", "auxo-form") as HTMLFormElement;
  storeForm.dataset.form = "store";
  const store = input(doc, "store", "text", "amazon.com");
  const storeLane = laneSelect(doc, false, "L1");
  storeForm.append(labelled(doc, "Any cart at", store), labelled(doc, "Then", storeLane), submit(doc, "Add"));
  more.append(totalForm, storeForm);

  root.replaceChildren(status, describe, rulesSection, budgetSection, more);

  const setBusy = (value: boolean) => {
    busy = value;
    for (const control of root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      "button, input, select, textarea",
    )) {
      control.disabled = value;
    }
  };

  // Sends one request, redraws on success, and reports a failure. Returns
  // whether it worked, so a form only clears on success.
  const run = async (request: SettingsRequest, done?: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    status.textContent = request.op === "list" ? "Loading…" : "Saving…";
    let result: SettingsResult;
    try {
      result = await transport.send(request);
    } catch {
      result = { ok: false, reason: "network" };
    }
    setBusy(false);
    if (!result.ok) {
      status.textContent = result.reason === "http" && result.message ? result.message : FAILURE_TEXT[result.reason];
      return false;
    }
    draw(result.rules, result.budgets);
    status.textContent = done ?? "";
    return true;
  };

  const draw = (rules: Rule[], budgets: Budget[]) => {
    rulesList.replaceChildren(
      ...(rules.length === 0 ? [el(doc, "li", "auxo-empty", "No rules yet. Add one above.")] : rules.map(drawRule)),
    );
    budgetsList.replaceChildren(...budgets.map(drawBudget));
  };

  const drawRule = (rule: Rule): HTMLElement => {
    const item = el(doc, "li", "auxo-item");
    item.dataset.id = rule.id;
    item.dataset.type = rule.rule_type;
    const summary = el(doc, "span", "auxo-summary", ruleSummary(rule));
    const lane = laneSelect(doc, rule.rule_type === "description", laneOf(rule));
    lane.setAttribute("aria-label", `When a cart matches ${ruleSummary(rule)}`);
    lane.addEventListener("change", () => {
      const configuration = withLane(rule, lane.value as LaneChoice);
      if (configuration) void run({ op: "update-rule", id: rule.id, update: { configuration } }, "Saved.");
    });
    const enabled = doc.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = rule.enabled;
    enabled.dataset.action = "toggle";
    enabled.addEventListener("change", () => {
      void run({ op: "update-rule", id: rule.id, update: { enabled: enabled.checked } }, enabled.checked ? "Turned on." : "Turned off.");
    });
    const remove = button(doc, "Delete", "delete");
    remove.setAttribute("aria-label", `Delete ${ruleSummary(rule)}`);
    remove.addEventListener("click", () => void run({ op: "delete-rule", id: rule.id }, "Deleted."));
    item.append(summary, lane, labelled(doc, "On", enabled), remove);
    return item;
  };

  const drawBudget = (budget: Budget): HTMLElement => {
    const item = el(doc, "li", "auxo-item");
    item.dataset.id = budget.id;
    const summary = budgetSummary(budget, now().getFullYear());
    // Turning Repeat off ends the limit after its current cycle.
    const repeats = doc.createElement("input");
    repeats.type = "checkbox";
    repeats.checked = budget.repeats;
    repeats.dataset.action = "repeat";
    repeats.addEventListener("change", () => {
      void run(
        { op: "update-budget", id: budget.id, update: { repeats: repeats.checked } },
        repeats.checked ? "This limit now repeats." : "This limit ends after the current cycle.",
      );
    });
    const remove = button(doc, "Delete", "delete");
    remove.setAttribute("aria-label", `Delete the limit ${summary}`);
    remove.addEventListener("click", () => void run({ op: "delete-budget", id: budget.id }, "Deleted."));
    item.append(el(doc, "span", "auxo-summary", summary), labelled(doc, "Repeat", repeats), remove);
    return item;
  };

  const onSubmit = (form: HTMLFormElement, build: () => SettingsRequest | string, reset: () => void) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const request = build();
      if (typeof request === "string") {
        status.textContent = request;
        return;
      }
      void run(request, "Added.").then((ok) => {
        if (ok) reset();
      });
    });
  };

  onSubmit(descriptionForm, () => {
    const rule = descriptionRule(description.value, descriptionLane.value as LaneChoice);
    return rule ? { op: "create-rule", rule } : "Write what you want to cut back on first.";
  }, () => {
    description.value = "";
  });
  onSubmit(budgetForm, () => {
    const picked = calendar.value();
    if (picked.start === "" || picked.end === null) return "Pick the first and last day on the calendar.";
    const budget = budgetFrom(amount.value, picked.start, picked.end, picked.repeats);
    return budget ? { op: "create-budget", budget } : "Enter a limit in dollars, like 300.";
  }, () => {
    amount.value = "";
    calendar.reset();
  });
  onSubmit(totalForm, () => {
    const rule = isLane(totalLane.value) ? cartTotalRule(total.value, totalLane.value) : null;
    return rule ? { op: "create-rule", rule } : "Enter an amount in dollars, like 100.";
  }, () => {
    total.value = "";
  });
  onSubmit(storeForm, () => {
    const rule = isLane(storeLane.value) ? merchantRule(store.value, storeLane.value) : null;
    return rule ? { op: "create-rule", rule } : "Enter a store's web address, like amazon.com.";
  }, () => {
    store.value = "";
  });
  const view: SettingsView = { refresh: async () => void (await run({ op: "list" })) };
  void view.refresh();
  return view;
}

function laneSelect(doc: Document, allowAuto: boolean, selected: LaneChoice): HTMLSelectElement {
  const select = doc.createElement("select");
  select.name = "lane";
  const choices: Array<[LaneChoice, string]> = [
    ...(allowAuto ? [[AUTO_LANE, AUTO_LANE_LABEL] as [LaneChoice, string]] : []),
    ...LANES.map((lane: Lane): [LaneChoice, string] => [lane, LANE_LABELS[lane]]),
  ];
  for (const [value, label] of choices) {
    const option = doc.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  select.value = selected === AUTO_LANE && !allowAuto ? "L1" : selected;
  return select;
}

function section(doc: Document, title: string, hint?: string): HTMLElement {
  const wrapper = el(doc, "section", "auxo-section");
  wrapper.append(el(doc, "h2", "auxo-heading", title));
  if (hint) wrapper.append(el(doc, "p", "auxo-hint", hint));
  return wrapper;
}

function labelled(doc: Document, text: string, control: HTMLElement): HTMLLabelElement {
  const label = doc.createElement("label");
  label.className = "auxo-field";
  label.append(el(doc, "span", "auxo-label", text), control);
  return label;
}

function input(doc: Document, name: string, type: string, placeholder?: string): HTMLInputElement {
  const field = doc.createElement("input");
  field.name = name;
  field.type = type;
  if (placeholder) field.placeholder = placeholder;
  return field;
}

function submit(doc: Document, text: string): HTMLButtonElement {
  const control = button(doc, text, "submit");
  control.type = "submit";
  return control;
}

function button(doc: Document, text: string, action: string): HTMLButtonElement {
  const control = doc.createElement("button");
  control.type = "button";
  control.textContent = text;
  control.dataset.action = action;
  return control;
}

function el(doc: Document, tag: string, className?: string, text?: string): HTMLElement {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
