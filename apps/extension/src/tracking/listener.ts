import type { ClickSignal } from "../messages";

export interface BuyIntentClassifiers {
  classifyClick(target: EventTarget | null, url: URL): ClickSignal | null;
  classifySubmit(form: HTMLFormElement, submitter: Element | null, url: URL): ClickSignal | null;
  // Quantity dropdowns change without a click.
  classifyChange?(target: EventTarget | null, url: URL): ClickSignal | null;
}

// Clicking a submit button fires both a click and the submit it causes; the
// same intent from those two within this window is one action. Two clicks are
// never merged (fast repeated + taps all count).
export const DUPLICATE_WINDOW_MS = 1_000;

export interface BlockOptions {
  // Return true to stop this click (see src/tracking/gate.ts). Runs while the
  // event is still in flight, so it must be synchronous.
  shouldBlock(signal: ClickSignal): boolean;
  onBlocked(signal: ClickSignal): void;
}

// Hears clicks and form submits before the page does (capture phase) and
// reports buy-intent ones. It only ever changes an event when `block` says
// to: then that one event is stopped (never replayed) and reported to
// onBlocked instead of onSignal. Returns a function that stops listening.
export function listenForBuyIntents(
  doc: Document,
  classifiers: BuyIntentClassifiers,
  onSignal: (signal: ClickSignal) => void,
  getUrl: () => URL = () => new URL(doc.location.href),
  now: () => number = () => Date.now(),
  block?: BlockOptions,
): () => void {
  let last: { intent: ClickSignal["intent"]; at: number; kind: string } | null = null;

  // Stops the event if the gate says so. A gate error never blocks.
  const blocked = (signal: ClickSignal, event: Event): boolean => {
    let stop = false;
    try {
      stop = block?.shouldBlock(signal) ?? false;
    } catch {
      stop = false;
    }
    if (!stop) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      block?.onBlocked(signal);
    } catch {
      // Tracking must never break the page.
    }
    return true;
  };

  const report = (signal: ClickSignal | null, event: Event) => {
    if (!signal) return;
    if (blocked(signal, event)) return;
    const at = now();
    const kind = event.type;
    const causedByLast =
      last !== null && last.kind === "click" && kind === "submit" && last.intent === signal.intent && at - last.at < DUPLICATE_WINDOW_MS;
    last = { intent: signal.intent, at, kind };
    if (causedByLast) return;
    try {
      onSignal(signal);
    } catch {
      // Tracking must never break the page.
    }
  };

  const onClick = (event: Event) => {
    try {
      report(classifiers.classifyClick(event.target, getUrl()), event);
    } catch {
      // A classifier bug must never break the click.
    }
  };
  const onSubmit = (event: Event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const submitter = (event as SubmitEvent).submitter ?? null;
    try {
      report(classifiers.classifySubmit(form, submitter, getUrl()), event);
    } catch {
      // Same as above.
    }
  };

  const onChange = (event: Event) => {
    if (!classifiers.classifyChange) return;
    try {
      report(classifiers.classifyChange(event.target, getUrl()), event);
    } catch {
      // Same as above.
    }
  };

  doc.addEventListener("click", onClick, { capture: true });
  doc.addEventListener("submit", onSubmit, { capture: true });
  doc.addEventListener("change", onChange, { capture: true });
  return () => {
    doc.removeEventListener("click", onClick, { capture: true });
    doc.removeEventListener("submit", onSubmit, { capture: true });
    doc.removeEventListener("change", onChange, { capture: true });
  };
}
