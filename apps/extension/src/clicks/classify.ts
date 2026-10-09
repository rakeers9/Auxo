import type { ClickSignal } from "../messages";
import { EDIT_INTENTS, guessFromAction, guessIntent, isExcluded } from "./guess";
import { isIgnored, matchKnown, quantityFieldsFor, type ButtonOverrides, type ClickIntent, type Platform } from "./known";

// How far up from the click target to look for the control. Clicks usually
// land on an inner span or img a few levels down.
export const MAX_DEPTH = 8;

export const MAX_LABEL_LENGTH = 200;

// Classifies a click. Known store buttons win over generic guesses. `buttons`
// (store config for this host) overrides the bundled known selectors per
// intent; `platform` adds that platform's standard buttons on any host.
// Pure: reads the DOM, changes nothing.
export function classifyClick(
  target: EventTarget | null,
  url: URL,
  buttons?: ButtonOverrides,
  platform?: Platform,
): ClickSignal | null {
  const start = toElement(target);
  if (!start) return null;

  const known = matchKnown(start, url, buttons, platform);
  if (known) return signal(known.intent, "known", labelOf(known.element));
  if (isIgnored(start, url)) return null;

  const control = findControl(start);
  return control ? guessFromLabels(control) : null;
}

// Classifies a form submit. The submitter is checked like a click; failing
// that, the form action (or the submitter's formaction) is used.
export function classifySubmit(
  form: HTMLFormElement,
  submitter: Element | null,
  url: URL,
  buttons?: ButtonOverrides,
  platform?: Platform,
): ClickSignal | null {
  if (submitter) {
    const known = matchKnown(submitter, url, buttons, platform);
    if (known) return signal(known.intent, "known", labelOf(known.element));
    if (isIgnored(submitter, url)) return null;
    const guessed = guessFromLabels(submitter);
    if (guessed) return guessed;
    // A look-alike submitter also rules out guessing from the form action.
    if (labelsOf(submitter).some(isExcluded)) return null;
  }

  const action = submitter?.getAttribute("formaction") ?? form.getAttribute("action");
  if (!action) return null;
  let pathname: string;
  try {
    pathname = new URL(action, url).pathname;
  } catch {
    return null;
  }
  const intent = guessFromAction(pathname);
  return intent ? signal(intent, "guess", submitter ? labelOf(submitter) : "") : null;
}

// Classifies a `change` on a known cart quantity field (a <select> or a number
// input): up is increase_qty, down is decrease_qty, 0 or a delete option is
// remove_item. Anything else, including unknown fields, is null.
// `_buttons` keeps the call shape the same as classifyClick; store config has
// no key for quantity fields yet, so it isn't used.
export function classifyChange(
  target: EventTarget | null,
  url: URL,
  _buttons?: ButtonOverrides,
  platform?: Platform,
): ClickSignal | null {
  const field = toElement(target);
  if (!field || (field.tagName !== "SELECT" && field.tagName !== "INPUT")) return null;
  const known = quantityFieldsFor(url.hostname, platform).some((selector) => {
    try {
      return field.matches(selector);
    } catch {
      return false;
    }
  });
  if (!known) return null;
  const intent = quantityChangeIntent(field);
  return intent ? signal(intent, "known", labelOf(field)) : null;
}

// Which way a quantity field moved, from its original value (the option
// marked selected in the HTML, or the input's value attribute) to its current
// one. Exported for tests.
export function quantityChangeIntent(field: Element): "increase_qty" | "decrease_qty" | "remove_item" | null {
  let before: number;
  let after: number;
  if (field.tagName === "SELECT") {
    const select = field as HTMLSelectElement;
    const options = [...select.options];
    // The `selected` attribute is what defaultSelected reflects; reading it
    // directly also works where defaultSelected isn't implemented (happy-dom).
    const original = options.find((option) => option.hasAttribute("selected")) ?? options[0];
    const chosen = options[select.selectedIndex];
    if (!original || !chosen) return null;
    if (/\b(delete|remove)\b/i.test(chosen.text)) return "remove_item";
    before = parseQuantity(original.value);
    after = parseQuantity(chosen.value);
  } else if (field.tagName === "INPUT") {
    const input = field as HTMLInputElement;
    // Amazon also keeps the old value on the stepper's wrapper.
    const original = input.defaultValue || (input.closest("[data-old-value]")?.getAttribute("data-old-value") ?? "");
    before = parseQuantity(original);
    after = parseQuantity(input.value);
  } else {
    return null;
  }
  if (after === 0) return "remove_item";
  if (Number.isNaN(before) || Number.isNaN(after) || after === before) return null;
  return after > before ? "increase_qty" : "decrease_qty";
}

// Leading digits of a quantity value ("3", "10+"); NaN when there are none.
function parseQuantity(value: string): number {
  const match = /^\s*(\d+)/.exec(value);
  return match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
}

// The nearest actionable control at or above `start`, within MAX_DEPTH.
function findControl(start: Element): Element | null {
  let node: Element | null = start;
  for (let depth = 0; node && depth <= MAX_DEPTH; depth++) {
    if (isActionable(node)) return node;
    node = node.parentElement;
  }
  return null;
}

function isActionable(el: Element): boolean {
  if (el.matches('button, a, [role="button"]')) return true;
  if (el.tagName === "INPUT") {
    const type = (el as HTMLInputElement).type;
    return type === "submit" || type === "button" || type === "image";
  }
  return false;
}

// A look-alike label (wishlist, remove, ...) rules out every buy intent, but
// not the cart edits: "Remove" is never add_to_cart, and is remove_item.
function guessFromLabels(control: Element): ClickSignal | null {
  const labels = labelsOf(control);
  const excluded = labels.some(isExcluded);
  for (const label of labels) {
    const intent = guessIntent(label);
    if (intent && (!excluded || EDIT_INTENTS.has(intent))) return signal(intent, "guess", label);
  }
  return null;
}

// Every human-readable name a control has: visible text, aria-label, value,
// alt, and title. Whitespace is collapsed; empties are dropped.
function labelsOf(el: Element): string[] {
  const values = [
    el.tagName === "INPUT" ? "" : (el.textContent ?? ""),
    el.getAttribute("aria-label") ?? "",
    el.tagName === "INPUT" ? (el as HTMLInputElement).value : "",
    el.getAttribute("alt") ?? "",
    el.getAttribute("title") ?? "",
  ];
  return values.map((v) => v.replace(/\s+/g, " ").trim()).filter((v) => v.length > 0);
}

// The best single label for a control. A wrapper with no text of its own
// borrows its inner input's or button's label.
function labelOf(el: Element): string {
  const own = labelsOf(el)[0];
  if (own) return own;
  const inner = el.querySelector("input, button");
  return inner ? (labelsOf(inner)[0] ?? "") : "";
}

function signal(intent: ClickIntent, source: ClickSignal["source"], label: string): ClickSignal {
  const clipped = label.trim().slice(0, MAX_LABEL_LENGTH).trim();
  return clipped ? { intent, source, label: clipped } : { intent, source };
}

// Click targets are usually elements, but a text node can be one too.
function toElement(target: EventTarget | null): Element | null {
  if (!target || typeof (target as Node).nodeType !== "number") return null;
  const node = target as Node;
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}
