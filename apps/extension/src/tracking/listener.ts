import type { ClickSignal } from "../messages";

export interface BuyIntentClassifiers {
  classifyClick(target: EventTarget | null, url: URL): ClickSignal | null;
  classifySubmit(form: HTMLFormElement, submitter: Element | null, url: URL): ClickSignal | null;
}

// Clicking a submit button fires both a click and a submit; the same intent
// within this window is one action.
export const DUPLICATE_WINDOW_MS = 1_000;

// Hears clicks and form submits before the page does (capture phase) and
// reports buy-intent ones. It never blocks or changes the event, so the
// site's own behavior is untouched. Returns a function that stops listening.
export function listenForBuyIntents(
  doc: Document,
  classifiers: BuyIntentClassifiers,
  onSignal: (signal: ClickSignal) => void,
  getUrl: () => URL = () => new URL(doc.location.href),
  now: () => number = () => Date.now(),
): () => void {
  let last: { intent: ClickSignal["intent"]; at: number } | null = null;

  const report = (signal: ClickSignal | null) => {
    if (!signal) return;
    const at = now();
    if (last && last.intent === signal.intent && at - last.at < DUPLICATE_WINDOW_MS) return;
    last = { intent: signal.intent, at };
    try {
      onSignal(signal);
    } catch {
      // Tracking must never break the page.
    }
  };

  const onClick = (event: Event) => {
    try {
      report(classifiers.classifyClick(event.target, getUrl()));
    } catch {
      // A classifier bug must never break the click.
    }
  };
  const onSubmit = (event: Event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const submitter = (event as SubmitEvent).submitter ?? null;
    try {
      report(classifiers.classifySubmit(form, submitter, getUrl()));
    } catch {
      // Same as above.
    }
  };

  doc.addEventListener("click", onClick, { capture: true });
  doc.addEventListener("submit", onSubmit, { capture: true });
  return () => {
    doc.removeEventListener("click", onClick, { capture: true });
    doc.removeEventListener("submit", onSubmit, { capture: true });
  };
}
