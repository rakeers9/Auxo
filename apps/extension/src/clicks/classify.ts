import type { ClickSignal } from "../messages";
import { guessFromAction, guessIntent, isExcluded } from "./guess";
import { matchKnown, type ButtonOverrides, type ClickIntent } from "./known";

// How far up from the click target to look for the control. Clicks usually
// land on an inner span or img a few levels down.
export const MAX_DEPTH = 8;

export const MAX_LABEL_LENGTH = 200;

// Classifies a click. Known store buttons win over generic guesses. `buttons`
// (store config for this host) overrides the bundled known selectors per
// intent. Pure: reads the DOM, changes nothing.
export function classifyClick(target: EventTarget | null, url: URL, buttons?: ButtonOverrides): ClickSignal | null {
  const start = toElement(target);
  if (!start) return null;

  const known = matchKnown(start, url, buttons);
  if (known) return signal(known.intent, "known", labelOf(known.element));

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
): ClickSignal | null {
  if (submitter) {
    const known = matchKnown(submitter, url, buttons);
    if (known) return signal(known.intent, "known", labelOf(known.element));
    if (labelsOf(submitter).some(isExcluded)) return null;
    const guessed = guessFromLabels(submitter);
    if (guessed) return guessed;
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

function guessFromLabels(control: Element): ClickSignal | null {
  const labels = labelsOf(control);
  if (labels.some(isExcluded)) return null;
  for (const label of labels) {
    const intent = guessIntent(label);
    if (intent) return signal(intent, "guess", label);
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
